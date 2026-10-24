import { Worker } from 'node:worker_threads';
import {
  MIME_OF_CONTAINER,
  SNIFF_HEAD_BYTES,
  sniffContainer,
} from './media-sniff';

/**
 * How long a recording is, read from the file's own container (AITOOLS-04).
 * The library is `music-metadata` (pure JavaScript, no ffmpeg on the Hub): it
 * reads MP3, WAV, MP4, M4A and QuickTime (as MP4), AAC (ADTS) and WebM. The
 * phone's own idea of a length is never used.
 *
 * A person's file must never be able to stop the Hub (round 2: a 278-byte
 * crafted file put the parser in an endless loop on the Hub's only thread).
 * So, in order:
 *   1. the file's first bytes must name one of the containers the tools take
 *      (`sniffContainer`); anything else is refused as unreadable before a
 *      parser sees it, and the declared type is never used;
 *   2. the one parser for that container is run in a worker thread with
 *      memory limits and a hard time limit, terminated on overrun, so even a
 *      file that passes the sniff cannot block the event loop; an overrun, a
 *      crash or an out-of-memory is "unreadable";
 *   3. how many files are read and parsed at once, how many wait and for how
 *      long, and one read per account, is `ReadGate`'s (`read-gate.ts`): a
 *      read takes its turn BEFORE the file is read into memory, so a file that
 *      waits holds nothing (round 3).
 */

/** The hard time limit of one reading, in milliseconds; the worker is terminated at it. */
export const MEDIA_READ_TIMEOUT_MS = 15_000;
/**
 * How much memory a reading may use beyond the file's own bytes (heap plus
 * external allocations). `resourceLimits` below is also set, but on the Node
 * measured here (22.22) a worker's `heap_size_limit` stayed at the default 8 GB
 * whatever it was given, so a watchdog on the main thread checks the worker's
 * memory every `WATCH_EVERY_MS` and terminates it over this.
 */
export const WORKER_EXTRA_MEMORY_BYTES = 384 * 1024 * 1024;
const WATCH_EVERY_MS = 100;
/** The worker's own heap limits (the file's bytes are outside the heap and are capped by `ai.input_max_bytes`). */
const WORKER_LIMITS = {
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
};

/**
 * What a recording's padding adds to its length, in seconds: a clip made as
 * "1:00" reads 60.06 s (the real 90 s file reads 90.064), and the Hub does not
 * charge a second minute for container padding. Anything over it rounds up.
 */
export const LENGTH_TOLERANCE_SECONDS = 0.5;

/**
 * The worker's whole program: parse the bytes with the one parser the sniff
 * named and answer the length (or null). It runs in its own thread, so the
 * library's path is passed in and nothing else of the Hub is reachable.
 */
export const PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { parseBuffer } = require(workerData.library);
    const hint = workerData.mime ? { mimeType: workerData.mime } : {};
    const meta = await parseBuffer(new Uint8Array(workerData.bytes), hint, {
      duration: true,
      skipCovers: true,
    });
    const s = meta.format.duration;
    parentPort.postMessage({
      seconds: typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : null,
    });
  } catch {
    parentPort.postMessage({ seconds: null });
  }
})();
`;

/**
 * Runs `source` in a worker thread with `bytes` and answers the number of
 * seconds it posts, or null on any failure, crash, out-of-memory or when
 * `timeoutMs` passes (then the worker is terminated, loop or not). Never
 * throws and never blocks the calling thread. The caller holds a turn of the
 * `ReadGate` (a spec that calls it directly needs none). Exported for the specs, which
 * run the real parser without the sniff to prove the limits hold.
 *
 * `transfer` hands the worker the caller's own memory (no copy): the caller's
 * bytes are gone afterwards. Without it, or when the bytes are a slice of a
 * larger buffer, they are copied.
 */
export async function parseInWorker(
  bytes: Uint8Array,
  mime: string | undefined,
  opts: {
    source?: string;
    timeoutMs?: number;
    transfer?: boolean;
  } = {},
): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? MEDIA_READ_TIMEOUT_MS;
  return await new Promise<number | null>((resolve) => {
    let arrayBuffer: ArrayBuffer;
    const whole =
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength;
    if (opts.transfer && whole) arrayBuffer = bytes.buffer;
    else arrayBuffer = new Uint8Array(bytes).buffer;
    let worker: Worker;
    try {
      worker = new Worker(opts.source ?? PARSE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          library: require.resolve('music-metadata'),
          bytes: arrayBuffer,
          mime,
        },
        transferList: [arrayBuffer],
        resourceLimits: WORKER_LIMITS,
        env: {},
        stdout: true,
        stderr: true,
      });
    } catch {
      return resolve(null);
    }
    const fileBytes = arrayBuffer.byteLength;
    let settled = false;
    const end = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      void worker.terminate().catch(() => undefined);
      resolve(seconds);
    };
    const timer = setTimeout(() => end(null), timeoutMs);
    const watchdog = setInterval(() => {
      if (settled) return;
      worker
        .getHeapStatistics()
        .then((st) => {
          const used = st.used_heap_size + st.external_memory;
          if (used - fileBytes > WORKER_EXTRA_MEMORY_BYTES) end(null);
        })
        .catch(() => undefined);
    }, WATCH_EVERY_MS);
    worker.once('message', (m: unknown) => {
      const s = (m as { seconds?: unknown } | null)?.seconds;
      end(typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : null);
    });
    worker.once('error', () => end(null));
    worker.once('exit', () => end(null));
  });
}

/**
 * Returns the length in seconds, or null when the file's length cannot be
 * read (not one of the containers the tools take, damaged, a container that
 * holds no length such as a fragmented MP4 that reads 0 s, or a read that ran
 * over its time or memory limit). The declared type plays no part.
 */
export async function readSeconds(
  bytes: Uint8Array,
  opts: { timeoutMs?: number; transfer?: boolean } = {},
): Promise<number | null> {
  const container = sniffContainer(bytes.subarray(0, SNIFF_HEAD_BYTES));
  if (container === null) return null;
  return parseInWorker(bytes, MIME_OF_CONTAINER[container], opts);
}

/**
 * Minutes a length is priced in: rounded up, at least 1, with
 * `LENGTH_TOLERANCE_SECONDS` of container padding forgiven. A length that is
 * not a positive number is never priced (the caller refuses it as unreadable).
 */
export function minutesOf(seconds: number): number {
  return Math.max(1, Math.ceil((seconds - LENGTH_TOLERANCE_SECONDS) / 60));
}

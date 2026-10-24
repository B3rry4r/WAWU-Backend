import {
  adtsFile,
  craftedAsf,
  mp3File,
  mp4File,
  wavFile,
  webmFile,
  withId3,
} from '../../../test/ai-tools/media-fixtures';
import {
  LENGTH_TOLERANCE_SECONDS,
  WORKER_EXTRA_MEMORY_BYTES,
  minutesOf,
  parseInWorker,
  readSeconds,
} from '../input/media-length';
import { sniffContainer } from '../input/media-sniff';

/**
 * AITOOLS-04 round 2, HIGH 1: a person's file must never be able to stop the
 * Hub. Nothing here needs a database or a network: the files are built in
 * memory and the real parser (`music-metadata` 7.14.0) runs in its worker.
 */
describe('AITOOLS-04 r2: a file cannot stop the Hub (sniff, worker, limits)', () => {
  describe('the first bytes name the container, or the file is refused', () => {
    it('takes WAV, MP3 (frame or ID3), ADTS AAC, MP4/M4A/MOV and WebM', () => {
      expect(sniffContainer(wavFile(1))).toBe('wav');
      expect(sniffContainer(mp3File(1))).toBe('mp3');
      expect(sniffContainer(withId3(mp3File(1)))).toBe('mp3');
      expect(sniffContainer(adtsFile(1))).toBe('aac');
      expect(sniffContainer(mp4File({}))).toBe('mp4');
      expect(sniffContainer(mp4File({ brand: 'M4A ' }))).toBe('mp4');
      expect(sniffContainer(mp4File({ brand: 'qt  ' }))).toBe('mp4');
      expect(sniffContainer(webmFile(1))).toBe('webm');
    });

    it('refuses ASF, DSF, FLAC, Ogg, AVI, an image, text and nothing', () => {
      const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(64)]);
      expect(sniffContainer(craftedAsf())).toBeNull();
      expect(sniffContainer(pad(Buffer.from('DSD ')))).toBeNull();
      expect(sniffContainer(pad(Buffer.from('fLaC')))).toBeNull();
      expect(sniffContainer(pad(Buffer.from('OggS')))).toBeNull();
      // RIFF that is not WAVE (an AVI video)
      const avi = Buffer.alloc(64);
      avi.write('RIFF', 0, 'latin1');
      avi.write('AVI LIST', 8, 'latin1');
      expect(sniffContainer(avi)).toBeNull();
      expect(
        sniffContainer(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))),
      ).toBeNull();
      expect(sniffContainer(Buffer.from('not a recording at all'))).toBeNull();
      expect(sniffContainer(Buffer.alloc(0))).toBeNull();
      expect(sniffContainer(Buffer.alloc(5000))).toBeNull();
      // a frame sync with a reserved version / bitrate / sample rate
      expect(
        sniffContainer(pad(Buffer.from([0xff, 0xeb, 0x90, 0x00]))),
      ).toBeNull();
      expect(
        sniffContainer(pad(Buffer.from([0xff, 0xfb, 0xf0, 0x00]))),
      ).toBeNull();
      expect(
        sniffContainer(pad(Buffer.from([0xff, 0xfb, 0x9c, 0x00]))),
      ).toBeNull();
    });
  });

  describe("the verifier's crafted 278-byte ASF file, declared audio/mpeg", () => {
    it('is refused as unreadable before any parser or worker runs', async () => {
      const asf = craftedAsf();
      expect(asf.length).toBe(278);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const workerThreads = require('node:worker_threads') as {
        Worker: unknown;
      };
      const spy = jest.spyOn(workerThreads as { Worker: never }, 'Worker');
      const started = Date.now();
      try {
        expect(await readSeconds(asf)).toBeNull();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('hidden behind an ID3 tag is still read as MP3 or not at all, never as ASF', async () => {
      const hidden = withId3(craftedAsf());
      const started = Date.now();
      expect(await readSeconds(hidden)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('would loop the parser if it were let sniff the type: the worker is stopped at its time limit and the Hub keeps answering', async () => {
      // The old behaviour, on purpose: no type hint, so the parser sniffs the
      // bytes itself and walks into the ASF loop. This is the proof that the
      // worker (not the sniff) is what keeps the Hub alive when a file gets
      // through.
      let worst = 0;
      let last = Date.now();
      const ticker = setInterval(() => {
        const now = Date.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 25);
      const started = Date.now();
      let looped: number | null = -1;
      try {
        [looped] = await Promise.all([
          parseInWorker(craftedAsf(), undefined, { timeoutMs: 1500 }),
          parseInWorker(withId3(craftedAsf()), undefined, { timeoutMs: 1500 }),
        ]);
      } finally {
        clearInterval(ticker);
      }
      const took = Date.now() - started;
      expect(looped).toBeNull();
      // It really did run until the limit (a refusal would have been instant)...
      expect(took).toBeGreaterThanOrEqual(1400);
      expect(took).toBeLessThan(6000);
      // ...and the main thread was never blocked by it.
      expect(worst).toBeLessThan(400);
    }, 15000);
  });

  describe('a file that gets past the sniff cannot block or exhaust the Hub', () => {
    it('a read that never ends is stopped at the time limit and answers unreadable', async () => {
      const started = Date.now();
      const out = await parseInWorker(wavFile(1), 'audio/wav', {
        source: 'for (;;) {}',
        timeoutMs: 700,
      });
      expect(out).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(650);
      expect(Date.now() - started).toBeLessThan(4000);
    }, 15000);

    it('a read that eats memory is stopped by the memory watchdog and answers unreadable', async () => {
      const started = Date.now();
      const rssBefore = process.memoryUsage().rss;
      const out = await parseInWorker(wavFile(1), 'audio/wav', {
        source:
          'const a = []; for (;;) a.push({ n: a.length, s: "x".repeat(60) + a.length });',
        timeoutMs: 12000,
      });
      expect(out).toBeNull();
      // Stopped by the memory limit, well before the clock, and not far over it.
      expect(Date.now() - started).toBeLessThan(8000);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(
        WORKER_EXTRA_MEMORY_BYTES * 3,
      );
    }, 20000);

    it('a read that crashes its worker answers unreadable', async () => {
      expect(
        await parseInWorker(wavFile(1), 'audio/wav', {
          source: 'throw new Error("boom");',
          timeoutMs: 3000,
        }),
      ).toBeNull();
    });

    it('a length that is zero, negative or not a number is never priced', async () => {
      for (const body of [
        'require("node:worker_threads").parentPort.postMessage({seconds: 0})',
        'require("node:worker_threads").parentPort.postMessage({seconds: -5})',
        'require("node:worker_threads").parentPort.postMessage({seconds: "9"})',
        'require("node:worker_threads").parentPort.postMessage({seconds: NaN})',
        'require("node:worker_threads").parentPort.postMessage(null)',
      ])
        expect(
          await parseInWorker(wavFile(1), 'audio/wav', {
            source: body,
            timeoutMs: 3000,
          }),
        ).toBeNull();
    });

    it('hands the bytes over without copying only when asked, and never loses the caller their own file otherwise', async () => {
      const keep = wavFile(3);
      expect(await readSeconds(keep)).toBeCloseTo(3, 2);
      expect(keep.length).toBeGreaterThan(0); // copied: still the caller's
      const give = Buffer.from(new Uint8Array(wavFile(3)));
      expect(await readSeconds(give, { transfer: true })).toBeCloseTo(3, 2);
    });
  });

  describe('the containers the tools take are read from their bytes', () => {
    it('WAV, MP3, ADTS AAC, MP4 with AAC, M4A and WebM', async () => {
      expect(await readSeconds(wavFile(90))).toBeCloseTo(90, 1);
      expect(await readSeconds(mp3File(61))).toBeGreaterThan(60);
      expect(await readSeconds(adtsFile(90))).toBeCloseTo(90, 0);
      expect(await readSeconds(mp4File({ milliseconds: 90_000 }))).toBeCloseTo(
        90,
        1,
      );
      expect(
        await readSeconds(mp4File({ brand: 'M4A ', milliseconds: 45_000 })),
      ).toBeCloseTo(45, 1);
      expect(await readSeconds(webmFile(90))).toBeCloseTo(90, 1);
    });

    it('MEDIUM 4: a QuickTime .mov (brand "qt  ") is read as ISO BMFF, like MP4', async () => {
      expect(
        await readSeconds(mp4File({ brand: 'qt  ', milliseconds: 30_064 })),
      ).toBeCloseTo(30.064, 2);
    });

    it('LOW 5: a fragmented MP4 (length 0) is refused as unreadable, never priced as 0 minutes', async () => {
      expect(await readSeconds(mp4File({ fragmented: true }))).toBeNull();
    });

    it('LOW 6: a "1:00" recording whose container reads 60.064 s is one minute; over the tolerance rounds up', async () => {
      expect(LENGTH_TOLERANCE_SECONDS).toBe(0.5);
      const read = await readSeconds(mp4File({ milliseconds: 60_064 }));
      expect(read).toBeCloseTo(60.064, 2);
      expect(minutesOf(read!)).toBe(1);
      expect(minutesOf(90.064)).toBe(2);
      expect(minutesOf(60.5)).toBe(1);
      expect(minutesOf(60.51)).toBe(2);
      expect(minutesOf(0.2)).toBe(1);
    });
  });
});

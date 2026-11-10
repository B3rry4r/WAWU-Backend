import type { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { pipeline, type Readable } from 'node:stream';
import { patchStream } from './apply-patches';
import { cleanableKind, planClean } from './clean-video';
import type { VideoSource } from './types';

/**
 * VIDEO-PRIVACY (R-127): removes the location, device and time tags from a
 * stored video, in the bucket. The video is read by ranges to build the plan
 * (the box headers and `moov`, a few requests); when the plan changes
 * nothing, nothing is written. When it does, the object is streamed through
 * the patcher and put back at the same key with the same type and the same
 * length: never held in memory, never re-encoded, and a PUT that fails leaves
 * the original object whole (a bucket PUT commits only when its body ends).
 *
 * `cleanStoredVideo` never throws and never refuses a file. A file it cannot
 * read, or that is not what its name says, is left exactly as it is and logged
 * (the key and the reason, never a tag value).
 */
export interface CleanDeps {
  client: S3Client | null;
  bucket: string;
  logger: Pick<Logger, 'log' | 'warn'>;
  /** Whether the upload row for `key` is still wanted (not released, not removed). */
  stillWanted: (key: string) => Promise<boolean>;
  /** The one-off sweep's plan mode: read and plan, write nothing. */
  dryRun?: boolean;
}

/** Bigger than this is left as it is: the Hub never takes more than 512 MB. */
const MAX_CLEAN_BYTES = 1024 * 1024 * 1024;
/** A whole-object read and write of a large video; the client's own limit is for short calls. */
const STREAM_TIMEOUT_MS = 10 * 60_000;
const AT_ONCE = 2;
const REMEMBER = 5000;

const cleaned = new Set<string>();
const inFlight = new Map<string, Promise<CleanOutcome>>();
let running = 0;
const waiting: (() => void)[] = [];

export type CleanOutcome =
  | { result: 'cleaned'; removed: string[] }
  | { result: 'already-clean' }
  | { result: 'would-clean'; removed: string[]; bytes: number }
  | { result: 'not-video' }
  | { result: 'left'; why: string };

async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

export function forgetCleanedVideos(): void {
  cleaned.clear();
}

export function cleanStoredVideo(
  deps: CleanDeps,
  key: string,
): Promise<CleanOutcome> {
  if (!cleanableKind(key) || !deps.client)
    return Promise.resolve({ result: 'not-video' });
  if (cleaned.has(key)) return Promise.resolve({ result: 'already-clean' });
  const going = inFlight.get(key);
  if (going) return going;
  const p = turn(() => run(deps, key)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function run(deps: CleanDeps, key: string): Promise<CleanOutcome> {
  const { client, bucket, logger } = deps;
  const left = (why: string): CleanOutcome => {
    logger.warn(`Video privacy: left ${key} as it is: ${why}`);
    return { result: 'left', why };
  };
  try {
    const head = await client!.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const length = head.ContentLength ?? 0;
    if (length <= 0) return left('the file is empty');
    if (length > MAX_CLEAN_BYTES)
      return left('the file is larger than the cleaner reads');
    const source: VideoSource = {
      length,
      read: async (start, end) => {
        const to = Math.min(end, length);
        if (to <= start) return Buffer.alloc(0);
        const out = await client!.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: `bytes=${start}-${to - 1}`,
          }),
        );
        return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
      },
    };
    const plan = await planClean(key, source);
    if (!plan) return { result: 'not-video' };
    if (plan.patches.length === 0) {
      remember(key);
      return { result: 'already-clean' };
    }

    if (deps.dryRun) {
      return { result: 'would-clean', removed: plan.removed, bytes: length };
    }

    // Whole object through the patcher, back to the same key, same length and type.
    const got = await client!.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      {
        requestTimeout: STREAM_TIMEOUT_MS,
      },
    );
    const body = got.Body as Readable | undefined;
    if (!body || got.ContentLength !== length) {
      body?.destroy?.();
      return left('the file changed while it was read');
    }
    const patched = patchStream(plan.patches);
    pipeline(body, patched, () => undefined);
    await client!.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: patched,
        ContentType: head.ContentType,
        ContentLength: length,
      }),
      { requestTimeout: STREAM_TIMEOUT_MS },
    );

    // A release that ran while the file was rewritten must not leave the file behind.
    if (!(await deps.stillWanted(key))) {
      await client!
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => undefined);
    }
    remember(key);
    logger.log(
      `Video privacy: cleaned ${key}: ${plan.removed.join(', ') || 'times zeroed'}`,
    );
    return { result: 'cleaned', removed: plan.removed };
  } catch (err) {
    return left(err instanceof Error ? err.message : String(err));
  }
}

function remember(key: string): void {
  if (cleaned.size >= REMEMBER) cleaned.clear();
  cleaned.add(key);
}

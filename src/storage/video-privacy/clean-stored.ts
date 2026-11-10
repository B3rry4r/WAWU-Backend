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
import { Unreadable, type VideoSource } from './types';

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
  /**
   * A caller that is answering a person (the confirm) waits for a file only up to this size;
   * a larger one is cleaned right after, in the background, and by the sweep.
   */
  inlineMaxBytes?: number;
}

/** Bigger than this is left as it is: the Hub never takes more than 512 MB. */
const MAX_CLEAN_BYTES = 1024 * 1024 * 1024;
/** A whole-object read and write of a large video; the client's own limit is for short calls. */
const STREAM_TIMEOUT_MS = 10 * 60_000;
const AT_ONCE = 2;
const REMEMBER = 5000;
/** A file that cannot be read is tried once (it will not change); a failed read or write, this many times. */
export const MAX_TRIES = 3;
/** The confirm waits for a file up to this size; above it the clean runs right after. */
export const INLINE_MAX_BYTES = 100 * 1024 * 1024;

const cleaned = new Set<string>();
const failed = new Map<string, number>();
const inFlight = new Map<string, Promise<CleanOutcome>>();
let running = 0;
const waiting: (() => void)[] = [];

export type CleanOutcome =
  | { result: 'cleaned'; removed: string[] }
  | { result: 'already-clean' }
  | { result: 'would-clean'; removed: string[]; bytes: number }
  | { result: 'not-video' }
  | { result: 'deferred' }
  | { result: 'changed' }
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
  failed.clear();
}

export function cleanStoredVideo(
  deps: CleanDeps,
  key: string,
): Promise<CleanOutcome> {
  if (!cleanableKind(key) || !deps.client)
    return Promise.resolve({ result: 'not-video' });
  if (cleaned.has(key)) return Promise.resolve({ result: 'already-clean' });
  if ((failed.get(key) ?? 0) >= MAX_TRIES)
    return Promise.resolve({
      result: 'left',
      why: 'given up after earlier tries',
    });
  const going = inFlight.get(key);
  if (going) return going;
  const p = turn(() => run(deps, key)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const isPrecondition = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412
  );
};

async function run(deps: CleanDeps, key: string): Promise<CleanOutcome> {
  const { client, bucket, logger } = deps;
  const left = (why: string, tries = 1): CleanOutcome => {
    if (failed.size >= REMEMBER) failed.clear();
    failed.set(key, (failed.get(key) ?? 0) + tries);
    logger.warn(`Video privacy: left ${key} as it is: ${why}`);
    return { result: 'left', why };
  };
  const changed = (): CleanOutcome => {
    logger.warn(
      `Video privacy: ${key} changed while it was read; left for the next sweep`,
    );
    return { result: 'changed' };
  };
  try {
    const head = await client!.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const length = head.ContentLength ?? 0;
    const etag = head.ETag;
    if (length <= 0) return left('the file is empty', MAX_TRIES);
    if (length > MAX_CLEAN_BYTES)
      return left('the file is larger than the cleaner reads', MAX_TRIES);
    if (
      deps.inlineMaxBytes !== undefined &&
      length > deps.inlineMaxBytes &&
      !deps.dryRun
    ) {
      // Too big to make a person wait: clean it right after this call returns.
      setTimeout(() => {
        void cleanStoredVideo({ ...deps, inlineMaxBytes: undefined }, key);
      }, 100).unref();
      return { result: 'deferred' };
    }
    // Every read is of the version that was HEADed: a replacement answers 412 (If-Match).
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
            ...(etag ? { IfMatch: etag } : {}),
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
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(etag ? { IfMatch: etag } : {}),
      }),
      { requestTimeout: STREAM_TIMEOUT_MS },
    );
    const body = got.Body as Readable | undefined;
    if (
      !body ||
      got.ContentLength !== length ||
      (etag && got.ETag && got.ETag !== etag)
    ) {
      body?.destroy?.();
      return changed();
    }
    // Once more just before the write. What is left open is the time from here to the bucket
    // committing the PUT (the transfer): a replacement landing inside that window is overwritten.
    const again = await client!.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (again.ContentLength !== length || (etag && again.ETag !== etag)) {
      body.destroy?.();
      return changed();
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
    if (isPrecondition(err)) return changed();
    const unreadable = err instanceof Unreadable;
    return left(
      err instanceof Error ? err.message : String(err),
      unreadable ? MAX_TRIES : 1,
    );
  }
}

function remember(key: string): void {
  if (cleaned.size >= REMEMBER) cleaned.clear();
  cleaned.add(key);
}

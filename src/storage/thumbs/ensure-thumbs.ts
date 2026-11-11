import type { Logger } from '@nestjs/common';
import {
  makeThumbs,
  MAX_THUMB_SOURCE_BYTES,
  UnreadablePicture,
} from './make-thumbs';
import {
  THUMB_SIZES,
  thumbKey,
  thumbOwnerOf,
  thumbSourceOk,
} from './thumb-keys';

/**
 * HUB-THUMBS: makes and stores the two small copies of one public picture. Modelled on VIDEO-PRIVACY's
 * `cleanStoredVideo`: it NEVER throws and never refuses a file; a picture that cannot be read is left as it
 * is and logged (the key and the reason). It writes nothing itself: `deps.put` (supplied by StorageService,
 * the one file that writes objects to the bucket) stores a copy and records its row.
 */
export interface ThumbDeps {
  logger: Pick<Logger, 'log' | 'warn'>;
  /** Whether the bucket is configured at all. */
  enabled: boolean;
  /** The original's row, or null (no row: not ours to copy). */
  rowOf: (key: string) => Promise<{
    wawuUserId: string;
    status: string;
    releasedAt: Date | null;
    removingAt: Date | null;
  } | null>;
  /** The copy keys (of `keys`) that already have a confirmed row. */
  haveRows: (keys: string[]) => Promise<Set<string>>;
  /** Reads the original whole; throws a message with "too large" when it is over the cap. */
  read: (key: string, maxBytes: number) => Promise<Buffer>;
  /** Stores one copy and records it as a confirmed row of `owner`. */
  put: (put: { owner: string; key: string; body: Buffer }) => Promise<void>;
  /** Removes the copies again (the original was released while the work ran). */
  discard: (keys: string[]) => Promise<void>;
  /** A test's clock/limits. */
  workMs?: number;
}

export type ThumbOutcome = 'made' | 'have' | 'skipped' | 'busy' | 'left';

/** The most time the picture work may take (decode, resize, encode of both copies). */
export const THUMB_WORK_MS = 8_000;
/** One picture at a time in the whole process: the confirm only waits 2.5 s, the rest is background work. */
const AT_ONCE = 1;
/** More than this waiting: the work is skipped and the sweep picks the picture up later. */
const MAX_WAITING = 40;
const REMEMBER = 5000;
const RETRY_AFTER_MS = 30 * 60_000;
const UNREADABLE_RETRY_AFTER_MS = 6 * 60 * 60_000;

const done = new Set<string>();
const failed = new Map<string, number>();
const inFlight = new Map<string, Promise<ThumbOutcome>>();
let running = 0;
const waiting: (() => void)[] = [];

export function forgetThumbs(): void {
  done.clear();
  failed.clear();
}

class TimedOut extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const clock = new Promise<never>((_, no) => {
    timer = setTimeout(
      () => no(new TimedOut('the picture work took too long')),
      ms,
    );
    timer.unref();
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

export function ensureThumbsFor(
  deps: ThumbDeps,
  key: string,
): Promise<ThumbOutcome> {
  if (!deps.enabled || !thumbSourceOk(key)) return Promise.resolve('skipped');
  if (done.has(key)) return Promise.resolve('have');
  const until = failed.get(key);
  if (until !== undefined && Date.now() < until) return Promise.resolve('left');
  const going = inFlight.get(key);
  if (going) return going;
  if (running >= AT_ONCE && waiting.length >= MAX_WAITING)
    return Promise.resolve('busy');
  const p = (async () => {
    if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    running += 1;
    try {
      return await run(deps, key);
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  })()
    .catch((): ThumbOutcome => 'left')
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function remember(key: string): void {
  if (done.size >= REMEMBER) done.clear();
  done.add(key);
  failed.delete(key);
}

async function run(deps: ThumbDeps, key: string): Promise<ThumbOutcome> {
  const skip = (why: string, retryMs = RETRY_AFTER_MS): ThumbOutcome => {
    if (failed.size >= REMEMBER) failed.clear();
    failed.set(key, Date.now() + retryMs);
    deps.logger.warn(`Thumbnails: left ${key} as it is: ${why}`);
    return 'left';
  };
  try {
    const row = await deps.rowOf(key);
    const owner = thumbOwnerOf(key);
    if (
      !row ||
      !owner ||
      row.wawuUserId !== owner ||
      row.status === 'abandoned' ||
      row.releasedAt ||
      row.removingAt
    )
      return 'skipped';
    const keys = THUMB_SIZES.map((s) => thumbKey(key, s));
    const have = await deps.haveRows(keys);
    if (keys.every((k) => have.has(k))) {
      remember(key);
      return 'have';
    }
    const original = await deps.read(key, MAX_THUMB_SOURCE_BYTES);
    const copies = await within(
      makeThumbs(original),
      deps.workMs ?? THUMB_WORK_MS,
    );
    for (const size of THUMB_SIZES)
      await deps.put({ owner, key: thumbKey(key, size), body: copies[size] });
    // A release that ran while the copies were made must not leave them behind.
    const again = await deps.rowOf(key);
    if (!again || again.releasedAt || again.removingAt)
      await deps.discard(keys);
    remember(key);
    deps.logger.log(`Thumbnails: made ${keys.length} copies of ${key}`);
    return 'made';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof UnreadablePicture)
      return skip(message, UNREADABLE_RETRY_AFTER_MS);
    if (err instanceof TimedOut)
      return skip(message, UNREADABLE_RETRY_AFTER_MS);
    if (/too large|empty|longer than allowed/.test(message))
      return skip(message, UNREADABLE_RETRY_AFTER_MS);
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      e?.name === 'NoSuchKey' ||
      e?.name === 'NotFound' ||
      e?.$metadata?.httpStatusCode === 404
    )
      return 'left';
    return skip(message);
  }
}

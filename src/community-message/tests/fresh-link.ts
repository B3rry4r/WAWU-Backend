import { objectKeyFrom } from '../../storage/storage.service';

/**
 * FIX-84. Every path that returns a community message signs its photo, video
 * and voice-note links again (FIX-71), so a link a spec reads back is never the
 * string the sender stored: its X-Amz-Date and its signature are those of the
 * second the Hub answered in. A spec that compares a sent or stored link with a
 * returned one with `toBe`, `toEqual` or `toMatchObject` is red whenever the
 * two are signed in different seconds, which is some runs and not others.
 *
 * What a returned link must be is (1) a link to the same object the sender
 * stored, on the same bucket, with the same type and disposition, and (2) a
 * signed link that is valid now. `expectLinkSignedAgain` checks exactly that
 * and never compares the signature, the date or the credential's date.
 * `moveClockForward` makes every run meet the later-second case instead of one
 * run in two: call `restoreClock` in `afterEach`.
 */

/** The parameters of a signed link that belong to the second it was signed in. */
const SIGNED_IN_ITS_OWN_SECOND = [
  'X-Amz-Date',
  'X-Amz-Signature',
  'X-Amz-Credential',
];

/** The three fields of a message that hold a media link. */
export const MEDIA_LINK_FIELDS = ['imageUrl', 'videoUrl', 'voiceUrl'] as const;

/** Only `Date` is faked, so the signer's clock can be moved and nothing else changes. */
const LEFT_REAL = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

let clockIsFaked = false;

/**
 * Moves the clock `ms` forward (two seconds by default), so whatever is signed
 * next is signed in a later second than anything signed before this call. The
 * first call fakes `Date` (the clock keeps running from there). Call
 * `restoreClock` in `afterEach` so the next test has the real clock back.
 */
export function moveClockForward(ms = 2000): void {
  if (!clockIsFaked) {
    jest.useFakeTimers({
      doNotFake: [...LEFT_REAL],
      advanceTimers: true,
      now: Date.now(),
    });
    clockIsFaked = true;
  }
  jest.setSystemTime(Date.now() + ms);
}

/** Puts the real clock back. Safe to call when it was never moved. */
export function restoreClock(): void {
  jest.useRealTimers();
  clockIsFaked = false;
}

/** `20261018T045546Z` as a time in milliseconds. */
function signedAtOf(stamp: string): number {
  return Date.parse(
    stamp.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  );
}

/** The credential without its date: `<access key>/<region>/s3/aws4_request`. */
function credentialWithoutDate(url: URL): string {
  const parts = (url.searchParams.get('X-Amz-Credential') ?? '').split('/');
  expect(parts).toHaveLength(5);
  expect(parts[1]).toMatch(/^\d{8}$/);
  return [parts[0], ...parts.slice(2)].join('/');
}

/**
 * `listed` is a link a read returned for the file the sender stored as
 * `stored`. It must name the same object on the same bucket, carry every
 * parameter the stored link carries except those of the second it was signed
 * in, and be a signature made no later than now that has not run out.
 */
export function expectLinkSignedAgain(
  listed: string | null | undefined,
  stored: string,
): void {
  expect(typeof listed).toBe('string');
  const link = listed as string;

  // The same object. objectKeyFrom reads the key out of a link the way the Hub does.
  const key = objectKeyFrom(stored);
  expect(key).not.toMatch(/^https?:/);
  expect(objectKeyFrom(link)).toBe(key);

  // The same bucket, at the same path.
  const url = new URL(link);
  const was = new URL(stored);
  expect(`${url.origin}${url.pathname}`).toBe(`${was.origin}${was.pathname}`);

  // The same type and disposition, expiry and algorithm: every other parameter.
  const rest = (u: URL) =>
    [...u.searchParams.entries()]
      .filter(([name]) => !SIGNED_IN_ITS_OWN_SECOND.includes(name))
      .sort(([a], [b]) => a.localeCompare(b));
  expect(rest(url)).toEqual(rest(was));
  expect(credentialWithoutDate(url)).toBe(credentialWithoutDate(was));

  // Signed, signed no later than now, and not run out.
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  const expiresInMs = Number(url.searchParams.get('X-Amz-Expires')) * 1000;
  expect(expiresInMs).toBeGreaterThan(0);
  const stamp = url.searchParams.get('X-Amz-Date') ?? '';
  expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
  expect(url.searchParams.get('X-Amz-Credential')).toContain(
    `/${stamp.slice(0, 8)}/`,
  );
  const signedAt = signedAtOf(stamp);
  expect(signedAt).toBeLessThanOrEqual(Date.now());
  expect(signedAt + expiresInMs).toBeGreaterThan(Date.now());
}

interface MessageAnswer {
  body: unknown;
}

function dataOf(answer: MessageAnswer): Record<string, unknown> {
  const data = (answer.body as { data?: Record<string, unknown> | null }).data;
  expect(data).toBeTruthy();
  return data as Record<string, unknown>;
}

/** The answer with the three media links taken out, everything else as sent. */
function withoutLinks(answer: MessageAnswer): unknown {
  const body = answer.body as Record<string, unknown>;
  const data = { ...dataOf(answer) };
  for (const field of MEDIA_LINK_FIELDS) delete data[field];
  return { ...body, data };
}

/**
 * `later` is the Hub's answer to a repeat of the request that got `earlier`:
 * the same message, whatever second each was signed in. Every field is equal
 * but the three media links; those are the same objects, each signed and valid
 * now (`expectLinkSignedAgain`, both ways round), and a field that was null or
 * absent is still null or absent.
 */
export function expectSameAnswerSignedAgain(
  later: MessageAnswer,
  earlier: MessageAnswer,
): void {
  const a = dataOf(later);
  const b = dataOf(earlier);
  for (const field of MEDIA_LINK_FIELDS) {
    if (typeof b[field] === 'string') {
      expectLinkSignedAgain(a[field] as string, b[field]);
      expectLinkSignedAgain(b[field], a[field] as string);
    } else {
      expect(a[field]).toEqual(b[field]);
    }
  }
  expect(withoutLinks(later)).toEqual(withoutLinks(earlier));
}

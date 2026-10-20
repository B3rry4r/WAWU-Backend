import { randomInt } from 'node:crypto';

/**
 * SCHOOLS-10: the code on a school's apply link ("wawu-7KQ2", SC9) and the
 * link built from it. Pure functions, so the spec can pin them down.
 */

export const LINK_CODE_PREFIX = 'wawu-';
/** Capital letters and digits without 0, O, 1 and I, so it reads aloud and over the phone. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 4;
/** The query name the school's site reads the code from, as SC9 draws it. */
export const LINK_PARAM = 'ref';

/** A new random code. A taken one is caught by the unique key and tried again. */
export function newLinkCode(): string {
  let tail = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    tail += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  }
  return LINK_CODE_PREFIX + tail;
}

/** The address as a web address (http or https), or null when it is not one. */
function webAddress(address: string): URL | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // An address with a username or password in it is never served as a link
  // (SWEEP-APP-1, SCHOOLS-10 L2): the phone would open it and show the school's secret.
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

/** A query pair's name, decoded (a `+` is a space), or the raw text when it cannot be decoded. */
function pairName(pair: string): string {
  const raw = pair.split('=')[0].replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function isWebAddress(address: string): boolean {
  return webAddress(address) !== null;
}

/**
 * The school's own page with the WAWU code added as `ref`. Nothing about the
 * person goes in: the school's site learns only which school's code it was.
 * A `ref` the address already had is replaced, so the code is always the
 * WAWU one. Null when the address is not a web address, which the dashboard
 * should have refused but a row written some other way could be.
 */
export function trackedUrl(applyUrl: string, code: string): string | null {
  const url = webAddress(applyUrl);
  if (!url) return null;
  // The school's query is kept as the school wrote it: `searchParams.set` would
  // read it as a form and write it back re-encoded ("Jos%E9" becomes "Jos%EF%BF%BD",
  // "flag" becomes "flag="), which breaks a signed or legacy-encoded address
  // (SWEEP-APP-1, SCHOOLS-10 L1). Only the pairs named `ref` are dropped.
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '' && pairName(pair) !== LINK_PARAM);
  url.search = `?${[...kept, `${LINK_PARAM}=${code}`].join('&')}`;
  return url.toString();
}

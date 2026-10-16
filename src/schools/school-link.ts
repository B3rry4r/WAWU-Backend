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
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
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
  url.searchParams.set(LINK_PARAM, code);
  return url.toString();
}

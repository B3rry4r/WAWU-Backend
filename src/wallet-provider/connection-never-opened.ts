/**
 * Whether a failed `fetch` proves the request never reached the provider
 * (MONEY-18 round 2, O1): the connection was refused, the host name did not
 * resolve, or no route to the host existed. Nothing was written to a socket,
 * so the provider has no record of the request and the same reference can be
 * sent again.
 *
 * A request undici itself refuses for a blocked port (`bad port`) opens
 * nothing either.
 *
 * Deliberately narrow. A reset, a timeout once connected, a TLS failure, an
 * aborted request or any error without one of these codes stays an unknown
 * outcome (the request may have been read), and the caller asks the provider
 * and never sends it again. Undici wraps the socket's error as the `cause` of
 * a `TypeError: fetch failed`; an address list that was tried in turn
 * (Node's happy-eyeballs) arrives as an `AggregateError` whose `errors` are
 * each the socket's. Every leaf must be one of the codes below.
 */
export const CONNECTION_NEVER_OPENED_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const MAX_DEPTH = 6;

function codeOf(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Undici (Node's fetch) refuses a request to a port the Fetch standard blocks
 * (1, 7, 9, 11, ... 6000, 6665 to 6669) before it opens anything, with a bare
 * `Error: bad port` and no code.
 */
function isBlockedPort(e: object): boolean {
  return (
    codeOf(e) === null && (e as { message?: unknown }).message === 'bad port'
  );
}

function leavesAreNeverOpened(e: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || typeof e !== 'object' || e === null) return false;
  const inner = (e as { errors?: unknown }).errors;
  if (Array.isArray(inner) && inner.length > 0) {
    return inner.every((x) => leavesAreNeverOpened(x, depth + 1));
  }
  const code = codeOf(e);
  if (code !== null) return CONNECTION_NEVER_OPENED_CODES.has(code);
  if (isBlockedPort(e)) return true;
  return leavesAreNeverOpened((e as { cause?: unknown }).cause, depth + 1);
}

export function connectionNeverOpened(e: unknown): boolean {
  return leavesAreNeverOpened(e, 0);
}

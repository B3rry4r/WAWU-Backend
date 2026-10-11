/**
 * Whether a failed `fetch` proves the request never reached the provider
 * (MONEY-18 round 2, O1; round 3, R2-1): the connection was refused, the host
 * name did not resolve, or no route to the host existed WHEN THE CONNECTION
 * WAS BEING MADE. Nothing was written to a socket, so the provider has no
 * record of the request and the same reference can be sent again.
 *
 * The error code alone is not proof. Node raises the same codes
 * (`ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`) on a connection that was
 * already established, when the route fails under it after the provider read
 * the whole request: `Error: read EHOSTUNREACH`, `errno: -113`,
 * `syscall: 'read'` (also `read ENETUNREACH` and `read ECONNREFUSED`). The
 * syscall says which phase failed:
 *
 *  - `ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH` count only with
 *    `syscall === 'connect'` (the connection attempt itself);
 *  - `ENOTFOUND`, `EAI_AGAIN` count only with `syscall === 'getaddrinfo'`
 *    (the name lookup, before any connection);
 *  - `UND_ERR_CONNECT_TIMEOUT` is undici's own connect-phase timer (it is
 *    cancelled the moment the socket connects, or finishes its TLS handshake,
 *    and the request is written after that), so the code is the phase;
 *  - undici's own refusal of a blocked port (`bad port`) opens nothing.
 *
 * Deliberately narrow. Anything else (a reset, a timeout once connected, a
 * TLS failure, an aborted request, a code from a later phase, a code with no
 * syscall, an error without a code) stays an unknown outcome (the request may
 * have been read), and the caller asks the provider and never sends it
 * again. Undici wraps the socket's error as the `cause` of a
 * `TypeError: fetch failed`, and the error that carries the code and the
 * syscall is that cause itself; an address list that was tried in turn
 * (Node's happy-eyeballs) arrives as an `AggregateError` whose `errors` are
 * each the socket's, each with its own syscall. Every leaf must pass.
 *
 * Read from real sockets in `connection-never-opened.spec.ts` (the shapes)
 * and `netns/connection-never-opened-rig.ts` (the route failing after the
 * write, in a private network namespace).
 */
export const CONNECTION_NEVER_OPENED_SYSCALL: ReadonlyMap<string, string> =
  new Map([
    ['ECONNREFUSED', 'connect'],
    ['ENETUNREACH', 'connect'],
    ['EHOSTUNREACH', 'connect'],
    ['ENOTFOUND', 'getaddrinfo'],
    ['EAI_AGAIN', 'getaddrinfo'],
  ]);

/** undici's connect-phase timeout (`ConnectTimeoutError`). */
export const CONNECT_TIMEOUT_CODE = 'UND_ERR_CONNECT_TIMEOUT';

const MAX_DEPTH = 6;

function codeOf(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function syscallOf(e: object): string | null {
  const syscall = (e as { syscall?: unknown }).syscall;
  return typeof syscall === 'string' ? syscall : null;
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
  if (code !== null) {
    if (code === CONNECT_TIMEOUT_CODE) return true;
    const phase = CONNECTION_NEVER_OPENED_SYSCALL.get(code);
    return phase !== undefined && syscallOf(e) === phase;
  }
  if (isBlockedPort(e)) return true;
  return leavesAreNeverOpened((e as { cause?: unknown }).cause, depth + 1);
}

export function connectionNeverOpened(e: unknown): boolean {
  return leavesAreNeverOpened(e, 0);
}

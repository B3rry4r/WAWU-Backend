/**
 * The numbers the live connection runs on (task INBOX-02). All are technical
 * settings, none is a product, money or legal figure.
 */
export const LIVE_LIMITS = {
  /** The socket's path, behind the `api/hub` global prefix nginx forwards. */
  path: '/api/hub/live',
  /** How long a socket may stay open without presenting a token. */
  authTimeoutMs: 5_000,
  /** A ping goes out this often; a socket that never answered the last one is dropped. */
  heartbeatMs: 30_000,
  /** The largest frame a client may send. Clients only ever send an `auth` or a `ping`. */
  maxFrameBytes: 8_192,
  /** The most sockets one person may hold at once; the oldest is closed for the next. */
  socketsPerUser: 8,
  /**
   * A catch-up reads this far behind the cursor it is given. A message gets
   * its time when its transaction starts, so one that began earlier can
   * commit after a later one has already been pushed. Clients drop what they
   * already hold by id.
   */
  catchUpOverlapMs: 10_000,
  /** How many sockets from one address may be open and not yet signed in. */
  unsignedPerAddress: 20,
  /** A socket with more than this waiting to be sent is closed: its client is not reading. */
  maxBufferedBytes: 1_048_576,
  /** The feed sends itself a probe this often and must hear it back. */
  probeEveryMs: 30_000,
  /** How long a probe may take to come back. */
  probeTimeoutMs: 3_000,
  /** On SIGTERM, how long close frames get to leave before the process goes. */
  shutdownFlushMs: 1_000,
  catchUpDefaultLimit: 50,
  catchUpMaxLimit: 100,
} as const;

/** Close codes the server sends. The app reconnects on all of them. */
export const LIVE_CLOSE = {
  /** Shutting down. */
  goingAway: 1001,
  /** The first frame was not a valid `auth`, or no token came in time. */
  unauthenticated: 4401,
  /** The token's person is not the one this socket was opened for. */
  wrongPerson: 4403,
  /** The person opened more sockets than they may hold. */
  replaced: 4409,
  /** The client is not reading what it is sent. */
  tooSlow: 4408,
  /** The server lost its feed of events; reconnect and catch up. */
  resync: 4503,
} as const;

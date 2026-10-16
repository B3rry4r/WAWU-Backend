/**
 * The assistant conversation's limits (LEGAL-01).
 *
 * Every profiling turn is one paid call to the AI provider, so a person's
 * turns are counted after their token is verified, per person rather than per
 * address (an address can be a whole office or a carrier's NAT). No route here
 * sets a throttler of its own: the app's global per-address limits still
 * apply on top (`src/hub-throttlers.ts`).
 */

/**
 * PROVISIONAL(LEGAL-ASSISTANT-TURNS-PER-HOUR, owner=YOU, why=each turn is a paid AI call and no ruling names a limit; 30 an hour is about one message every two minutes, far above a person describing one problem)
 */
export const ASSISTANT_CLIENT_MESSAGES_PER_HOUR = 30;

/**
 * PROVISIONAL(LEGAL-ASSISTANT-MESSAGES-PER-CONVERSATION, owner=YOU, why=no ruling names one; profiling is meant to take a few questions, and 40 messages is ten times the design's three)
 */
export const ASSISTANT_CLIENT_MESSAGES_PER_INTAKE = 40;

/**
 * Preparing the brief on Send is a paid AI call a client message did not pay
 * for, so a failed one can be tried again, but only this often. These also
 * count toward the hourly limit above.
 *
 * PROVISIONAL(LEGAL-ASSISTANT-BRIEF-ATTEMPTS-PER-HOUR, owner=YOU, why=no ruling names one; the brief should take one call, so five tries an hour covers a bad few minutes at the provider without letting a client multiply paid calls)
 */
export const ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR = 5;

/**
 * Writing the opener on a paid matter's thread (FIX-11) is a paid AI call
 * nobody asked for: it runs when the client first reads an empty thread. A
 * failed one is tried again on a later read, but only this often, so a
 * screen that keeps reading while the provider is down cannot spend the
 * client's hourly allowance for them.
 *
 * Only tries that came to nothing count here: calls that failed, and claims
 * that lapsed because their Hub died mid-call. An opener that was written
 * (one per matter) never counts, so a person with several paid matters gets
 * every one opened (lead ruling, 8 Oct 2026). Every try, written or not,
 * still counts toward the hourly limit above.
 *
 * PROVISIONAL(LEGAL-OPENER-FAILURES-PER-HOUR, owner=YOU, why=no ruling names one; an opener should take one call so five failed or lapsed tries an hour cover a bad few minutes at the provider without letting reads multiply paid calls; written openers never count)
 */
export const ASSISTANT_OPENER_FAILURES_PER_HOUR = 5;

/**
 * How long a read that found another read's opener call running waits for
 * that opener before answering with the thread as it is, in milliseconds
 * (FIX-11). The real provider adapter gives up on a call after the same 20 s,
 * so a waiting read is held no longer than the call it waits for. Read
 * through `LEGAL_OPENER_WAIT_MS` so a spec can set a short one.
 */
export const ASSISTANT_OPENER_WAIT_MS = 20_000;

/** The injection token for `ASSISTANT_OPENER_WAIT_MS`. */
export const LEGAL_OPENER_WAIT_MS = Symbol('LEGAL_OPENER_WAIT_MS');

/**
 * How long a claim on a conversation (a retry of the reply, preparing the
 * brief, or writing a matter thread's opener) holds if the process holding
 * it dies, in milliseconds. The provider
 * adapter sets no timeout of its own, so a call that hangs longer than this
 * lets one more claim start; every call is still counted against the hourly
 * limits, so the cost stays capped either way.
 */
export const ASSISTANT_CLAIM_MS = 60_000;

/**
 * After this many client messages the brief is offered even if the assistant
 * has not said it is ready, so a conversation that keeps asking can always be
 * sent to a person.
 *
 * PROVISIONAL(LEGAL-ASSISTANT-BRIEF-AFTER, owner=YOU, why=no ruling names one; the design shows the brief after three answers)
 */
export const ASSISTANT_BRIEF_AFTER_CLIENT_MESSAGES = 8;

/** The newest messages the model is shown on a turn. */
export const ASSISTANT_HISTORY_MESSAGES = 30;

/** The longest message a client can send (characters). */
export const ASSISTANT_MESSAGE_MAX_CHARS = 2000;

/** Caps on what the model may hand back, so one runaway answer stays small. */
export const ASSISTANT_LIMITS = {
  replyChars: 1200,
  quickReplies: 4,
  quickReplyChars: 40,
  briefRows: 8,
  briefLabelChars: 40,
  briefValueChars: 160,
  headlineChars: 60,
  textAnswerChars: 1000,
} as const;

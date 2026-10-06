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

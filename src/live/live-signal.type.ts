/** The Postgres channel every Hub instance listens on. */
export const LIVE_CHANNEL = 'wawu_live';

/**
 * What one instance tells all instances through `pg_notify`: which row
 * changed, never the row. Every instance reads the row itself for the people
 * connected to it, so a payload stays far under Postgres's 8000-byte limit
 * and nothing private travels through the channel.
 */
export type LiveSignal =
  | { kind: 'chat.message'; chatId: string; messageId: string }
  | { kind: 'chat.read'; chatId: string; readerWawuId: string }
  | { kind: 'community.message'; communityId: string; messageId: string }
  | { kind: 'legal.thread'; legalRequestId: string; messageId: string };

/**
 * The feed's own test (never shown to anyone): a listener sends it to itself
 * and must hear it back, which a listener behind a transaction-mode pooler or
 * on a half-open connection never does. It never reaches LiveDispatcher.
 */
export interface LiveProbe {
  kind: 'probe';
  id: string;
}

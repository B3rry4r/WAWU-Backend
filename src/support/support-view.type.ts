/**
 * Every response shape the support routes return (task SUPPORT-01). One named
 * interface each, so the generated contract carries a named schema the app
 * can import.
 */

/** What a support thread can be about. */
export type SupportReferenceKind = 'transaction' | 'payment';

/**
 * What the thread was opened about, as the first message in it says it. Null
 * on a thread opened with no reference (W35, "Help with a payment").
 */
export interface SupportReferenceView {
  kind: SupportReferenceKind;
  /** The id the app sent: a wallet transaction's id, or a payment's id. */
  id: string;
  /** The reference the person reads on the receipt (W27) or the unlock (H16). */
  reference: string;
}

/**
 * POST /support/thread: the person's one support thread, opened now if there
 * was none. Open it in the chat screen with `chatId` (GET /chats/{chatId},
 * GET /chats/{chatId}/messages). `messageId` is the message that carries the
 * reference: the same message, never a second one, however many times the
 * same reference is sent.
 */
export interface SupportThreadView {
  chatId: string;
  reference: SupportReferenceView | null;
  messageId: string | null;
}

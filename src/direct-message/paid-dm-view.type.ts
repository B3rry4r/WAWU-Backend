import type { DmOtherParty } from '../common/types';

/**
 * Every response shape the paid-question thread routes return (task
 * INBOX-08). One named interface each, so the generated contract carries a
 * named schema the app can import. Money is integer kobo (CONVENTIONS 1).
 */

/** Which side of the paid questions the caller is reading as. */
export type PaidDmSide = 'fan' | 'creator';

export type PaidDmStatus = 'awaiting_response' | 'responded' | 'refunded';

/** One creator reply bubble. */
export interface PaidDmReply {
  id: string;
  text: string;
  /** ISO time the reply was stored. */
  createdAt: string;
}

/** One paid question with every reply bubble it has, oldest first. */
export interface PaidDmQuestion {
  id: string;
  /** The question's words. */
  text: string;
  /** The price paid for it, in kobo. */
  amountKobo: number;
  status: PaidDmStatus;
  /** True when the caller asked it (they are the fan on this question). */
  mine: boolean;
  /** ISO time it was sent. */
  sentAt: string;
  /** ISO time the creator's window closes. Never moves once set. */
  deadlineAt: string;
  /** ISO time of the first reply. Null while waiting. */
  respondedAt: string | null;
  /** Reply bubbles, oldest first. Empty while waiting. */
  replies: PaidDmReply[];
}

/** One person's thread of paid questions with another. */
export interface PaidDmThread {
  /** The other person: the creator for a fan, the fan for a creator. */
  other: DmOtherParty;
  side: PaidDmSide;
  /** Questions in the thread, all statuses. */
  questionCount: number;
  /** Questions still open and inside their window. */
  waitingCount: number;
  /** The soonest deadline among the waiting questions. Null when none wait. */
  nextDeadlineAt: string | null;
  /** ISO time of the latest question or reply. */
  lastActivityAt: string;
  /** What the thread's last bubble said, for the inbox row. */
  lastText: string;
  /** True when the caller wrote that last bubble. */
  lastTextMine: boolean;
}

export interface PaidDmThreadPage {
  items: PaidDmThread[];
  nextCursor: string | null;
}

/** GET /paid-dm/threads/:wawuId: the questions, newest first, each with its replies. */
export interface PaidDmThreadDetail {
  thread: PaidDmThread;
  questions: PaidDmQuestion[];
  nextCursor: string | null;
}

/** One question in the creator's waiting list. */
export interface PaidDmQueueItem {
  id: string;
  text: string;
  amountKobo: number;
  sentAt: string;
  deadlineAt: string;
  /** The fan who paid. */
  sender: DmOtherParty;
}

/** The creator's waiting list: soonest deadline first, with the total waiting. */
export interface PaidDmQueuePage {
  items: PaidDmQueueItem[];
  nextCursor: string | null;
  /** Every question waiting for this creator, not just this page. */
  waitingTotal: number;
}

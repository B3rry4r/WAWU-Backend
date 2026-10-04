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

/** Where a creator stands on unanswered paid questions (R-13). */
export type PaidDmStandingState = 'ok' | 'warning' | 'paused';

/**
 * GET /paid-dm/standing: the creator's own standing. The share is taken over
 * the questions whose outcome is known (answered, or past their deadline)
 * sent inside the window.
 */
export interface PaidDmStanding {
  state: PaidDmStandingState;
  /** False while paused: a fan's new paid question is refused. */
  acceptingPaidMessages: boolean;
  /** Share of resolved questions left unanswered, 0 to 100, two decimals. While paused, the share that caused the pause. */
  unansweredPct: number;
  /** Questions left unanswered inside the window. Null while paused. */
  unanswered: number | null;
  /** Questions with a known outcome inside the window. Null while paused. */
  questions: number | null;
  /** The share that earns a warning, from config (R-13). */
  warnAtPct: number;
  /** The share that switches paid messages off, from config (R-13). */
  pauseAtPct: number;
  /** The rolling window, in days. */
  windowDays: number;
  /** How long a pause lasts, in days. */
  pauseDays: number;
  /** ISO time paid messages come back. Null unless paused. */
  pausedUntil: string | null;
}

/** GET /paid-dm/creators/:wawuId/availability: what a fan sees on a creator's profile (I8). */
export interface PaidDmAvailability {
  creatorWawuId: string;
  /** True while the creator's paid messages are switched off. */
  paused: boolean;
  /** ISO time they come back. Null unless paused. */
  pausedUntil: string | null;
}

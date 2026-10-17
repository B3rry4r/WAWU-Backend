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

/**
 * Where the creator's share of a question is (INBOX-18; I10, I11). The Hub's
 * figure and words, never worked out by the app (R-5, R-21).
 * - `pending`: not answered yet; answering earns `amountKobo`.
 * - `on_its_way`: answered; the share is an earning that reaches the wallet in
 *   the creator's one move a day (R-55).
 * - `waiting_for_wallet`: answered; the creator has no wallet yet, so the share
 *   waits and lands the moment they open one (R-11).
 * - `in_wallet`: answered; the share has landed in the wallet.
 */
export type PaidDmEarningState =
  'pending' | 'on_its_way' | 'waiting_for_wallet' | 'in_wallet';

export interface PaidDmCreatorEarning {
  /** The creator's share of the price, in kobo (the held price's payee share). */
  amountKobo: number;
  /** That share as a whole percent of the price (R-5: 85). */
  sharePct: number;
  state: PaidDmEarningState;
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
  /**
   * What the creator earns by this question, read by the creator only. Null
   * for the person who asked, for a refunded question, and for a question
   * that was not paid from a wallet (it holds no share).
   */
  creatorEarning: PaidDmCreatorEarning | null;
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

/**
 * GET /paid-dm/waiting: the figures above the creator's waiting list (I9):
 * how many questions wait on a reply and what they were paid, in kobo, over
 * every question waiting and not only a page of them.
 */
export interface PaidDmWaiting {
  count: number;
  amountKobo: number;
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

/** One quick price the screen offers. */
export interface PaidDmPricePreset {
  /** The price per message in kobo. */
  priceKobo: number;
}

/** What a creator may choose on the paid messages settings (I21), from config. */
export interface PaidDmSettingsOptions {
  /** Lowest price a paid message may have, in kobo. */
  minPriceKobo: number;
  /** Highest price a paid message may have, in kobo. */
  maxPriceKobo: number;
  /** The quick prices to offer, ascending. */
  pricePresets: PaidDmPricePreset[];
  /** The reply windows to offer, in hours, ascending. */
  responseWindowHours: number[];
}

/**
 * GET and PUT /paid-dm/settings: the creator's paid message settings (I21 to
 * I23), with everything the screen draws. Money is integer kobo.
 */
export interface PaidDmSettings {
  /** The creator's own switch. It stays as set while paid messages are paused: the pause ends by the clock and they are back on. */
  enabled: boolean;
  /** Price per message in kobo. Null until one is set. */
  priceKobo: number | null;
  /** Hours the creator has to reply. */
  responseHours: number;
  /** The share of each message the creator keeps, in whole percent (R-5: 85). */
  creatorSharePct: number;
  /** What the creator keeps per message at the saved price, in kobo. Null with no price. */
  earnPerMessageKobo: number | null;
  /** The next preset price above the saved one, offered when warned. Null when none is higher. */
  raiseToKobo: number | null;
  options: PaidDmSettingsOptions;
  /** Warned, paused and when paid messages come back (I22, I23). */
  standing: PaidDmStanding;
}

/**
 * GET /paid-dm/settings/earn: what a creator keeps of one message at a price
 * they are typing, worked out by the Hub with the same share and rounding as
 * the saved settings (R-21: the screen never multiplies or divides money).
 */
export interface PaidDmEarn {
  /** The price asked about, in kobo, as sent. */
  priceKobo: number;
  /** The share of each message the creator keeps, in whole percent (R-5: 85). */
  creatorSharePct: number;
  /** What the creator keeps of one message at that price, in kobo, rounded down. */
  earnPerMessageKobo: number;
}

import type { VerificationState } from '../common/verification/verification-state';
import type { MoneyRequestStatus } from '../money-request/money-request-view.type';

/**
 * Every response shape the inbox routes return (task INBOX-07). One named
 * interface each, so the generated contract carries a named schema the app
 * can import.
 */

/**
 * What a row of the inbox is. A `money_request` row is one request the
 * caller made or was asked for (INBOX-15), in any status. A `money_move` row
 * (FIX-114) is one send between the caller and another WAWU person; it is
 * served only under `kind=money`, never in the unfiltered list. The Money
 * chip (I20) is `kind=money`: requests and sends together.
 */
export type InboxKind =
  'chat' | 'paid_dm' | 'community' | 'money_request' | 'money_move';

/**
 * What `GET /inbox?kind=` takes: one kind of row, or `money` for the Money
 * chip (`money_request` and `money_move` rows together).
 */
export type InboxFilter = InboxKind | 'money';

/** The other person on a chat or a paid thread, or the sender of a room's last message. */
export interface InboxPerson {
  wawuId: string;
  /** Full name from WAWU ID, or the handle when WAWU ID has none. Empty for an account that is gone. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  verification: VerificationState;
  /**
   * True only for the support side of a support thread (SUPPORT-01): the row
   * draws the app's own mark. Left out for every ordinary person.
   */
  support?: boolean;
}

/** What a row's last line says, for the preview under the name. */
export interface InboxPreview {
  /** Words. Null when the last bubble is only a photo, video or file. */
  text: string | null;
  /** The kind of attachment the bubble carries, if any. */
  attachment: 'image' | 'video' | 'file' | null;
  /** True when the caller wrote it. */
  mine: boolean;
  /** Who wrote it, for a room's preview line. Null on a chat or a paid thread. */
  senderName: string | null;
  /** ISO time of the bubble. */
  sentAt: string;
  /**
   * Set on a chat row whose last bubble is a request for money: what was
   * asked and where it stands now. `text` is then the request's reason.
   */
  moneyRequest: { amountKobo: number; status: MoneyRequestStatus } | null;
}

/** The part of a row that is specific to a chat. */
export interface InboxChat {
  chatId: string;
  other: InboxPerson;
  /** False when either person blocked the other: the composer is hidden. */
  canMessage: boolean;
}

/** The part of a row that is specific to a paid-question thread. */
export interface InboxPaidDm {
  /** `fan` for questions the caller asked, `creator` for questions sent to them. */
  side: 'fan' | 'creator';
  other: InboxPerson;
  /** Questions in the thread, all statuses. */
  questionCount: number;
  /** Questions still open and inside their window. */
  waitingCount: number;
  /** The soonest deadline among the waiting questions. Null when none wait. */
  nextDeadlineAt: string | null;
}

/** The part of a row that is specific to a community room. */
export interface InboxCommunity {
  communityId: string;
  name: string;
  imageUrl: string | null;
  kind: 'open' | 'private';
  /** `host` for a room the caller hosts, `member` for one they joined. */
  role: 'host' | 'member';
}

/** The part of a row that is specific to a money request (INBOX-15). */
export interface InboxMoneyRequest {
  requestId: string;
  /** The chat the request was written into: the row opens it. */
  chatId: string;
  /** `outgoing` when the caller asked, `incoming` when the caller was asked. */
  direction: 'outgoing' | 'incoming';
  /** The other person in the request. */
  other: InboxPerson;
  /** What was asked for, in kobo. */
  amountKobo: number;
  memo: string | null;
  status: MoneyRequestStatus;
  /** A payment for it is on its way and not confirmed: it cannot be paid again. */
  paying: boolean;
  /** False when either person blocked the other. */
  canMessage: boolean;
}

/** The state of a send as the Hub holds it. A failed send is never a row. */
export type InboxMoneyMoveStatus = 'pending' | 'completed' | 'reversed';

/**
 * The part of a row that is a send between two WAWU people (FIX-114). It is
 * what the send's own row says: the amount is never added to anything.
 */
export interface InboxMoneyMove {
  transferId: string;
  /** The chat of the two people: the row opens it. */
  chatId: string;
  /** `outgoing` when the caller sent it, `incoming` when the caller received it. */
  direction: 'outgoing' | 'incoming';
  /** The other person in the send. */
  other: InboxPerson;
  /** What the receiver got, in kobo (fees are not in it). */
  amountKobo: number;
  /** The sender's own note, if they wrote one. */
  note: string | null;
  /**
   * `pending` (the provider has not confirmed; only the sender sees it),
   * `completed`, or `reversed` (the money went back to the sender).
   */
  status: InboxMoneyMoveStatus;
  /** False when either person blocked the other. */
  canMessage: boolean;
}

/**
 * One row of the inbox. `id` is the row's stable key (`chat:<id>`,
 * `paid_dm:<side>:<wawuId>`, `community:<id>`, `money_request:<id>`,
 * `money_move:<id>`): it is the same on every fetch, so the app can patch one
 * row in place when a live event names it. Exactly one of `chat`, `paidDm`,
 * `community`, `moneyRequest` and `moneyMove` is set, the one `kind` names.
 * `moneyMove` is left out of every other kind's row, so a row that existed
 * before FIX-114 reads exactly as it did.
 */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  /**
   * ISO time of the latest activity, the time rows are ordered by. Null only
   * for a room the caller hosts that has no message yet.
   */
  lastActivityAt: string | null;
  /**
   * What the source says is unread: a chat's unread messages, a room's
   * unread messages, and for a paid thread the caller received (creator side)
   * the questions still waiting for an answer. Always 0 on a thread the
   * caller asked (fan side). Always 0 on a money request: it is a message in
   * its chat, which counts it, so the badge never counts it twice. Always 0
   * on a money move: the badge never counts it.
   */
  unreadCount: number;
  preview: InboxPreview | null;
  chat: InboxChat | null;
  paidDm: InboxPaidDm | null;
  community: InboxCommunity | null;
  moneyRequest: InboxMoneyRequest | null;
  /** Set only on a `money_move` row (FIX-114); absent on every other row. */
  moneyMove?: InboxMoneyMove;
}

export interface InboxPage {
  items: InboxItem[];
  /** Pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/**
 * GET /inbox/unread: the Inbox tab's badge. `total` is exactly the sum of
 * `unreadCount` over every row the inbox lists, all pages, and the three
 * parts add up to it (money requests add none: their chat counts them).
 */
export interface InboxUnread {
  total: number;
  chats: number;
  paidDms: number;
  communities: number;
}

import type { VerificationState } from '../common/verification/verification-state';

/**
 * Every response shape the inbox routes return (task INBOX-07). One named
 * interface each, so the generated contract carries a named schema the app
 * can import.
 */

/** What a row of the inbox is. Money requests join in INBOX-15 as a new kind. */
export type InboxKind = 'chat' | 'paid_dm' | 'community';

/** The other person on a chat or a paid thread, or the sender of a room's last message. */
export interface InboxPerson {
  wawuId: string;
  /** Full name from WAWU ID, or the handle when WAWU ID has none. Empty for an account that is gone. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  verification: VerificationState;
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

/**
 * One row of the inbox. `id` is the row's stable key (`chat:<id>`,
 * `paid_dm:<side>:<wawuId>`, `community:<id>`): it is the same on every
 * fetch, so the app can patch one row in place when a live event names it.
 * Exactly one of `chat`, `paidDm` and `community` is set, the one `kind`
 * names.
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
   * caller asked (fan side).
   */
  unreadCount: number;
  preview: InboxPreview | null;
  chat: InboxChat | null;
  paidDm: InboxPaidDm | null;
  community: InboxCommunity | null;
}

export interface InboxPage {
  items: InboxItem[];
  /** Pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/**
 * GET /inbox/unread: the Inbox tab's badge. `total` is exactly the sum of
 * `unreadCount` over every row the inbox lists, all pages, and the three
 * parts add up to it.
 */
export interface InboxUnread {
  total: number;
  chats: number;
  paidDms: number;
  communities: number;
}

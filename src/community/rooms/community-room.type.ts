import type { CommunityResponse } from '../../common/types';
import type { CommunityMessageSender } from '../../common/types/community-message.type';

/**
 * INBOX-01 wire shapes. They live beside the routes that return them rather
 * than in src/common/types (fenced), and none of them is returned by a route
 * the web calls: CommunityResponse itself is unchanged.
 */

/** A community with its share link. `link` is written `wawu/c/<slug>`. */
export type CommunityRoom = CommunityResponse & {
  slug: string;
  link: string;
};

/** GET /communities/:id/link. */
export interface CommunityLinkView {
  communityId: string;
  slug: string;
  /** `wawu/c/<slug>`, the form the app shows and shares. */
  link: string;
}

/** The newest message in a room, for the preview line on "my communities". */
export interface CommunityLastMessage {
  id: string;
  text: string | null;
  imageUrl: string | null;
  sentAt: Date;
  senderWawuId: string;
  /** Null only when the sender could not be looked up at all. */
  sender: CommunityMessageSender | null;
}

/** One row of GET /communities/mine. */
export type MyCommunity = CommunityRoom & {
  /** `host` for a room the caller hosts, `member` for one they joined. */
  role: 'host' | 'member';
  /** When the caller became a member. Null for the host, who never joins. */
  joinedAt: Date | null;
  lastMessage: CommunityLastMessage | null;
  /**
   * Messages from other people sent after the caller last opened the room
   * (POST /communities/:id/read). Before the first read it counts from when
   * they joined; a host who has never opened their room counts every message
   * from someone else.
   */
  unreadCount: number;
  /** The last message's time, or when the caller joined. Rows are newest first. */
  lastActivityAt: Date | null;
};

/** POST /communities/:id/read. */
export interface CommunityReadView {
  communityId: string;
  lastReadAt: Date;
}

/**
 * INBOX-05. Where the caller stands in a room: `host` (they host it),
 * `member` (let in), `pending` (asked to join a private room, waiting for the
 * host) or `none`.
 */
export type CommunityViewerRole = 'host' | 'member' | 'pending' | 'none';

/** INBOX-05, GET /communities/:id/room: a room as the caller sees it (I25). */
export type CommunityRoomView = CommunityRoom & {
  role: CommunityViewerRole;
  /**
   * WAWU Credits the caller spends to send one message here: 0 for the host,
   * the metered cost for anyone else. A count, never naira.
   */
  messageCostInCredits: number;
};

/** INBOX-05, GET /communities/message-cost: the Communities card's price line (I24). */
export interface CommunityMessageCost {
  /** WAWU Credits one message costs a member. Reading costs nothing. */
  creditsPerMessage: number;
}

/**
 * INBOX-05, GET /communities/suggested: a room the caller could join, with its
 * member count (I24, "2.1K members · open").
 */
export type SuggestedCommunity = CommunityResponse;

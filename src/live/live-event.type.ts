import type { ChatMessage } from '../chat/chat-view.type';
import type { CommunityMessage } from '../common/types/community-message.type';

/**
 * What a client receives, over the socket and from `GET /live/catch-up`. Every
 * event carries a `cursor`: the newest one a client has seen is what it sends
 * back to catch up after a reconnect. Nothing here is a balance or a figure of
 * money.
 */
interface LiveEventBase {
  /** Opaque. Send the newest one you hold to `GET /live/catch-up`. */
  cursor: string;
}

/** A message in one of the caller's chats, as the caller sees it (`mine`, `readState`). */
export interface LiveChatMessageEvent extends LiveEventBase {
  type: 'chat.message';
  message: ChatMessage;
}

/**
 * Someone's read mark in a chat moved. For the person who sent messages it is
 * the "read" tick: everything up to `lastReadMessageId` has been seen.
 * `mine` is true when the caller is the one who read (their other phone).
 */
export interface LiveChatReadEvent extends LiveEventBase {
  type: 'chat.read';
  chatId: string;
  readerWawuId: string;
  mine: boolean;
  /** ISO time of the newest message the reader has read. */
  lastReadAt: string | null;
  lastReadMessageId: string | null;
}

/** A message in a community the caller is in. Same shape as `GET /communities/:id/messages`. */
export interface LiveCommunityMessageEvent extends LiveEventBase {
  type: 'community.message';
  communityId: string;
  message: CommunityMessage;
}

/**
 * A legal conversation changed (LEGAL-02): a consultant wrote in it. Socket only,
 * and not part of `GET /live/catch-up` (a phone reads the conversation itself,
 * `GET /legal/assistant/{id}`, when it reconnects). It carries no words and no
 * name: the phone reads them from the route, which checks who it is. `cursor` is
 * the message's time, as every event's is.
 */
export interface LiveLegalThreadEvent extends LiveEventBase {
  type: 'legal.thread';
  legalRequestId: string;
}

export type LiveEvent =
  LiveChatMessageEvent | LiveChatReadEvent | LiveCommunityMessageEvent;

/** First frame the server sends once a token is accepted. */
export interface LiveReadyFrame {
  type: 'ready';
  wawuId: string;
  /** Where "now" is. A client with no cursor yet starts from this one. */
  cursor: string;
}

/** `GET /live/catch-up`: what was missed since a cursor, oldest first. */
export interface LiveCatchUp {
  events: LiveEvent[];
  /** The cursor to hold next. When `hasMore` is true, send it straight back. */
  cursor: string;
  hasMore: boolean;
}

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

/**
 * A money request in one of the caller's chats changed: it was paid,
 * declined or cancelled (INBOX-15). `message` is the chat bubble that carries
 * it, as the caller sees it, with the request's status now (`moneyRequest`);
 * the app replaces the bubble it holds with the same id. A request being
 * made arrives as a plain `chat.message`.
 */
export interface LiveMoneyRequestEvent extends LiveEventBase {
  type: 'money_request.updated';
  chatId: string;
  message: ChatMessage;
}

/** A message in a community the caller is in. Same shape as `GET /communities/:id/messages`. */
export interface LiveCommunityMessageEvent extends LiveEventBase {
  type: 'community.message';
  communityId: string;
  message: CommunityMessage;
}

/**
 * MOD-ROOMS (R-122). The host of a room deleted a message: every open room drops it at once. It names the message by id
 * and carries no words. It goes to the people a `community.message` goes to, and into `GET /live/catch-up`, so a phone
 * that was offline when the host deleted it drops the message when it comes back. `cursor` is the time the host deleted
 * it. Applying it twice, or for a message the phone never held, changes nothing.
 */
export interface LiveCommunityMessageRemovedEvent extends LiveEventBase {
  type: 'community.message.removed';
  communityId: string;
  messageId: string;
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
  | LiveChatMessageEvent
  | LiveChatReadEvent
  | LiveMoneyRequestEvent
  | LiveCommunityMessageEvent
  | LiveCommunityMessageRemovedEvent;

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

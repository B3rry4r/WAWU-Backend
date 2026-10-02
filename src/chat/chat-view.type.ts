import type { VerificationState } from '../common/verification/verification-state';

/**
 * Every response shape the free chat routes return (task INBOX-06). One named
 * interface each, so the generated contract carries a named schema the app
 * can import.
 */

/** What a message holds: words, a photo, a video, or a PDF. */
export type ChatMessageKind = 'text' | 'image' | 'video' | 'file';

/**
 * Read state on a message the caller sent: `sent` until the other person has
 * read up to it, then `read`. Null on a message the other person sent.
 */
export type ChatReadState = 'sent' | 'read';

/** The other person in a chat, as the chat header and list draw them. */
export interface ChatPerson {
  wawuId: string;
  /** Full name from WAWU ID, or the handle when WAWU ID has none. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  verification: VerificationState;
}

export interface ChatAttachment {
  /**
   * A signed link to the file, made fresh on every read. Null when storage
   * could not sign one at that moment (the bubble shows the file without a
   * link and the next read tries again).
   */
  url: string | null;
  contentType: string;
  bytes: number;
  /** The file's own name (PDFs). Null for a photo or video. */
  name: string | null;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderWawuId: string;
  /** True when the caller sent it. */
  mine: boolean;
  kind: ChatMessageKind;
  text: string | null;
  attachment: ChatAttachment | null;
  /** The sender app's own id, echoed back on the sender's copy only. */
  clientMessageId: string | null;
  /** ISO time the server stored it. */
  createdAt: string;
  readState: ChatReadState | null;
}

export interface ChatSummary {
  id: string;
  other: ChatPerson;
  /** ISO time the chat was opened. */
  createdAt: string;
  /** ISO time of the newest message, or when the chat was opened. */
  lastActivityAt: string;
  lastMessage: ChatMessage | null;
  /** Messages from the other person newer than the caller's read mark. */
  unreadCount: number;
  /** ISO time of the newest message the caller has read. */
  myLastReadAt: string | null;
  /** ISO time of the newest message the other person has read. */
  otherLastReadAt: string | null;
  /**
   * False when either person has blocked the other: the history stays
   * readable, and sending is refused with 403 `chat_blocked`.
   */
  canMessage: boolean;
}

/** GET /chats, newest activity first. `nextCursor: null` is the last page. */
export interface ChatSummaryPage {
  items: ChatSummary[];
  nextCursor: string | null;
}

/** GET /chats/:chatId/messages, newest first. `nextCursor: null` is the last page. */
export interface ChatMessagePage {
  items: ChatMessage[];
  nextCursor: string | null;
}

/** POST /chats/:chatId/read: the caller's read mark after the call. */
export interface ChatReadMark {
  chatId: string;
  lastReadAt: string | null;
  lastReadMessageId: string | null;
  unreadCount: number;
}

/** POST /chats/:chatId/attachments: where to upload, and the key to send. */
export interface ChatUpload {
  /** A presigned PUT, valid for 300 seconds, for exactly `contentLength` bytes. */
  uploadUrl: string;
  /** Sent back as `attachment.key` on POST /chats/:chatId/messages. */
  key: string;
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { lockStorageQuota } from '../storage/storage-lock';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { deriveVerificationState } from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { StorageService } from '../storage/storage.service';
import { LivePublisher } from '../live/live-publisher.service';
import {
  MONEY_REQUEST_MESSAGE_KIND,
  toMoneyRequestView,
} from '../money-request/money-request-view.type';
import { isSupportAccount, supportPerson } from '../support/support-account';
import type { Prisma } from '../../generated/prisma/client';
import {
  CHAT_FOLDER_CONTENT_TYPES,
  CHAT_LIMITS,
  CHAT_UPLOAD_FOLDERS,
  type ChatUploadFolder,
} from './chat-limits';
import type {
  ChatMessage,
  ChatMessageKind,
  ChatMessagePage,
  ChatAttachmentLink,
  ChatAttachmentRules,
  ChatPerson,
  ChatReadMark,
  ChatSummary,
  ChatSummaryPage,
  ChatUpload,
} from './chat-view.type';
import type {
  ChatUploadDto,
  MarkChatReadDto,
  ChatSendMessageDto,
} from './dto/chat.dto';

const DEFAULT_PAGE_SIZE = 20;

/** The message every block refusal carries. It never says who blocked whom. */
const BLOCKED_MESSAGE = 'You can no longer message this person.';

export interface ConversationRow {
  id: string;
  userAWawuId: string;
  userBWawuId: string;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  senderWawuId: string;
  kind: string;
  text: string | null;
  attachmentKey: string | null;
  attachmentContentType: string | null;
  attachmentBytes: number | null;
  attachmentName: string | null;
  clientMessageId: string | null;
  createdAt: Date;
}

interface ReadMarks {
  mine: Date | null;
  mineMessageId: string | null;
  other: Date | null;
  otherMessageId: string | null;
}

/** A cursor is the last row's time and id, base64url so the app treats it as opaque. */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
): { at: Date; id: string } | null {
  if (cursor === undefined) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = raw.indexOf('|');
  const at = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (bar < 1 || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new BadRequestException('cursor is not one this server gave out');
  }
  return { at, id };
}

function kindFor(contentType: string): ChatMessageKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

function folderFor(contentType: string): ChatUploadFolder {
  return contentType === 'application/pdf' ? 'chat/file' : 'chat/media';
}

function isChatKey(key: string, sender: string): boolean {
  return CHAT_UPLOAD_FOLDERS.some((folder) =>
    key.startsWith(`${folder}/${sender}/`),
  );
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Free chat between any two users (task INBOX-06, DECISIONS R-13).
 *
 * Nothing here costs money: it is the ordinary chat the I12 artboard draws,
 * not the paid question a fan sends a creator (DirectMessage). Sending and
 * requesting money in a chat are their own tasks (INBOX-15, INBOX-19).
 *
 * Blocks: a block in either direction (BlockedAccountService, the one place
 * every gated interaction asks) refuses opening a chat, uploading into one and
 * sending in one, with 403 and `reason.code: chat_blocked`. The history stays
 * readable to both people, and `canMessage` tells the screen to hide the
 * composer.
 *
 * Read state: each person has one read mark per chat (ChatParticipant). A
 * message the caller sent reads `read` once the other person's mark has
 * reached it, and `sent` before that.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly blocks: BlockedAccountService,
    private readonly storage: StorageService,
    private readonly live: LivePublisher,
  ) {}

  // ── opening and listing ──────────────────────────────────────────────────

  /** POST /chats: the chat with `otherId`, opened now if there was none. */
  async open(me: string, otherId: string): Promise<ChatSummary> {
    if (otherId === me) {
      throw new BadRequestException('You cannot start a chat with yourself.');
    }
    await this.assertPersonExists(otherId);
    await this.assertCanMessage(me, otherId);
    const row = await this.ensureConversation(me, otherId);
    const [summary] = await this.summaries(me, [row]);
    return summary;
  }

  /**
   * The one conversation between two accounts, made now if there is none.
   * Checks nothing about either account: `open` checks the other person, and
   * the support thread (SUPPORT-01) is with an account that has no profile.
   */
  async ensureConversation(
    me: string,
    otherId: string,
  ): Promise<ConversationRow> {
    const [userAWawuId, userBWawuId] = [me, otherId].sort();
    let row = await this.prisma.chatConversation.findUnique({
      where: { userAWawuId_userBWawuId: { userAWawuId, userBWawuId } },
    });
    if (!row) {
      try {
        row = await this.prisma.chatConversation.create({
          data: {
            userAWawuId,
            userBWawuId,
            participants: {
              create: [
                { wawuUserId: userAWawuId },
                { wawuUserId: userBWawuId },
              ],
            },
          },
        });
      } catch (e) {
        // Both people opened the chat at the same moment: the other insert
        // won, and that row is this chat too.
        if (!isUniqueViolation(e)) throw e;
        row = await this.prisma.chatConversation.findUniqueOrThrow({
          where: { userAWawuId_userBWawuId: { userAWawuId, userBWawuId } },
        });
      }
    }
    return row;
  }

  /** GET /chats: the caller's chats, newest activity first. */
  async list(
    me: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<ChatSummaryPage> {
    const after = decodeCursor(cursor);
    const rows = await this.prisma.chatConversation.findMany({
      where: {
        participants: { some: { wawuUserId: me } },
        ...(after
          ? {
              OR: [
                { lastActivityAt: { lt: after.at } },
                { lastActivityAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.summaries(me, page),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.lastActivityAt, last.id)
          : null,
    };
  }

  /** GET /chats/:chatId */
  async get(me: string, chatId: string): Promise<ChatSummary> {
    const row = await this.conversationFor(me, chatId);
    const [summary] = await this.summaries(me, [row]);
    return summary;
  }

  // ── for the money requests written into a chat (INBOX-15) ────────────────

  /**
   * The other person in a chat the caller is in. Someone else's chat answers
   * 404 exactly as one that does not exist. A block in either direction is
   * refused with 403 `chat_blocked` when `forSending` is set, as a message is.
   */
  async otherInChat(
    me: string,
    chatId: string,
    forSending = false,
  ): Promise<string> {
    const chat = await this.conversationFor(me, chatId);
    const other = this.otherOf(chat, me);
    if (forSending) {
      // A support thread carries no money: nothing is asked of, or sent to,
      // the support side (SUPPORT-01).
      if (isSupportAccount(other) || isSupportAccount(me)) {
        throw new ForbiddenException({
          message: 'Money cannot be requested in a support chat.',
          reason: { code: 'chat_support_no_money' },
        });
      }
      await this.assertCanMessage(me, other);
    }
    return other;
  }

  /**
   * Writes one message of a kind this service does not make itself (a money
   * request) inside the caller's transaction: the row, the chat's activity
   * time, and the sender's own read mark, as a sent message moves all three.
   * The caller publishes the live signal after its transaction commits.
   */
  async writeMessage(
    tx: Prisma.TransactionClient,
    me: string,
    chatId: string,
    kind: string,
    text: string | null,
    clientMessageId: string | null = null,
  ): Promise<MessageRow> {
    const created = await tx.chatMessage.create({
      data: {
        conversationId: chatId,
        senderWawuId: me,
        kind,
        text,
        clientMessageId,
      },
    });
    await tx.chatConversation.update({
      where: { id: chatId },
      data: { lastActivityAt: created.createdAt },
    });
    await this.advanceMark(tx, chatId, me, created);
    return created;
  }

  /** One message of a chat as `viewer` sees it, signed links and request included. */
  async viewMessage(viewer: string, row: MessageRow): Promise<ChatMessage> {
    return this.toMessageWithMarks(viewer, row);
  }

  // ── messages ─────────────────────────────────────────────────────────────

  /** GET /chats/:chatId/messages: newest first. */
  async messages(
    me: string,
    chatId: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<ChatMessagePage> {
    await this.conversationFor(me, chatId);
    const before = decodeCursor(cursor);
    // REPORT-UGC: a message the caller reported is left out for them.
    const reported = await this.blocks.reportedIds(me, 'chat_message');
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationId: chatId,
        id: { notIn: reported },
        ...(before
          ? {
              OR: [
                { createdAt: { lt: before.at } },
                { createdAt: before.at, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const marks = await this.readMarks(me, [chatId]);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(
        page.map((m) => this.toMessage(me, m, marks.get(chatId))),
      ),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  /** POST /chats/:chatId/messages */
  async send(
    me: string,
    chatId: string,
    dto: ChatSendMessageDto,
  ): Promise<ChatMessage> {
    const chat = await this.conversationFor(me, chatId);
    const other = this.otherOf(chat, me);
    await this.assertCanMessage(me, other);

    if (dto.text === undefined && dto.attachment === undefined) {
      throw new BadRequestException(
        'A message needs some text, a photo, a video or a file.',
      );
    }

    if (dto.clientMessageId !== undefined) {
      const earlier = await this.prisma.chatMessage.findUnique({
        where: {
          conversationId_senderWawuId_clientMessageId: {
            conversationId: chatId,
            senderWawuId: me,
            clientMessageId: dto.clientMessageId,
          },
        },
      });
      if (earlier) return this.toMessageWithMarks(me, earlier);
    }

    let attachment: {
      attachmentKey: string;
      attachmentContentType: string;
      attachmentBytes: number;
      attachmentName: string | null;
    } | null = null;
    let kind: ChatMessageKind = 'text';
    if (dto.attachment !== undefined) {
      const stored = isChatKey(dto.attachment.key, me)
        ? await this.prisma.storageObject.findUnique({
            where: { key: dto.attachment.key },
          })
        : null;
      if (
        !stored ||
        stored.wawuUserId !== me ||
        stored.status === 'abandoned'
      ) {
        throw new BadRequestException(
          'That attachment was not uploaded for a chat. Upload it again.',
        );
      }
      // A key that was signed for but never PUT must not become a bubble the
      // other person cannot open. The bucket is asked once for a pending row;
      // nothing is held across the call.
      if (!(await this.storage.confirmUpload(stored))) {
        throw new BadRequestException(
          'That file did not finish uploading. Try sending it again.',
        );
      }
      kind = kindFor(stored.contentType);
      attachment = {
        attachmentKey: stored.key,
        attachmentContentType: stored.contentType,
        attachmentBytes: stored.bytes,
        attachmentName: kind === 'file' ? (dto.attachment.name ?? null) : null,
      };
    }

    let row: MessageRow;
    const carried = attachment;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        if (carried) {
          // The lock a release takes (storage-lock.ts): a release that began
          // first has marked the file given up, and this send is refused; a
          // send that commits first makes the file the message's, and a
          // release then answers 409 and leaves it (FIX-104 round 2).
          await lockStorageQuota(tx, me);
          const fresh = await tx.storageObject.findUnique({
            where: { key: carried.attachmentKey },
            select: { status: true, releasedAt: true, removingAt: true },
          });
          if (
            !fresh ||
            fresh.status === 'abandoned' ||
            fresh.releasedAt ||
            fresh.removingAt
          ) {
            throw new BadRequestException(
              'That attachment was not uploaded for a chat. Upload it again.',
            );
          }
        }
        const created = await tx.chatMessage.create({
          data: {
            conversationId: chatId,
            senderWawuId: me,
            kind,
            text: dto.text ?? null,
            clientMessageId: dto.clientMessageId ?? null,
            ...(attachment ?? {}),
          },
        });
        await tx.chatConversation.update({
          where: { id: chatId },
          data: { lastActivityAt: created.createdAt },
        });
        // Sending is reading: everything up to your own message has been
        // seen, so it never counts as unread for you.
        await this.advanceMark(tx, chatId, me, created);
        return created;
      });
      // After the commit, so a listener that hydrates the message finds it.
      await this.live.publish({
        kind: 'chat.message',
        chatId,
        messageId: row.id,
      });
    } catch (e) {
      // The same clientMessageId sent twice at the same moment: the first
      // insert won, and its message is the answer to both.
      if (!isUniqueViolation(e) || dto.clientMessageId === undefined) throw e;
      row = await this.prisma.chatMessage.findUniqueOrThrow({
        where: {
          conversationId_senderWawuId_clientMessageId: {
            conversationId: chatId,
            senderWawuId: me,
            clientMessageId: dto.clientMessageId,
          },
        },
      });
    }
    return this.toMessageWithMarks(me, row);
  }

  /**
   * POST /chats/:chatId/read: move the caller's read mark up to `messageId`,
   * or to the newest message when it is left out. A mark never moves back.
   */
  async markRead(
    me: string,
    chatId: string,
    dto: MarkChatReadDto,
  ): Promise<ChatReadMark> {
    await this.conversationFor(me, chatId);
    const target = dto.messageId
      ? await this.prisma.chatMessage.findFirst({
          where: { id: dto.messageId, conversationId: chatId },
        })
      : await this.prisma.chatMessage.findFirst({
          where: { conversationId: chatId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
    if (dto.messageId && !target) {
      throw new NotFoundException('That message is not in this chat.');
    }
    if (target && (await this.advanceMark(this.prisma, chatId, me, target))) {
      await this.live.publish({ kind: 'chat.read', chatId, readerWawuId: me });
    }

    const marks = (await this.readMarks(me, [chatId])).get(chatId);
    const unread = await this.unreadCounts(
      me,
      [chatId],
      new Map([[chatId, marks]]),
    );
    return {
      chatId,
      lastReadAt: marks?.mine?.toISOString() ?? null,
      lastReadMessageId: marks?.mineMessageId ?? null,
      unreadCount: unread.get(chatId) ?? 0,
    };
  }

  /**
   * POST /chats/:chatId/attachments: a presigned upload for one photo, video
   * or PDF, checked against the chat and any block before anything is signed.
   */
  async presignAttachment(
    me: string,
    chatId: string,
    dto: ChatUploadDto,
  ): Promise<ChatUpload> {
    const chat = await this.conversationFor(me, chatId);
    await this.assertCanMessage(me, this.otherOf(chat, me));

    // The DTO has already held contentType to the chat folders' types.
    const folder = folderFor(dto.contentType);
    if (
      folder === 'chat/file' &&
      dto.contentLength > CHAT_LIMITS.fileMaxBytes
    ) {
      throw new PayloadTooLargeException(
        `A file in a chat can be up to ${CHAT_LIMITS.fileMaxBytes / (1024 * 1024)} MB.`,
      );
    }
    if (
      folder === 'chat/media' &&
      dto.contentLength > CHAT_LIMITS.mediaMaxBytes
    ) {
      throw new PayloadTooLargeException(
        `A photo or video in a chat can be up to ${CHAT_LIMITS.mediaMaxBytes / (1024 * 1024)} MB.`,
      );
    }
    const { uploadUrl, key } = await this.storage.presignUpload(
      me,
      folder,
      dto.contentType,
      '',
      dto.contentLength,
    );
    return { uploadUrl, key };
  }

  /**
   * GET /chats/attachment-rules: what a chat takes, so the app prints the
   * Hub's numbers and never its own. The same constants the upload check uses.
   */
  attachmentRules(): ChatAttachmentRules {
    return {
      media: {
        contentTypes: [...CHAT_FOLDER_CONTENT_TYPES['chat/media']],
        maxBytes: CHAT_LIMITS.mediaMaxBytes,
      },
      file: {
        contentTypes: [...CHAT_FOLDER_CONTENT_TYPES['chat/file']],
        maxBytes: CHAT_LIMITS.fileMaxBytes,
      },
    };
  }

  /**
   * GET /chats/:chatId/messages/:messageId/attachment: a fresh link to one
   * message's file. Only the two people in the chat get one: anyone else, a
   * message of another chat and a message with no file all answer 404, so ids
   * reveal nothing. The link lives CHAT_LIMITS.linkSeconds.
   */
  async attachmentLink(
    me: string,
    chatId: string,
    messageId: string,
  ): Promise<ChatAttachmentLink> {
    await this.conversationFor(me, chatId);
    const row = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, conversationId: chatId },
    });
    if (!row || !row.attachmentKey || !row.attachmentContentType) {
      throw new NotFoundException('Attachment not found.');
    }
    const url = await this.signedUrl(row.attachmentKey, row.kind);
    if (!url) {
      throw new ServiceUnavailableException(
        'We could not open that file just now. Try again.',
      );
    }
    return {
      url,
      expiresAt: new Date(
        Date.now() + CHAT_LIMITS.linkSeconds * 1000,
      ).toISOString(),
      contentType: row.attachmentContentType,
      name: row.attachmentName,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * The chat, if the caller is in it. Someone else's chat answers 404 exactly
   * as a chat that does not exist, so ids reveal nothing.
   */
  private async conversationFor(
    me: string,
    chatId: string,
  ): Promise<ConversationRow> {
    const row = await this.prisma.chatConversation.findFirst({
      where: {
        id: chatId,
        OR: [{ userAWawuId: me }, { userBWawuId: me }],
      },
    });
    if (!row) throw new NotFoundException('Chat not found.');
    return row;
  }

  private otherOf(chat: ConversationRow, me: string): string {
    return chat.userAWawuId === me ? chat.userBWawuId : chat.userAWawuId;
  }

  private async assertCanMessage(me: string, other: string): Promise<void> {
    if (await this.blocks.isBlockedEitherWay(me, other)) {
      throw new ForbiddenException({
        message: BLOCKED_MESSAGE,
        reason: { code: 'chat_blocked' },
      });
    }
  }

  /**
   * Someone this service or WAWU ID knows. Many people never write a Hub
   * profile, so WAWU ID is asked when there is none.
   */
  private async assertPersonExists(wawuId: string): Promise<void> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: wawuId },
      select: { wawuUserId: true },
    });
    if (profile) return;
    const identities = await this.wawuId.lookupPublicIdentities([wawuId]);
    if (!identities.has(wawuId)) {
      throw new NotFoundException('We could not find that account.');
    }
  }

  /**
   * Moves a read mark forward to `message`, never back. True when it moved.
   * `readAt` is when it moved, which the live catch-up (INBOX-02) reads to
   * tell which read marks changed since a cursor.
   */
  private async advanceMark(
    db: Pick<PrismaService, 'chatParticipant'>,
    chatId: string,
    me: string,
    message: { id: string; createdAt: Date },
  ): Promise<boolean> {
    const { count } = await db.chatParticipant.updateMany({
      where: {
        conversationId: chatId,
        wawuUserId: me,
        // Messages are ordered by (createdAt, id), so two sent in the same
        // millisecond are told apart by id; the mark follows that order.
        OR: [
          { lastReadAt: null },
          { lastReadAt: { lt: message.createdAt } },
          {
            lastReadAt: message.createdAt,
            lastReadMessageId: { lt: message.id },
          },
        ],
      },
      data: {
        lastReadAt: message.createdAt,
        lastReadMessageId: message.id,
        readAt: new Date(),
      },
    });
    return count > 0;
  }

  private async readMarks(
    me: string,
    chatIds: string[],
  ): Promise<Map<string, ReadMarks>> {
    const rows = await this.prisma.chatParticipant.findMany({
      where: { conversationId: { in: chatIds } },
    });
    const out = new Map<string, ReadMarks>();
    for (const id of chatIds) {
      out.set(id, {
        mine: null,
        mineMessageId: null,
        other: null,
        otherMessageId: null,
      });
    }
    for (const r of rows) {
      const m = out.get(r.conversationId)!;
      if (r.wawuUserId === me) {
        m.mine = r.lastReadAt;
        m.mineMessageId = r.lastReadMessageId;
      } else {
        m.other = r.lastReadAt;
        m.otherMessageId = r.lastReadMessageId;
      }
    }
    return out;
  }

  private async unreadCounts(
    me: string,
    chatIds: string[],
    marks: Map<string, ReadMarks | undefined>,
  ): Promise<Map<string, number>> {
    const counts = await Promise.all(
      chatIds.map(async (id) => {
        const m = marks.get(id);
        const n = await this.prisma.chatMessage.count({
          where: {
            conversationId: id,
            senderWawuId: { not: me },
            ...(m?.mine
              ? {
                  OR: [
                    { createdAt: { gt: m.mine } },
                    {
                      createdAt: m.mine,
                      id: { gt: m.mineMessageId ?? '' },
                    },
                  ],
                }
              : {}),
          },
        });
        return [id, n] as const;
      }),
    );
    return new Map(counts);
  }

  private async summaries(
    me: string,
    rows: ConversationRow[],
  ): Promise<ChatSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const others = rows.map((r) => this.otherOf(r, me));
    const [people, marks, lastMessages, blockedPairs] = await Promise.all([
      this.people(others),
      this.readMarks(me, ids),
      Promise.all(
        ids.map((id) =>
          this.prisma.chatMessage.findFirst({
            where: { conversationId: id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        ),
      ),
      this.prisma.blockedAccount.findMany({
        where: {
          OR: [
            { userWawuId: me, blockedWawuId: { in: others } },
            { userWawuId: { in: others }, blockedWawuId: me },
          ],
        },
        select: { userWawuId: true, blockedWawuId: true },
      }),
    ]);
    const blocked = new Set(
      blockedPairs.map((b) =>
        b.userWawuId === me ? b.blockedWawuId : b.userWawuId,
      ),
    );
    const unread = await this.unreadCounts(me, ids, marks);

    return Promise.all(
      rows.map(async (r, i) => {
        const other = others[i];
        const m = marks.get(r.id);
        const last = lastMessages[i];
        return {
          id: r.id,
          other: people.get(other)!,
          createdAt: r.createdAt.toISOString(),
          lastActivityAt: r.lastActivityAt.toISOString(),
          lastMessage: last ? await this.toMessage(me, last, m) : null,
          unreadCount: unread.get(r.id) ?? 0,
          myLastReadAt: m?.mine?.toISOString() ?? null,
          otherLastReadAt: m?.other?.toISOString() ?? null,
          canMessage: !blocked.has(other),
        };
      }),
    );
  }

  /**
   * Names, handles, avatars and ticks for the other people in a page of
   * chats: one WAWU ID call and one profile query per page, the same way the
   * blocked list and community messages read people.
   */
  async people(ids: string[]): Promise<Map<string, ChatPerson>> {
    const unique = [...new Set(ids)].filter((id) => !isSupportAccount(id));
    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const out = new Map<string, ChatPerson>();
    for (const id of unique) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        wawuId: id,
        name: fullName || profile?.handle || '',
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        verification: deriveVerificationState(profile ?? null),
      });
    }
    // The support side of a support thread has no WAWU ID and no profile.
    for (const id of ids) {
      if (isSupportAccount(id)) out.set(id, supportPerson());
    }
    return out;
  }

  /**
   * Messages as `viewer` sees them (INBOX-02): the live push and the
   * catch-up. The viewer must be in each message's chat; a row from a chat
   * they are not in is left out rather than shown.
   */
  async viewMessages(
    viewer: string,
    rows: MessageRow[],
  ): Promise<ChatMessage[]> {
    if (rows.length === 0) return [];
    const chatIds = [...new Set(rows.map((r) => r.conversationId))];
    const mine = await this.prisma.chatConversation.findMany({
      where: {
        id: { in: chatIds },
        OR: [{ userAWawuId: viewer }, { userBWawuId: viewer }],
      },
      select: { id: true },
    });
    const allowed = new Set(mine.map((c) => c.id));
    const marks = await this.readMarks(viewer, [...allowed]);
    return Promise.all(
      rows
        .filter((r) => allowed.has(r.conversationId))
        .map((r) => this.toMessage(viewer, r, marks.get(r.conversationId))),
    );
  }

  private async toMessageWithMarks(
    me: string,
    row: MessageRow,
  ): Promise<ChatMessage> {
    const marks = await this.readMarks(me, [row.conversationId]);
    return this.toMessage(me, row, marks.get(row.conversationId));
  }

  private async toMessage(
    me: string,
    row: MessageRow,
    marks: ReadMarks | undefined,
  ): Promise<ChatMessage> {
    const mine = row.senderWawuId === me;
    const otherRead = marks?.other ?? null;
    const otherReadId = marks?.otherMessageId ?? '';
    const request =
      row.kind === MONEY_REQUEST_MESSAGE_KIND
        ? await this.prisma.moneyRequest.findUnique({
            where: { messageId: row.id },
          })
        : null;
    return {
      id: row.id,
      chatId: row.conversationId,
      senderWawuId: row.senderWawuId,
      mine,
      kind: row.kind as ChatMessageKind,
      text: row.text,
      attachment:
        row.attachmentKey && row.attachmentContentType
          ? {
              url: await this.signedUrl(row.attachmentKey, row.kind),
              contentType: row.attachmentContentType,
              bytes: row.attachmentBytes ?? 0,
              name: row.attachmentName,
            }
          : null,
      moneyRequest: request ? toMoneyRequestView(request, me) : null,
      clientMessageId: mine ? row.clientMessageId : null,
      createdAt: row.createdAt.toISOString(),
      readState: mine
        ? otherRead &&
          (otherRead.getTime() > row.createdAt.getTime() ||
            (otherRead.getTime() === row.createdAt.getTime() &&
              otherReadId >= row.id))
          ? 'read'
          : 'sent'
        : null,
    };
  }

  /**
   * A fresh link on every read, good for CHAT_LIMITS.linkSeconds. Photos and
   * videos open in place; a PDF is a download, never rendered inline
   * (StorageService explains why). If storage cannot sign one right now the
   * bubble gets null.
   */
  private async signedUrl(key: string, kind: string): Promise<string | null> {
    if (!this.storage.isConfigured) return null;
    try {
      return kind === 'file'
        ? await this.storage.signedReadUrl(key, CHAT_LIMITS.linkSeconds)
        : await this.storage.readUrlFor(key, CHAT_LIMITS.linkSeconds);
    } catch (e) {
      this.logger.warn(`Could not sign chat attachment ${key}: ${String(e)}`);
      return null;
    }
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { deriveVerificationState } from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { StorageService } from '../storage/storage.service';
import {
  CHAT_LIMITS,
  CHAT_UPLOAD_FOLDERS,
  type ChatUploadFolder,
} from './chat-limits';
import type {
  ChatMessage,
  ChatMessageKind,
  ChatMessagePage,
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

interface ConversationRow {
  id: string;
  userAWawuId: string;
  userBWawuId: string;
  createdAt: Date;
  lastActivityAt: Date;
}

interface MessageRow {
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
  ) {}

  // ── opening and listing ──────────────────────────────────────────────────

  /** POST /chats: the chat with `otherId`, opened now if there was none. */
  async open(me: string, otherId: string): Promise<ChatSummary> {
    if (otherId === me) {
      throw new BadRequestException('You cannot start a chat with yourself.');
    }
    await this.assertPersonExists(otherId);
    await this.assertCanMessage(me, otherId);

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
    const [summary] = await this.summaries(me, [row]);
    return summary;
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
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationId: chatId,
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
      kind = kindFor(stored.contentType);
      attachment = {
        attachmentKey: stored.key,
        attachmentContentType: stored.contentType,
        attachmentBytes: stored.bytes,
        attachmentName: kind === 'file' ? (dto.attachment.name ?? null) : null,
      };
    }

    let row: MessageRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
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
    if (target) await this.advanceMark(this.prisma, chatId, me, target);

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
    const { uploadUrl, key } = await this.storage.presignUpload(
      me,
      folder,
      dto.contentType,
      '',
      dto.contentLength,
    );
    return { uploadUrl, key };
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

  /** Moves a read mark forward to `message`, never back. */
  private async advanceMark(
    db: Pick<PrismaService, 'chatParticipant'>,
    chatId: string,
    me: string,
    message: { id: string; createdAt: Date },
  ): Promise<void> {
    await db.chatParticipant.updateMany({
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
      data: { lastReadAt: message.createdAt, lastReadMessageId: message.id },
    });
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
  private async people(ids: string[]): Promise<Map<string, ChatPerson>> {
    const unique = [...new Set(ids)];
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
    return out;
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
   * A fresh link on every read. Photos and videos open in place; a PDF is a
   * short-lived download, never rendered inline (StorageService explains
   * why). If storage cannot sign one right now the bubble gets null.
   */
  private async signedUrl(key: string, kind: string): Promise<string | null> {
    if (!this.storage.isConfigured) return null;
    try {
      return kind === 'file'
        ? await this.storage.signedReadUrl(key)
        : await this.storage.readUrlFor(key);
    } catch (e) {
      this.logger.warn(`Could not sign chat attachment ${key}: ${String(e)}`);
      return null;
    }
  }
}

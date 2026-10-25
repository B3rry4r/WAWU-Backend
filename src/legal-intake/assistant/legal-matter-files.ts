import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CHAT_FOLDER_CONTENT_TYPES,
  CHAT_LIMITS,
  CHAT_UPLOAD_FOLDERS,
  type ChatUploadFolder,
} from '../../chat/chat-limits';
import { lockStorageQuota } from '../../storage/storage-lock';
import { StorageService } from '../../storage/storage.service';
import { refusal, TX_OPTIONS } from './legal-assistant-allowance';
import { LEGAL_MATTER_FILES_MAX } from './legal-assistant-config';
import type {
  LegalAssistantAttachment,
  LegalAssistantUpload,
} from './legal-assistant.types';

/** A matter in these states is finished: nothing more is sent on it. */
const CLOSED = new Set(['delivered', 'cancelled']);

/** The columns a chat line holds for its file. */
export interface LegalFileColumns {
  attachmentKey: string | null;
  attachmentContentType: string | null;
  attachmentBytes: number | null;
  attachmentName: string | null;
}

/** The kind of a file by its type: what the app draws and what the line says. */
function kindOf(contentType: string): 'image' | 'video' | 'file' {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

function folderFor(contentType: string): ChatUploadFolder {
  return contentType === 'application/pdf' ? 'chat/file' : 'chat/media';
}

/** A chat upload of this person's own: `<chat folder>/<their id>/...`. */
function isOwnChatKey(key: string, me: string): boolean {
  return CHAT_UPLOAD_FOLDERS.some((folder) =>
    key.startsWith(`${folder}/${me}/`),
  );
}

/** A name a person can read on a line: no control characters, no path, at most 200. */
// eslint-disable-next-line no-control-regex -- these ranges ARE the control characters being removed
const CONTROL = /[\u0000-\u001f\u007f]/g;
function readableName(name: string | undefined): string | null {
  const cleaned = (name ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const last = cleaned.split(/[\\/]/).pop()?.trim() ?? '';
  return last ? last.slice(0, 200) : null;
}

/** The words the line itself carries, for the model's history and a reader with no picture: "Sent a file: ID.pdf." */
function lineFor(contentType: string, name: string | null): string {
  const kind = kindOf(contentType);
  if (kind === 'image') return 'Sent a photo.';
  if (kind === 'video') return 'Sent a video.';
  return name ? `Sent a file: ${name}.` : 'Sent a file.';
}

/**
 * Files on a legal matter's chat (R2-LEGAL3). A fixed-price matter such as
 * "Register a business" needs an ID, name options and an address before the
 * work starts, and the person sends them from the Legal chat.
 *
 * Nothing new is stored anywhere new: the file goes through the Hub's chat
 * upload path (FIX-104: the `chat/media` and `chat/file` folders, the same
 * types and sizes, the same storage allowance and the same give-back of an
 * upload no line carries), and a line on the matter's thread names it. The key
 * is also appended to `LegalRequest.documents`, which is where the consultant
 * reads what the person handed over. A line is a client line with no words for
 * the assistant to answer, so a file is never a paid assistant call.
 */
@Injectable()
export class LegalMatterFiles {
  private readonly logger = new Logger(LegalMatterFiles.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Where to upload one file for the matter, checked before anything is signed. */
  async presign(
    wawuUserId: string,
    requestId: string,
    contentType: string,
    contentLength: number,
  ): Promise<LegalAssistantUpload> {
    await this.assertOpen(requestId, wawuUserId);
    const folder = folderFor(contentType);
    if (folder === 'chat/file' && contentLength > CHAT_LIMITS.fileMaxBytes) {
      throw new PayloadTooLargeException(
        `A file in a chat can be up to ${CHAT_LIMITS.fileMaxBytes / (1024 * 1024)} MB.`,
      );
    }
    if (folder === 'chat/media' && contentLength > CHAT_LIMITS.mediaMaxBytes) {
      throw new PayloadTooLargeException(
        `A photo or video in a chat can be up to ${CHAT_LIMITS.mediaMaxBytes / (1024 * 1024)} MB.`,
      );
    }
    const { uploadUrl, key } = await this.storage.presignUpload(
      wawuUserId,
      folder,
      contentType,
      '',
      contentLength,
    );
    return { uploadUrl, key };
  }

  /**
   * Puts a file the person uploaded on the matter: one client line carrying
   * it, and its key on the matter's documents. Sending the same key again
   * changes nothing. The upload is checked as a chat checks one (the person's
   * own key, in a chat folder, finished uploading, not given back) and again
   * under the person's storage lock, so a give-back that began first wins and
   * a send that commits first makes the file the line's.
   */
  async send(
    wawuUserId: string,
    requestId: string,
    attachment: { key: string; name?: string },
  ): Promise<void> {
    await this.assertOpen(requestId, wawuUserId);
    const key = attachment.key;
    const notYours = () =>
      new BadRequestException(
        'That attachment was not uploaded for a chat. Upload it again.',
      );
    const stored = isOwnChatKey(key, wawuUserId)
      ? await this.prisma.storageObject.findUnique({ where: { key } })
      : null;
    if (
      !stored ||
      stored.wawuUserId !== wawuUserId ||
      stored.status === 'abandoned'
    ) {
      throw notYours();
    }
    // A key signed for and never PUT must not become a line the consultant
    // cannot open. The bucket is asked once for a pending row, holding nothing.
    if (!(await this.storage.confirmUpload(stored))) {
      throw new BadRequestException(
        'That file did not finish uploading. Try sending it again.',
      );
    }
    const contentType = stored.contentType;
    const allowed =
      CHAT_FOLDER_CONTENT_TYPES[folderFor(contentType)].includes(contentType);
    if (!allowed) throw notYours();
    const name =
      kindOf(contentType) === 'file' ? readableName(attachment.name) : null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockStorageQuota(tx, wawuUserId);
        const fresh = await tx.storageObject.findUnique({
          where: { key },
          select: { status: true, releasedAt: true, removingAt: true },
        });
        if (
          !fresh ||
          fresh.status === 'abandoned' ||
          fresh.releasedAt ||
          fresh.removingAt
        ) {
          throw notYours();
        }
        const already = await tx.legalChatMessage.findUnique({
          where: { attachmentKey: key },
          select: { legalRequestId: true },
        });
        if (already) {
          // The same send again (a lost answer): the line is there already.
          if (already.legalRequestId === requestId) return;
          throw notYours();
        }
        const current = await tx.legalRequest.findUnique({
          where: { id: requestId },
          select: { status: true, wawuUserId: true },
        });
        if (
          !current ||
          current.wawuUserId !== wawuUserId ||
          CLOSED.has(current.status)
        ) {
          throw this.closed();
        }
        const held = await tx.legalChatMessage.count({
          where: { legalRequestId: requestId, attachmentKey: { not: null } },
        });
        if (held >= LEGAL_MATTER_FILES_MAX) throw this.full();
        await tx.legalChatMessage.create({
          data: {
            legalRequestId: requestId,
            authorRole: 'client',
            body: lineFor(contentType, name),
            attachmentKey: key,
            attachmentContentType: contentType,
            attachmentBytes: stored.bytes,
            attachmentName: name,
          },
        });
        await tx.legalRequest.update({
          where: { id: requestId },
          data: { documents: { push: key } },
        });
      }, TX_OPTIONS);
    } catch (error) {
      // Two sends of one key at once: the first won, and its line answers both.
      if ((error as { code?: unknown })?.code === 'P2002') return;
      throw error;
    }
  }

  /** What a line shows of its file, with a fresh link; null for a line of words. */
  async view(row: LegalFileColumns): Promise<LegalAssistantAttachment | null> {
    if (!row.attachmentKey || !row.attachmentContentType) return null;
    return {
      url: await this.linkFor(row.attachmentKey, row.attachmentContentType),
      contentType: row.attachmentContentType,
      bytes: row.attachmentBytes ?? 0,
      name: row.attachmentName,
    };
  }

  /**
   * A fresh link, good for CHAT_LIMITS.linkSeconds. A picture or video opens in
   * place; a PDF is a download, never rendered inline (StorageService explains
   * why). Null when storage cannot sign one right now.
   */
  private async linkFor(
    key: string,
    contentType: string,
  ): Promise<string | null> {
    if (!this.storage.isConfigured) return null;
    try {
      return kindOf(contentType) === 'file'
        ? await this.storage.signedReadUrl(key, CHAT_LIMITS.linkSeconds)
        : await this.storage.readUrlFor(key, CHAT_LIMITS.linkSeconds);
    } catch (e) {
      this.logger.warn(`Could not sign matter file ${key}: ${String(e)}`);
      return null;
    }
  }

  /** The matter is the person's, is open, and has room for a file. */
  private async assertOpen(requestId: string, wawuUserId: string) {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
      select: { status: true, wawuUserId: true },
    });
    if (
      !request ||
      request.wawuUserId !== wawuUserId ||
      CLOSED.has(request.status)
    ) {
      throw this.closed();
    }
    const held = await this.prisma.legalChatMessage.count({
      where: { legalRequestId: requestId, attachmentKey: { not: null } },
    });
    if (held >= LEGAL_MATTER_FILES_MAX) throw this.full();
    return request;
  }

  private closed() {
    return refusal(
      HttpStatus.CONFLICT,
      'matter_closed',
      'This request is finished, so no more files can be sent on it.',
    );
  }

  private full() {
    return refusal(
      HttpStatus.CONFLICT,
      'matter_files_full',
      `A request can hold up to ${LEGAL_MATTER_FILES_MAX} files.`,
    );
  }
}

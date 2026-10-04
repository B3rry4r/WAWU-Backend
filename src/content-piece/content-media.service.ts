import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService, objectKeyFrom } from '../storage/storage.service';
import { ContentPieceService } from './content-piece.service';
import type { SetMediaDto } from './dto/set-media.dto';

/**
 * One picture of a photo set. `url` is null, and `locked` true, for a frame
 * the viewer has not unlocked. Frame 1 is always shown: it is the piece's own
 * preview asset, which is public already.
 */
export interface MediaFrame {
  /** 1-based, the order the pictures are shown in. */
  position: number;
  url: string | null;
  locked: boolean;
}

/**
 * What a card or a detail screen needs to draw the media itself: how long it
 * runs, how many pages it has, and the ordered pictures of a photo set.
 * `frames` is empty for anything that is not a photo set.
 */
export interface MediaDetails {
  contentId: string;
  contentType: string;
  /** `4:12`, or null when the creator has not stated one. */
  durationLabel: string | null;
  /** Null when the creator has not stated one, and for non-PDFs. */
  pageCount: number | null;
  /** Number of pictures in the set; 0 for anything else. */
  frameCount: number;
  frames: MediaFrame[];
}

/**
 * Whether `key` is an object key of the grammar `presignUpload` writes
 * (`content/<preview|full>/<wawuId>/<uuid>.<ext>`) under THIS person's own
 * prefix. Same shape of check as chat's `isChatKey`.
 */
export function isOwnContentKey(key: string, wawuId: string): boolean {
  if (key.includes('..') || key.includes('//')) return false;
  const parts = key.split('/');
  return (
    parts.length === 4 &&
    parts[0] === 'content' &&
    (parts[1] === 'preview' || parts[1] === 'full') &&
    parts[2] === wawuId &&
    /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(parts[3])
  );
}

/** The fields of a piece MediaDetails is built from. */
export interface MediaSource {
  id: string;
  contentType: string;
  durationLabel: string | null;
  pageCount: number | null;
  previewAssetUrl: string;
  fullAssetLocked: boolean;
}

/**
 * Photo-set frames, durations and page counts (HOME-05).
 *
 * `durationLabel` and `pageCount` were columns nothing could write (only the
 * seed set them), and a photo set had no pictures beyond its two asset urls.
 * `PUT /content/:id/media` is the writer; every reader (the feed card, the
 * creator card's strip, `GET /content/:id/media`) goes through `forPieces`, so
 * the lock rule is decided once.
 */
@Injectable()
export class ContentMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly content: ContentPieceService,
  ) {}

  /**
   * MediaDetails for a batch of pieces, in the order given. One read for every
   * photo set in the batch. A locked set shows its count and frame 1 only.
   */
  async forPieces(pieces: MediaSource[]): Promise<Map<string, MediaDetails>> {
    const out = new Map<string, MediaDetails>();
    const imageIds = pieces
      .filter((p) => p.contentType === 'image')
      .map((p) => p.id);
    const rows = imageIds.length
      ? await this.prisma.contentFrame.findMany({
          where: { contentId: { in: imageIds } },
          orderBy: [{ contentId: 'asc' }, { position: 'asc' }],
        })
      : [];
    const byPiece = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byPiece.get(row.contentId) ?? [];
      list.push(row);
      byPiece.set(row.contentId, list);
    }

    const owners = imageIds.length
      ? new Map(
          (
            await this.prisma.contentPiece.findMany({
              where: { id: { in: imageIds } },
              select: { id: true, creatorWawuId: true },
            })
          ).map((o) => [o.id, o.creatorWawuId]),
        )
      : new Map<string, string>();

    for (const piece of pieces) {
      const owner = owners.get(piece.id) ?? '';
      // Defence in depth: a frame is only ever signed when it is one of the
      // piece owner's own objects, whatever a row happens to hold.
      const stored = (byPiece.get(piece.id) ?? []).filter((f) =>
        isOwnContentKey(objectKeyFrom(f.url), owner),
      );
      const frames: MediaFrame[] = await Promise.all(
        stored.map(async (f, i) => {
          if (!piece.fullAssetLocked) {
            return {
              position: f.position,
              url: await this.storage.freshUrlFor(f.url),
              locked: false,
            };
          }
          return i === 0
            ? {
                position: f.position,
                url: piece.previewAssetUrl,
                locked: false,
              }
            : { position: f.position, url: null, locked: true };
        }),
      );
      out.set(piece.id, {
        contentId: piece.id,
        contentType: piece.contentType,
        durationLabel: piece.durationLabel,
        pageCount: piece.pageCount,
        frameCount: frames.length,
        frames,
      });
    }
    return out;
  }

  /** GET /content/:id/media: whoever may read the piece may read this. */
  async get(contentId: string, viewerWawuId: string): Promise<MediaDetails> {
    const piece = await this.content.findOne(contentId, viewerWawuId);
    const map = await this.forPieces([piece]);
    return map.get(piece.id) as MediaDetails;
  }

  /**
   * Each frame must be an upload this person made: the url or key resolves to
   * their own `content/` key and a StorageObject row of theirs that is not
   * abandoned (the chat attachment rule). The key is what is stored, so the
   * read path signs it fresh. Anything else is a 400.
   */
  private async ownedFrameKeys(
    values: string[],
    ownerWawuId: string,
  ): Promise<string[]> {
    const keys = values.map((v) => objectKeyFrom(v));
    if (!keys.every((k) => isOwnContentKey(k, ownerWawuId))) {
      throw new BadRequestException(
        'Every frame must be a picture you uploaded.',
      );
    }
    const rows = await this.prisma.storageObject.findMany({
      where: {
        key: { in: keys },
        wawuUserId: ownerWawuId,
        status: { not: 'abandoned' },
      },
      select: { key: true },
    });
    const found = new Set(rows.map((r) => r.key));
    if (!keys.every((k) => found.has(k))) {
      throw new BadRequestException(
        'Every frame must be a picture you uploaded.',
      );
    }
    return keys;
  }

  /**
   * PUT /content/:id/media: the owner states the media details. Each field
   * only fits some types, and a field that does not fit is refused rather than
   * stored where nothing will ever read it.
   */
  async set(
    contentId: string,
    ownerWawuId: string,
    dto: SetMediaDto,
  ): Promise<MediaDetails> {
    if (
      dto.frames === undefined &&
      dto.durationLabel === undefined &&
      dto.pageCount === undefined
    ) {
      throw new BadRequestException('Send frames, durationLabel or pageCount.');
    }
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        creatorWawuId: true,
        contentType: true,
        status: true,
      },
    });
    if (!piece || piece.status === 'removed') {
      throw new NotFoundException('Content not found');
    }
    if (piece.creatorWawuId !== ownerWawuId) {
      throw new ForbiddenException('Only the creator can change this piece.');
    }
    if (dto.frames !== undefined && piece.contentType !== 'image') {
      throw new BadRequestException('Only a photo set has frames.');
    }
    if (dto.pageCount !== undefined && piece.contentType !== 'pdf') {
      throw new BadRequestException('Only a PDF has a page count.');
    }
    if (
      dto.durationLabel !== undefined &&
      !['video', 'audio', 'course'].includes(piece.contentType)
    ) {
      throw new BadRequestException(
        'Only a video, audio or course has a duration.',
      );
    }

    const frames = dto.frames
      ? await this.ownedFrameKeys(dto.frames, ownerWawuId)
      : undefined;
    await this.prisma.$transaction(async (tx) => {
      if (dto.durationLabel !== undefined || dto.pageCount !== undefined) {
        await tx.contentPiece.update({
          where: { id: contentId },
          data: {
            ...(dto.durationLabel !== undefined
              ? { durationLabel: dto.durationLabel }
              : {}),
            ...(dto.pageCount !== undefined
              ? { pageCount: dto.pageCount }
              : {}),
          },
        });
      }
      if (frames !== undefined) {
        await tx.contentFrame.deleteMany({ where: { contentId } });
        await tx.contentFrame.createMany({
          data: frames.map((url, i) => ({
            contentId,
            position: i + 1,
            url,
          })),
        });
      }
    });
    return this.get(contentId, ownerWawuId);
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { LOCKED_TX, inPersonsTurn } from '../storage/storage-lock';
import { StorageService, objectKeyFrom } from '../storage/storage.service';
import { ContentPieceService } from './content-piece.service';
import { assertOwnUploadsUsable } from './own-uploads';
import type { SetLessonsDto } from './dto/set-lessons.dto';

/**
 * How long a lesson's link lives. Short, and fresh for every play (the app asks again each time a lesson is opened), but long
 * enough that a person who seeks around a long lesson is not cut off: the bucket checks the link on every range it serves.
 */
export const LESSON_LINK_SECONDS = 3600;

/**
 * How many lessons of a course anyone may play without buying it (H25: "lesson 01 tagged Free, the rest locked").
 * The first lesson is always free; a creator's own preview setting (`PUT /content/:id/preview`, `freeLessons`) opens more.
 * A course of one lesson has none free, or the whole course would be free. Always fewer than the lessons there are.
 */
export function freeLessonCount(
  preview: number | null,
  lessonCount: number,
): number {
  if (lessonCount < 2) return 0;
  return Math.min(lessonCount - 1, Math.max(preview ?? 0, 1));
}

/** One lesson as the creator sees it after setting them. */
export interface LessonView {
  id: string;
  title: string;
  order: number;
  durationLabel: string | null;
  /** True when the lesson has a file to play. */
  hasFile: boolean;
}

/** What the player needs to start one lesson. */
export interface LessonPlay {
  contentId: string;
  lessonId: string;
  /** A fresh signed link to the lesson's file. */
  url: string;
  /** When the link stops working (ISO 8601 UTC). */
  expiresAt: string;
  durationLabel: string | null;
}

const NOT_FOUND_LESSON = 'Lesson not found.';
const BAD_FILE = 'Every lesson file must be a file you uploaded.';

/**
 * Course lessons, one file each (FIX-107, H25; G-HOME-08-2, G-121).
 *
 * `GET /content/:id/lessons/:lessonId/play` is the Hub deciding who may watch: a free lesson plays for anyone who may open
 * the piece; any other lesson plays for the piece's creator and for a person with a completed purchase of the course (the
 * "unlock" every other file of a piece follows, `fullAssetLocked`). The link is signed here, short-lived, and never stored.
 * `PUT /content/:id/lessons` is the creator's writer: the list, the order and each lesson's file.
 */
@Injectable()
export class CourseLessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly content: ContentPieceService,
  ) {}

  /** GET /content/:id/lessons/:lessonId/play. */
  async play(
    contentId: string,
    lessonId: string,
    viewerWawuId: string,
  ): Promise<LessonPlay> {
    // The piece's own visibility rules (removed, not live, blocked): a piece the viewer may not open is the same 404.
    const piece = await this.content.findOne(contentId, viewerWawuId);
    if (piece.contentType !== 'course') {
      throw new NotFoundException(NOT_FOUND_LESSON);
    }
    const [lessons, detail] = await Promise.all([
      this.prisma.courseLesson.findMany({
        where: { contentId },
        orderBy: { order: 'asc' },
        select: { id: true, durationLabel: true, assetKey: true },
      }),
      this.prisma.contentDetail.findUnique({
        where: { contentId },
        select: { freePreviewLessons: true },
      }),
    ]);
    const index = lessons.findIndex((l) => l.id === lessonId);
    if (index < 0) throw new NotFoundException(NOT_FOUND_LESSON);
    const lesson = lessons[index];

    const free =
      piece.accessType === 'free' ||
      index <
        freeLessonCount(detail?.freePreviewLessons ?? null, lessons.length);
    // `fullAssetLocked` is false for free content, the creator, and anyone with a completed purchase.
    if (!free && piece.fullAssetLocked) {
      throw new ForbiddenException('Unlock the course to watch this lesson.');
    }
    if (!lesson.assetKey) {
      throw new NotFoundException('This lesson has no video yet.');
    }
    const url = await this.storage.readUrlFor(
      objectKeyFrom(lesson.assetKey),
      LESSON_LINK_SECONDS,
    );
    return {
      contentId,
      lessonId,
      url,
      expiresAt: new Date(
        Date.now() + LESSON_LINK_SECONDS * 1000,
      ).toISOString(),
      durationLabel: lesson.durationLabel,
    };
  }

  /**
   * PUT /content/:id/lessons: the creator states the whole list. A lesson sent with an `id` is kept (its progress stays);
   * one without is new; one left out is removed, unless people have bought the course (a buyer's lessons never shrink).
   * Each file is an upload of the creator's own, claimed under their storage lock like a listing's file.
   */
  async set(
    contentId: string,
    ownerWawuId: string,
    dto: SetLessonsDto,
  ): Promise<{ lessons: LessonView[] }> {
    const piece = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { creatorWawuId: true, contentType: true, status: true },
    });
    if (!piece || piece.status === 'removed') {
      throw new NotFoundException('Content not found');
    }
    if (piece.creatorWawuId !== ownerWawuId) {
      throw new ForbiddenException('Only the creator can change this piece.');
    }
    if (piece.contentType !== 'course') {
      throw new BadRequestException('Only a course has lessons.');
    }

    const given = dto.lessons;
    const ids = given.flatMap((l) => (l.id ? [l.id] : []));
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('A lesson is listed twice.');
    }
    // `undefined`: the file stays as it is (a kept lesson) or there is none (a new one); `null`: the file is taken off; a string: that file.
    const keys = given.map((l) =>
      l.assetKey === undefined || l.assetKey === null
        ? l.assetKey
        : objectKeyFrom(l.assetKey),
    );
    for (const k of keys) {
      if (typeof k === 'string' && !isOwnFullKey(k, ownerWawuId)) {
        throw new BadRequestException(BAD_FILE);
      }
    }
    const filed = keys.filter((k): k is string => typeof k === 'string');

    await inPersonsTurn(ownerWawuId, () =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.courseLesson.findMany({
          where: { contentId },
          select: { id: true, assetKey: true },
        });
        const have = new Map(existing.map((l) => [l.id, l.assetKey]));
        if (!ids.every((id) => have.has(id))) {
          throw new BadRequestException(
            'A lesson sent with an id must belong to this course.',
          );
        }
        // Only the files that are new to this course need claiming: one already on a lesson of it is claimed already.
        const fresh = filed.filter((k) => ![...have.values()].includes(k));
        if (fresh.length > 0) {
          await assertOwnUploadsUsable(tx, fresh, ownerWawuId, BAD_FILE);
        }
        const dropped = existing.filter((l) => !ids.includes(l.id));
        if (dropped.length > 0) {
          const buyers = await tx.purchase.count({
            where: { contentId, type: 'content', status: 'completed' },
          });
          if (buyers > 0) {
            throw new ConflictException(
              'People have bought this course, so a lesson cannot be taken out of it.',
            );
          }
          await tx.courseLesson.deleteMany({
            where: { id: { in: dropped.map((l) => l.id) } },
          });
        }
        for (const [i, l] of given.entries()) {
          const data = {
            title: l.title.trim(),
            order: i + 1,
            durationLabel: l.durationLabel ?? null,
          };
          const key = keys[i];
          if (l.id) {
            // A kept lesson keeps its file unless a key (a new file) or null (none) was sent.
            await tx.courseLesson.update({
              where: { id: l.id },
              data: key === undefined ? data : { ...data, assetKey: key },
            });
          } else {
            await tx.courseLesson.create({
              data: { contentId, ...data, assetKey: key ?? null },
            });
          }
        }
        // "Updated <month>" on the piece's page moves when its lessons change.
        await tx.contentDetail.upsert({
          where: { contentId },
          create: { contentId, contentUpdatedAt: new Date() },
          update: { contentUpdatedAt: new Date() },
        });
      }, LOCKED_TX),
    );

    const rows = await this.prisma.courseLesson.findMany({
      where: { contentId },
      orderBy: { order: 'asc' },
    });
    return {
      lessons: rows.map((r) => ({
        id: r.id,
        title: r.title,
        order: r.order,
        durationLabel: r.durationLabel,
        hasFile: r.assetKey !== null,
      })),
    };
  }
}

/** The grammar `presignUpload` writes for a full file: `content/full/<wawuId>/<uuid>.<ext>`, under THIS person's own prefix. */
function isOwnFullKey(key: string, wawuId: string): boolean {
  if (key.includes('..') || key.includes('//')) return false;
  const parts = key.split('/');
  return (
    parts.length === 4 &&
    parts[0] === 'content' &&
    parts[1] === 'full' &&
    parts[2] === wawuId &&
    /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(parts[3])
  );
}

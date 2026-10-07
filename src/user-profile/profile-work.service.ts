import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { objectKeyFrom, StorageService } from '../storage/storage.service';
import type {
  CreateProfileWorkDto,
  ListProfileWorksQueryDto,
  ReorderProfileWorksDto,
  UpdateProfileWorkDto,
} from './dto/profile-work.dto';
import {
  FIRST_YEAR,
  MAX_WORKS,
  MAX_WORK_MEDIA,
  WORK_CATEGORY_MAX,
  WORK_CLIENT_MAX,
  WORK_DESCRIPTION_MAX,
  WORK_ROLE_MAX,
  WORK_TITLE_MAX,
  assertYear,
  cleanLink,
  cleanText,
  isOwnWorkKey,
  latestWorkYear,
  requiredText,
  workMediaKind,
} from './profile-works';
import {
  isSafeLookupKey,
  ProfileAudienceService,
} from './profile-audience.service';
import type {
  ProfileWorkCategoryView,
  ProfileWorkDetailView,
  ProfileWorkOwnerView,
  ProfileWorkView,
  ProfileWorksView,
} from './profile-work.type';

const WORK_NOT_FOUND = 'Work not found';
const MEDIA_REFUSED = 'Every picture or video must be one you uploaded.';

type WorkRow = {
  id: string;
  wawuUserId: string;
  title: string;
  role: string;
  client: string | null;
  year: number;
  link: string | null;
  category: string | null;
  description: string | null;
  media: string[];
  position: number;
  createdAt: Date;
};

/**
 * Featured works (ME-16): what a creator shows under "Featured works" on M33,
 * lists on M34, opens on M35 and adds on M36.
 *
 * ── WHO MAY WRITE ──────────────────────────────────────────────────────────
 *
 * Only the owner, and every write names the owner from the token: there is no
 * parameter that could point it at somebody else's work. An id that is not
 * yours is a 404 exactly like an id that does not exist (the `where` carries
 * both keys, so there is no moment where the row was read and then trusted).
 *
 * ── WHO MAY READ ───────────────────────────────────────────────────────────
 *
 * Whoever may see the profile: see ProfileAudienceService.
 *
 * ── ORDER AND THE CAP ──────────────────────────────────────────────────────
 *
 * `position` is the owner's chosen order. A new work goes first and the rest
 * move down. Create, delete and reorder each run inside one transaction that
 * holds a per-person advisory lock, so two requests from the same person
 * (a double tap, two tabs) are taken one at a time: never two works in one
 * slot, never fifty-one works.
 */
@Injectable()
export class ProfileWorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audience: ProfileAudienceService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /**
   * Whose works these are (ME-11): the name from WAWU ID, the handle and the
   * picture from the profile. Public-safe fields only, the same four the feed's
   * creator line serves. An identity service that does not answer degrades the
   * name to the handle (`lookupPublicIdentities` returns nothing, never throws).
   */
  private async ownerView(owner: string): Promise<ProfileWorkOwnerView> {
    const [profile, identities] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: owner },
        select: { handle: true, avatarUrl: true },
      }),
      this.wawuId.lookupPublicIdentities([owner]),
    ]);
    const identity = identities.get(owner);
    const name = [identity?.firstName, identity?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      wawuId: owner,
      displayName: name || profile?.handle || null,
      handle: profile?.handle ?? null,
      avatarUrl: await this.storage.freshUrlFor(profile?.avatarUrl ?? null),
    };
  }

  /** One person at a time on their own list. */
  private async lock(
    tx: Prisma.TransactionClient,
    owner: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`profile-work:${owner}`}, 0))`;
  }

  /**
   * Each entry must be an upload this person made, into the `profile/work`
   * folder, and one that has really landed in storage: the key (or the
   * `fileUrl` the presigner returned) resolves to a key under their own id, a
   * StorageObject row of theirs for that folder is not abandoned, and the
   * bucket has the object (`confirmUpload`). What is stored is the key.
   */
  private async ownedMedia(values: string[], owner: string): Promise<string[]> {
    const keys: string[] = [];
    for (const value of values) {
      const key = objectKeyFrom(value);
      if (!isOwnWorkKey(key, owner))
        throw new BadRequestException(MEDIA_REFUSED);
      if (!keys.includes(key)) keys.push(key);
    }
    if (keys.length === 0) return [];
    const rows = await this.prisma.storageObject.findMany({
      where: {
        key: { in: keys },
        wawuUserId: owner,
        folder: 'profile/work',
        status: { not: 'abandoned' },
      },
      select: { id: true, key: true, status: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const key of keys) {
      const row = byKey.get(key);
      if (!row || !(await this.storage.confirmUpload(row))) {
        throw new BadRequestException(MEDIA_REFUSED);
      }
    }
    return keys;
  }

  private async toView(row: WorkRow): Promise<ProfileWorkView> {
    // Defence in depth: only ever sign a key that is the owner's own.
    const keys = row.media.filter((k) => isOwnWorkKey(k, row.wawuUserId));
    const media = await Promise.all(
      keys.map(async (key) => ({
        url: await this.storage.freshUrlFor(key),
        kind: workMediaKind(key),
      })),
    );
    return {
      id: row.id,
      title: row.title,
      role: row.role,
      client: row.client,
      year: row.year,
      link: row.link,
      category: row.category,
      description: row.description,
      media,
      position: row.position,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private categoriesOf(
    rows: { category: string | null }[],
  ): ProfileWorkCategoryView[] {
    const seen = new Map<string, ProfileWorkCategoryView>();
    for (const { category } of rows) {
      if (!category) continue;
      const key = category.toLowerCase();
      const hit = seen.get(key);
      if (hit) hit.count += 1;
      else seen.set(key, { name: category, count: 1 });
    }
    return [...seen.values()];
  }

  /** Somebody's works, or the caller's own (the same answer for both). */
  async list(
    owner: string,
    query: ListProfileWorksQueryDto = {},
  ): Promise<ProfileWorksView> {
    const rows = await this.prisma.profileWork.findMany({
      where: { wawuUserId: owner },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    const wanted = (query.category ?? '').trim().toLowerCase();
    let shown = wanted
      ? rows.filter((r) => (r.category ?? '').toLowerCase() === wanted)
      : rows;
    if (query.limit !== undefined) shown = shown.slice(0, query.limit);
    return {
      owner: await this.ownerView(owner),
      count: rows.length,
      categories: this.categoriesOf(rows),
      works: await Promise.all(shown.map((r) => this.toView(r))),
    };
  }

  /** `GET /users/:wawuId/featured-works`, for a visitor. */
  async listFor(
    idOrHandle: string,
    viewer: string,
    query: ListProfileWorksQueryDto,
  ): Promise<ProfileWorksView> {
    const owner = await this.audience.resolveVisible(idOrHandle, viewer);
    return this.list(owner, query);
  }

  /** `GET /users/:wawuId/featured-works/:workId`, for a visitor. */
  async getFor(
    idOrHandle: string,
    workId: string,
    viewer: string,
  ): Promise<ProfileWorkDetailView> {
    const owner = await this.audience.resolveVisible(idOrHandle, viewer);
    const [work, who] = await Promise.all([
      this.getOne(owner, workId),
      this.ownerView(owner),
    ]);
    return { ...work, owner: who };
  }

  private async getOne(
    owner: string,
    workId: string,
  ): Promise<ProfileWorkView> {
    if (!isSafeLookupKey(workId)) throw new NotFoundException(WORK_NOT_FOUND);
    const row = await this.prisma.profileWork.findFirst({
      where: { id: workId, wawuUserId: owner },
    });
    if (!row) throw new NotFoundException(WORK_NOT_FOUND);
    return this.toView(row);
  }

  async create(
    owner: string,
    dto: CreateProfileWorkDto,
  ): Promise<ProfileWorkView> {
    const data = {
      title: requiredText(dto.title, 'Title', { max: WORK_TITLE_MAX }),
      role: requiredText(dto.role, 'Role', { max: WORK_ROLE_MAX }),
      client:
        dto.client == null
          ? null
          : cleanText(dto.client, 'Client', { max: WORK_CLIENT_MAX }),
      link: dto.link == null ? null : cleanLink(dto.link),
      category:
        dto.category == null
          ? null
          : cleanText(dto.category, 'Category', { max: WORK_CATEGORY_MAX }),
      description:
        dto.description == null
          ? null
          : cleanText(dto.description, 'Description', {
              max: WORK_DESCRIPTION_MAX,
              multiline: true,
            }),
      year: dto.year,
    };
    assertYear(data.year, 'Year', FIRST_YEAR, latestWorkYear());
    const media = dto.media ? await this.ownedMedia(dto.media, owner) : [];

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, owner);
      const count = await tx.profileWork.count({
        where: { wawuUserId: owner },
      });
      if (count >= MAX_WORKS) {
        throw new BadRequestException(
          `A profile can feature at most ${MAX_WORKS} works. Remove one to add another.`,
        );
      }
      await tx.profileWork.updateMany({
        where: { wawuUserId: owner },
        data: { position: { increment: 1 } },
      });
      return tx.profileWork.create({
        data: { wawuUserId: owner, ...data, media, position: 0 },
      });
    });
    return this.toView(row);
  }

  async update(
    owner: string,
    workId: string,
    dto: UpdateProfileWorkDto,
  ): Promise<ProfileWorkView> {
    if (!isSafeLookupKey(workId)) throw new NotFoundException(WORK_NOT_FOUND);
    const data: Prisma.ProfileWorkUpdateManyMutationInput = {};
    if (dto.title !== undefined)
      data.title = requiredText(dto.title, 'Title', { max: WORK_TITLE_MAX });
    if (dto.role !== undefined)
      data.role = requiredText(dto.role, 'Role', { max: WORK_ROLE_MAX });
    if (dto.year !== undefined) {
      assertYear(dto.year, 'Year', FIRST_YEAR, latestWorkYear());
      data.year = dto.year;
    }
    if (dto.client !== undefined)
      data.client =
        dto.client === null
          ? null
          : cleanText(dto.client, 'Client', { max: WORK_CLIENT_MAX });
    if (dto.link !== undefined)
      data.link = dto.link === null ? null : cleanLink(dto.link);
    if (dto.category !== undefined)
      data.category =
        dto.category === null
          ? null
          : cleanText(dto.category, 'Category', { max: WORK_CATEGORY_MAX });
    if (dto.description !== undefined)
      data.description =
        dto.description === null
          ? null
          : cleanText(dto.description, 'Description', {
              max: WORK_DESCRIPTION_MAX,
              multiline: true,
            });
    if (dto.media !== undefined) {
      if (dto.media.length > MAX_WORK_MEDIA) {
        throw new BadRequestException(
          `A work can carry at most ${MAX_WORK_MEDIA} files.`,
        );
      }
      data.media = await this.ownedMedia(dto.media, owner);
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Send at least one field to change.');
    }

    // Ownership is in the WHERE clause: not yours and not there are one 404.
    const written = await this.prisma.profileWork.updateMany({
      where: { id: workId, wawuUserId: owner },
      data,
    });
    if (written.count === 0) throw new NotFoundException(WORK_NOT_FOUND);
    return this.getOne(owner, workId);
  }

  async remove(owner: string, workId: string): Promise<{ deleted: true }> {
    if (!isSafeLookupKey(workId)) throw new NotFoundException(WORK_NOT_FOUND);
    const count = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, owner);
      const { count: removed } = await tx.profileWork.deleteMany({
        where: { id: workId, wawuUserId: owner },
      });
      return removed;
    });
    if (count === 0) throw new NotFoundException(WORK_NOT_FOUND);
    return { deleted: true };
  }

  /**
   * Puts the works in the order given. `ids` must be exactly the person's
   * works, each once. A list that is short, long or names something that is
   * not theirs (a work added in another tab, a deleted one, somebody else's)
   * is a 409 and changes nothing: the screen reloads and tries again.
   */
  async reorder(
    owner: string,
    dto: ReorderProfileWorksDto,
  ): Promise<ProfileWorksView> {
    const ids = dto.ids;
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each work can be listed once.');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, owner);
      const rows = await tx.profileWork.findMany({
        where: { wawuUserId: owner },
        select: { id: true },
      });
      const have = new Set(rows.map((r) => r.id));
      if (rows.length !== ids.length || !ids.every((id) => have.has(id))) {
        throw new ConflictException(
          'Your works changed. Reload and try again.',
        );
      }
      for (const [position, id] of ids.entries()) {
        await tx.profileWork.updateMany({
          where: { id, wawuUserId: owner },
          data: { position },
        });
      }
    });
    return this.list(owner);
  }
}

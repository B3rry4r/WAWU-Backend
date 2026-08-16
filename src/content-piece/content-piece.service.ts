import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { ContentPieceResponse } from '../common/types/content-piece.type';
import type { SavedItem } from '../common/types';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { CreateContentDto } from './dto/create-content.dto';
import type { RateContentDto } from './dto/rate-content.dto';
import type { VerifyUnlockDto } from './dto/verify-unlock.dto';

/** Standard commission rate (conventions.md § Identity & format canon). */
const STANDARD_COMMISSION_RATE = 0.15;
/** Pro-tier commission rate, applied only while the Pro creator's subscription is active. */
const PRO_COMMISSION_RATE = 0.1;

export interface FlutterwaveConfigResponse {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
}

export interface UnlockVerifyResult {
  purchased: true;
  fullAssetUrl: string | null;
}

interface ContentRow {
  id: string;
  slug: string;
  creatorWawuId: string;
  contentType: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  accessType: string;
  price: number;
  durationLabel: string | null;
  pageCount: number | null;
  previewAssetUrl: string;
  fullAssetUrl: string | null;
  creatorFirstUploadFree: boolean;
  status: string;
  views: number;
  ratingPct: number | null;
  commentCount: number;
  likes: number;
  createdAt: Date;
}

/**
 * ContentPiece resource — registry.json "ContentPiece". Owns content
 * CRUD/listing, the unlock (paid-content purchase) flow, save-toggle, and
 * rating. Comment/CourseLesson/SavedItem's own contracted endpoints
 * (GET/POST .../comments, GET /users/me/saved) are separate resources
 * (wave 0, already built) — out of scope here per task brief § SCOPE.
 * POST/DELETE /content/:id/save ARE this resource's contract (registry
 * lists them under ContentPiece, not SavedItem — confirmed against
 * src/saved-item/saved-item.controller.ts's own doc comment, which
 * explicitly defers save/unsave to ContentPiece).
 */
@Injectable()
export class ContentPieceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  /** Snapshotted at transaction time, never recomputed later (conventions.md). */
  private async resolveCommissionRate(creatorWawuId: string): Promise<number> {
    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { tier: true, subscriptionPaid: true },
    });
    if (
      creatorState &&
      creatorState.tier === 'pro' &&
      creatorState.subscriptionPaid
    ) {
      return PRO_COMMISSION_RATE;
    }
    return STANDARD_COMMISSION_RATE;
  }

  /**
   * `fullAssetLocked` (registry note: "derived") / `fullAssetUrl` (registry
   * note: "server-gated: present only if free or requester has completed
   * Purchase") are computed per-requester at read time here — never a
   * derived stored column, and never trusted from any client input.
   */
  private toResponse(
    content: ContentRow,
    unlocked: boolean,
  ): ContentPieceResponse {
    const isFree = content.accessType === 'free';
    const locked = !isFree && !unlocked;
    return {
      ...content,
      fullAssetUrl: locked ? null : content.fullAssetUrl,
      fullAssetLocked: locked,
    } as ContentPieceResponse;
  }

  /** Batch-resolves which of `contentIds` the requester has fully unlocked. */
  private async resolveUnlockedSet(
    requesterWawuId: string | undefined,
    contentIds: string[],
  ): Promise<Set<string>> {
    if (!requesterWawuId || contentIds.length === 0) return new Set();

    const [ownedAsCreator, completedPurchases] = await Promise.all([
      this.prisma.contentPiece.findMany({
        where: { id: { in: contentIds }, creatorWawuId: requesterWawuId },
        select: { id: true },
      }),
      this.prisma.purchase.findMany({
        where: {
          contentId: { in: contentIds },
          buyerWawuId: requesterWawuId,
          type: 'content',
          status: 'completed',
        },
        select: { contentId: true },
      }),
    ]);

    const unlocked = new Set<string>();
    for (const row of ownedAsCreator) unlocked.add(row.id);
    for (const row of completedPurchases)
      if (row.contentId) unlocked.add(row.contentId);
    return unlocked;
  }

  async findOne(
    id: string,
    requesterWawuId: string | undefined,
  ): Promise<ContentPieceResponse> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }
    if (
      content.status !== 'live' &&
      content.creatorWawuId !== requesterWawuId
    ) {
      throw new NotFoundException('Content not found');
    }

    const unlockedSet = await this.resolveUnlockedSet(requesterWawuId, [
      content.id,
    ]);
    return this.toResponse(content, unlockedSet.has(content.id));
  }

  async list(
    requesterWawuId: string | undefined,
    scope: 'feed' | 'mine' | undefined,
    category: string | undefined,
    page: number,
    perPage: number,
  ): Promise<Paginated<ContentPieceResponse>> {
    const where =
      scope === 'mine'
        ? {
            creatorWawuId: requesterWawuId ?? '__none__',
            ...(category ? { category } : {}),
          }
        : { status: 'live' as const, ...(category ? { category } : {}) };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.contentPiece.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.contentPiece.count({ where }),
    ]);

    const unlockedSet = await this.resolveUnlockedSet(
      requesterWawuId,
      items.map((i) => i.id),
    );
    return {
      items: items.map((item) =>
        this.toResponse(item, unlockedSet.has(item.id)),
      ),
      currentPage: page,
      perPage,
      total,
    };
  }

  async listMine(
    creatorWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<ContentPieceResponse>> {
    return this.list(creatorWawuId, 'mine', undefined, page, perPage);
  }

  private slugify(title: string): string {
    return (
      title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'content'
    );
  }

  async create(
    creatorWawuId: string,
    dto: CreateContentDto,
  ): Promise<ContentPieceResponse> {
    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { subscriptionPaid: true },
    });
    if (!creatorState || !creatorState.subscriptionPaid) {
      throw new ForbiddenException(
        'A paid subscription is required to upload content (CreatorState.subscriptionPaid=false).',
      );
    }

    const existingCount = await this.prisma.contentPiece.count({
      where: { creatorWawuId },
    });
    const isFirstUpload = existingCount === 0;

    if (isFirstUpload && dto.accessType === 'paid') {
      throw new BadRequestException(
        "A creator's first upload must be free (creatorFirstUploadFree) — resubmit with accessType 'free'.",
      );
    }
    if (dto.accessType === 'free' && dto.price !== 0) {
      throw new BadRequestException('Free content must be priced at ₦0.');
    }
    if (dto.accessType === 'paid' && dto.price <= 0) {
      throw new BadRequestException(
        'Paid content must have a price greater than ₦0.',
      );
    }

    const slug = `${this.slugify(dto.title)}-${randomUUID().slice(0, 8)}`;

    const created = await this.prisma.contentPiece.create({
      data: {
        slug,
        creatorWawuId,
        contentType: dto.contentType as never,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        tags: dto.tags ?? [],
        accessType: dto.accessType as never,
        price: dto.price,
        previewAssetUrl: dto.previewAsset,
        fullAssetUrl: dto.fullAsset,
        creatorFirstUploadFree: isFirstUpload,
        status: 'pending',
      },
    });

    return this.toResponse(created, true);
  }

  async listPurchases(
    buyerWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<Record<string, unknown>>> {
    const where = { buyerWawuId, type: 'content' as const };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where,
        orderBy: { purchasedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return {
      items: items.map((p) => ({
        ...p,
        commissionRate: p.commissionRate.toNumber(),
      })),
      currentPage: page,
      perPage,
      total,
    };
  }

  async unlock(
    contentId: string,
    buyerWawuId: string,
  ): Promise<FlutterwaveConfigResponse> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!content || content.status !== 'live') {
      throw new NotFoundException('Content not found');
    }
    if (content.accessType === 'free') {
      throw new BadRequestException(
        'This content is free — no unlock required.',
      );
    }
    if (content.creatorWawuId === buyerWawuId) {
      throw new BadRequestException('Cannot purchase your own content.');
    }

    const alreadyUnlocked = await this.prisma.purchase.findFirst({
      where: { contentId, buyerWawuId, type: 'content', status: 'completed' },
      select: { id: true },
    });
    if (alreadyUnlocked) {
      throw new BadRequestException('You have already unlocked this content.');
    }

    const commissionRate = await this.resolveCommissionRate(
      content.creatorWawuId,
    );
    const charge = this.flutterwave.initCharge({
      amount: content.price,
      purpose: 'content-unlock',
      wawuUserId: buyerWawuId,
    });

    await this.prisma.purchase.create({
      data: {
        contentId,
        type: 'content',
        buyerWawuId,
        creatorWawuId: content.creatorWawuId,
        amount: content.price,
        commissionRate,
        flutterwaveTxRef: charge.txRef,
        flutterwaveTxId: null,
        status: 'pending',
        note: null,
      },
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
    };
  }

  async verifyUnlock(
    contentId: string,
    buyerWawuId: string,
    dto: VerifyUnlockDto,
  ): Promise<UnlockVerifyResult> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }

    const purchase = await this.prisma.purchase.findFirst({
      where: {
        flutterwaveTxRef: dto.tx_ref,
        buyerWawuId,
        contentId,
        type: 'content',
      },
    });
    if (!purchase) {
      throw new NotFoundException(
        'No matching unlock attempt found for this reference',
      );
    }

    if (purchase.status === 'completed') {
      return { purchased: true, fullAssetUrl: content.fullAssetUrl };
    }
    if (purchase.status === 'failed') {
      throw new BadRequestException(
        'This unlock attempt already failed verification',
      );
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const verified =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === purchase.flutterwaveTxRef &&
      result.amount >= purchase.amount;

    if (!verified) {
      await this.prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: 'failed', flutterwaveTxId: result.transactionId },
      });
      throw new BadRequestException('Payment verification failed');
    }

    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: 'completed', flutterwaveTxId: result.transactionId },
    });

    return { purchased: true, fullAssetUrl: content.fullAssetUrl };
  }

  async save(contentId: string, userWawuId: string): Promise<SavedItem> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { id: true },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }

    return this.prisma.savedItem.upsert({
      where: { userWawuId_contentId: { userWawuId, contentId } },
      update: {},
      create: { userWawuId, contentId },
    });
  }

  async unsave(contentId: string, userWawuId: string): Promise<void> {
    await this.prisma.savedItem.deleteMany({
      where: { userWawuId, contentId },
    });
  }

  /**
   * Recomputes `ratingPct` (registry note: "designed-state task ... New
   * endpoint recomputes the aggregate"). The frozen schema stores only a
   * single mutable `ratingPct` scalar with no per-rating history/count
   * column (confirmed: no Rating model, no ratingCount field) — a true
   * running average across N raters is not representable without a schema
   * change, which is out of scope (schema is frozen per task brief). This
   * is therefore an honest, documented two-point blend (previous aggregate
   * folded 50/50 with the new submission's own percentage), not a
   * fabricated N-weighted average.
   */
  async rate(
    contentId: string,
    raterWawuId: string,
    dto: RateContentDto,
  ): Promise<ContentPieceResponse> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }

    const submittedPct = dto.rating * 20;
    const newRatingPct =
      content.ratingPct === null
        ? submittedPct
        : Math.round((content.ratingPct + submittedPct) / 2);

    const updated = await this.prisma.contentPiece.update({
      where: { id: contentId },
      data: { ratingPct: newRatingPct },
    });

    const unlockedSet = await this.resolveUnlockedSet(raterWawuId, [
      updated.id,
    ]);
    return this.toResponse(updated, unlockedSet.has(updated.id));
  }
}

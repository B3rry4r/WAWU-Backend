import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { ProductDraftModel } from '../../generated/prisma/models';
import type { ContentPieceResponse } from '../common/types/content-piece.type';
import { PublishingGate } from '../plans/publishing-gate.service';
import { ContentPieceService } from './content-piece.service';
import type { CreateContentDto } from './dto/create-content.dto';
import type {
  CreateProductDraftDto,
  PublishProductDraftDto,
  UpdateProductDraftDto,
} from './dto/product-draft.dto';
import type { ProductDraftView } from './dto/product-draft.view';

/**
 * How many drafts one person may keep at once. A draft holds no file and no
 * place, so this only keeps a free account from filling the table.
 * PROVISIONAL(PRODUCT-DRAFTS-MAX, owner=YOU, why=no ruling sizes a person's
 * drafts and they cost nothing to keep; the owner may set another number).
 */
export const PRODUCT_DRAFTS_MAX = 20;

/** What a draft still lacks, in the words a person reads. */
const MISSING_WORDS: Record<string, string> = {
  contentType: 'what kind of product it is',
  description: 'a description',
  category: 'a category',
  accessType: 'free or paid',
  price: 'a price',
};

/** Which fields stop a draft from being published, by name. */
export function missingFor(
  d: Pick<
    ProductDraftModel,
    'contentType' | 'description' | 'category' | 'accessType' | 'price'
  >,
): string[] {
  const out: string[] = [];
  if (d.contentType === null) out.push('contentType');
  if (d.description === null) out.push('description');
  if (d.category === null) out.push('category');
  if (d.accessType === null) out.push('accessType');
  // A free product is priced at nothing; a paid one needs its price.
  else if (d.accessType === 'paid' && d.price === null) out.push('price');
  return out;
}

function toView(d: ProductDraftModel): ProductDraftView {
  return {
    id: d.id,
    title: d.title,
    contentType: d.contentType,
    description: d.description,
    category: d.category,
    specializations: d.specializations,
    tags: d.tags,
    accessType: d.accessType,
    price: d.price,
    missing: missingFor(d),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * Drafts (TIER-02, VF2): "Anyone can sign up, build a profile and draft
 * products free." A draft is the details of a product with no file. It is
 * never counted, never reviewed and never shown to anyone else; publishing it
 * is the one step that needs a tier, and it goes through
 * ContentPieceService.create, so it meets exactly the checks POST /content
 * does (the tier, the free place, the price rules).
 *
 * Every query is keyed on the caller's id: another person's draft is a 404.
 */
@Injectable()
export class ProductDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentPieceService,
    private readonly gate: PublishingGate,
  ) {}

  async create(
    wawuUserId: string,
    dto: CreateProductDraftDto,
  ): Promise<ProductDraftView> {
    const kept = await this.prisma.productDraft.count({
      where: { wawuUserId },
    });
    if (kept >= PRODUCT_DRAFTS_MAX) {
      throw new ConflictException({
        message: `You can keep ${PRODUCT_DRAFTS_MAX} drafts. Delete or publish one to start another.`,
        reason: {
          code: 'draft_limit_reached',
          message: `You can keep ${PRODUCT_DRAFTS_MAX} drafts. Delete or publish one to start another.`,
          draftsKept: kept,
          draftsAllowed: PRODUCT_DRAFTS_MAX,
        },
      });
    }
    const row = await this.prisma.productDraft.create({
      data: {
        wawuUserId,
        title: dto.title.trim(),
        contentType: dto.contentType,
        description: dto.description,
        category: dto.category,
        specializations: dto.specializations ?? [],
        tags: dto.tags ?? [],
        accessType: dto.accessType,
        price: dto.price,
      },
    });
    return toView(row);
  }

  async list(wawuUserId: string): Promise<ProductDraftView[]> {
    const rows = await this.prisma.productDraft.findMany({
      where: { wawuUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: PRODUCT_DRAFTS_MAX,
    });
    return rows.map(toView);
  }

  async get(wawuUserId: string, id: string): Promise<ProductDraftView> {
    return toView(await this.ownOrThrow(wawuUserId, id));
  }

  async update(
    wawuUserId: string,
    id: string,
    dto: UpdateProductDraftDto,
  ): Promise<ProductDraftView> {
    await this.ownOrThrow(wawuUserId, id);
    const data = {
      ...(dto.title === undefined ? {} : { title: dto.title.trim() }),
      ...(dto.contentType === undefined
        ? {}
        : { contentType: dto.contentType }),
      ...(dto.description === undefined
        ? {}
        : { description: dto.description }),
      ...(dto.category === undefined ? {} : { category: dto.category }),
      ...(dto.specializations === undefined
        ? {}
        : { specializations: dto.specializations }),
      ...(dto.tags === undefined ? {} : { tags: dto.tags }),
      ...(dto.accessType === undefined ? {} : { accessType: dto.accessType }),
      ...(dto.price === undefined ? {} : { price: dto.price }),
    };
    if (Object.keys(data).length === 0)
      throw new BadRequestException('Send at least one field to change.');
    // Keyed on the owner as well, so a draft deleted a moment ago is a 404
    // and not a write to somebody else's row.
    const written = await this.prisma.productDraft.updateMany({
      where: { id, wawuUserId },
      data,
    });
    if (written.count === 0) throw new NotFoundException('Draft not found.');
    return toView(await this.ownOrThrow(wawuUserId, id));
  }

  async remove(wawuUserId: string, id: string): Promise<void> {
    const gone = await this.prisma.productDraft.deleteMany({
      where: { id, wawuUserId },
    });
    if (gone.count === 0) throw new NotFoundException('Draft not found.');
  }

  /**
   * Publishes a draft: the tier and the free place are asked first (so a
   * person with no tier opens the offers from Publish), then the draft is
   * checked to be complete, then the piece is created and the draft deleted
   * in one transaction. Two taps publish it once: the second finds no draft.
   */
  async publish(
    wawuUserId: string,
    id: string,
    dto: PublishProductDraftDto,
  ): Promise<ContentPieceResponse> {
    const draft = await this.ownOrThrow(wawuUserId, id);
    await this.gate.assertRoomForProduct(wawuUserId);

    const missing = missingFor(draft);
    if (missing.length > 0) {
      throw new BadRequestException({
        message: `Finish your draft first. It still needs ${missing
          .map((m) => MISSING_WORDS[m] ?? m)
          .join(', ')}.`,
        reason: {
          code: 'draft_incomplete',
          message: 'Finish your draft before you publish it.',
          missing,
        },
      });
    }

    // missingFor proved these are set; a free product is priced at nothing.
    const piece: CreateContentDto = {
      contentType: draft.contentType!,
      title: draft.title,
      description: draft.description!,
      category: draft.category as CreateContentDto['category'],
      specializations: draft.specializations,
      tags: draft.tags,
      accessType: draft.accessType!,
      price: draft.accessType === 'free' ? 0 : draft.price!,
      previewAsset: dto.previewAsset,
      fullAsset: dto.fullAsset,
    };
    return this.content.create(wawuUserId, piece, async (tx) => {
      const gone = await tx.productDraft.deleteMany({
        where: { id, wawuUserId },
      });
      if (gone.count === 0)
        throw new ConflictException('This draft was published a moment ago.');
    });
  }

  private async ownOrThrow(
    wawuUserId: string,
    id: string,
  ): Promise<ProductDraftModel> {
    const row = await this.prisma.productDraft.findFirst({
      where: { id, wawuUserId },
    });
    if (!row) throw new NotFoundException('Draft not found.');
    return row;
  }
}

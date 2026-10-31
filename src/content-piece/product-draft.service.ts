import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { ProductDraftModel } from '../../generated/prisma/models';
import type { ContentPieceResponse } from '../common/types/content-piece.type';
import { PublishingGate } from '../plans/publishing-gate.service';
import { ContentPieceService } from './content-piece.service';
import { PreviewCutService } from './preview-cut.service';
import type { CreateContentDto } from './dto/create-content.dto';
import type {
  CreateProductDraftDto,
  PublishProductDraftDto,
  UpdateProductDraftDto,
} from './dto/product-draft.dto';
import type { ProductDraftView } from './dto/product-draft.view';
import { assertContentAllowed } from '../moderation/content-filter';

/**
 * How many drafts one person may keep at once. A draft holds no file and no
 * place, so this only keeps a free account from filling the table.
 * PROVISIONAL(PRODUCT-DRAFTS-MAX, owner=YOU, why=no ruling sizes a person's drafts and they cost nothing to keep)
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
    mediaJobId: d.mediaJobId,
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
    // PREVIEW-AUTO: resolves the preview at publish. Optional so a spec that builds this service by hand keeps working;
    // without it a draft publishes only with the clip it names, as before.
    @Optional() private readonly previews?: PreviewCutService,
  ) {}

  /**
   * Counted and inserted under a per-person transaction lock, so drafts
   * sent at the same moment (a double tap, two devices) cannot pass the
   * maximum together: each waits for the one before it to commit and counts
   * after it (TIER-02 round 2, D3: 30 sent together over two Hubs left 22).
   * The lock is on the person, so one person's drafts never wait on another's.
   */
  async create(
    wawuUserId: string,
    dto: CreateProductDraftDto,
  ): Promise<ProductDraftView> {
    // MOD-ROOMS (R-122). A draft's title and description are checked as a piece's are.
    assertContentAllowed(dto.title, dto.description);
    if (dto.mediaJobId)
      await this.assertOwnFinishedJob(wawuUserId, dto.mediaJobId);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`product-drafts:${wawuUserId}`}, 0))`;
      const kept = await tx.productDraft.count({ where: { wawuUserId } });
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
      return tx.productDraft.create({
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
          ...(dto.mediaJobId ? { mediaJobId: dto.mediaJobId } : {}),
        },
      });
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
    assertContentAllowed(dto.title, dto.description);
    await this.ownOrThrow(wawuUserId, id);
    if (dto.mediaJobId)
      await this.assertOwnFinishedJob(wawuUserId, dto.mediaJobId);
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
      // AITOOLS-07: a job id attaches its audio, `null` detaches it.
      ...(dto.mediaJobId === undefined ? {} : { mediaJobId: dto.mediaJobId }),
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
      coverAsset: dto.coverAsset,
    };
    // A file whose upload outlasted the Hub's wait is counted first, outside
    // any lock (SWEEP-APP-5, ME-04 R4-5).
    await this.content.settleSlowUploads(wawuUserId, piece);
    // PREVIEW-AUTO: the preview this piece goes out with (the clip sent, the free file itself, or a cut made from the full file).
    const preview = this.previews
      ? await this.previews.resolve(wawuUserId, {
          contentType: piece.contentType,
          accessType: piece.accessType,
          fullAsset: piece.fullAsset,
          previewAsset: dto.previewAsset,
          previewFromFile: dto.previewFromFile,
          coverAsset: piece.coverAsset,
        })
      : { previewAsset: dto.previewAsset, made: null };
    const out = { ...piece, previewAsset: preview.previewAsset };
    const filesUsable = this.content.filesUsableIn(wawuUserId, out);
    try {
      return await this.content.create(wawuUserId, out, async (tx) => {
        // The files it names must still be the person's (ME-04 round 4).
        await filesUsable(tx);
        const gone = await tx.productDraft.deleteMany({
          where: { id, wawuUserId },
        });
        if (gone.count === 0)
          throw new ConflictException('This draft was published a moment ago.');
      });
    } catch (err) {
      // A cut made for a publish that did not go through is given back, so it never counts.
      await this.previews?.giveBack(wawuUserId, preview.made);
      throw err;
    }
  }

  /**
   * "Use in a product" (AITOOLS-07): the job must be the caller's own and
   * finished with audio. Another person's job and one that is not there are the
   * same 404; one still working, failed or without audio is a 409.
   */
  private async assertOwnFinishedJob(
    wawuUserId: string,
    jobId: string,
  ): Promise<void> {
    const job = await this.prisma.aiToolJob.findFirst({
      where: { id: jobId, wawuUserId },
      select: { state: true, audioKey: true, outputs: true },
    });
    if (!job) throw new NotFoundException('Result not found.');
    const hasAudio =
      job.audioKey !== null ||
      (Array.isArray(job.outputs) &&
        (job.outputs as { kind?: unknown; key?: unknown }[]).some(
          (o) => o?.kind === 'audio' && typeof o.key === 'string',
        ));
    if (job.state !== 'done' || !hasAudio)
      throw new ConflictException({
        message: 'Only a finished result with audio can be used in a product.',
        reason: {
          code: 'job_not_ready',
          message:
            'Only a finished result with audio can be used in a product.',
        },
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

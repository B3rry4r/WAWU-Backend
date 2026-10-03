import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  deriveVerificationState,
  unverified,
  type VerificationState,
} from '../common/verification/verification-state';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import {
  AccountType,
  ContentStatus,
  DmStatus,
} from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import type { ApplyProfessionalDto } from './dto/apply-professional.dto';
import type { CreateProfessionalReviewDto } from './dto/create-professional-review.dto';
import type { ListProfessionalsQueryDto } from './dto/list-professionals-query.dto';
import { isRegulatedCategory } from './professional-categories';
import {
  fieldForCategory,
  fieldViews,
  findField,
  type ProfessionalFieldRef,
  type ProfessionalFieldView,
} from './professional-fields';
import {
  NO_REPLY_STATS,
  REPLY_TIME_DEFAULTS,
  toReplyStats,
  type ReplyTimeStats,
} from './professional-reply-time';
import type { ListProfessionalDirectoryQueryDto } from './dto/professional-directory.dto';

/** A professional as a browser sees them. */
export interface ProfessionalListItem {
  id: string;
  wawuId: string;
  name: string;
  handle: string | null;
  category: string;
  headline: string;
  services: string[];
  /**
   * Both ticks, not a rung. A professional who is also a verified creator
   * carries both, and this surface never picks one to show.
   */
  verification: VerificationState;
  /** Profile picture. Null is normal: not every creator has uploaded one. */
  avatarUrl: string | null;
  /** Live pieces, so a browser can see they are actually active on WAWU. */
  pieceCount: number;
  /** Whether they can be paid-messaged right now, and what it costs. */
  dmEnabled: boolean;
  dmPrice: number | null;
  dmResponseHours: number;
  /**
   * The stars above the Book button, and the "(120 reviews)" beside them.
   *
   * AGGREGATED from ProfessionalReview rows on read, to one decimal. NULL
   * when nobody has reviewed this listing, and the card then draws no stars
   * at all — which is the whole reason there is no `rating` column on
   * ProfessionalProfile. A fabricated 4.8 under every name in a directory of
   * lawyers and doctors is worse than no stars, because somebody chooses a
   * professional on it.
   */
  ratingAvg: number | null;
  reviewCount: number;
}

/** One review as it goes back to the person who just wrote it. */
export interface ProfessionalReviewView {
  id: string;
  professionalId: string;
  authorWawuId: string;
  stars: number;
  body: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The listing's rating AFTER this review, so a client never has to refetch. */
  ratingAvg: number | null;
  reviewCount: number;
}

/**
 * The directory's extras on top of a listing (PROS-02), for the mobile app:
 * the canvas's field, the city, the usual reply time and the message price.
 *
 * Served on their own routes (GET /professionals/directory and
 * /professionals/directory/:id), never added to GET /professionals or GET
 * /professionals/:id: the web reads those today and their answers stay as
 * they are (they are on the protected route list).
 */
interface ProfessionalDirectoryExtras {
  /** The canvas field this listing shows under, or null when none covers its category. */
  field: ProfessionalFieldRef | null;
  /** Where they work, as they wrote it. Null when they have not said. */
  city: string | null;
  /**
   * "Usually replies in": median minutes from a paid message being sent to
   * its answer, over their most recent answered messages. Null until enough
   * have been answered (professional-reply-time.ts).
   */
  usualReplyMinutes: number | null;
  /** How many answered paid messages `usualReplyMinutes` was taken from. */
  answeredMessageCount: number;
  /**
   * What one message costs, in kobo (R-21). Null when they are not taking
   * messages (`dmEnabled` false): never shown as free.
   */
  messagePriceKobo: number | null;
}

/** One row of the mobile directory (P1) and the feed card (H10). */
export interface ProfessionalDirectoryEntry
  extends Omit<ProfessionalListItem, 'dmPrice'>, ProfessionalDirectoryExtras {}

/** One professional's profile in the mobile app (P2, P3). */
export interface ProfessionalDirectoryProfile extends ProfessionalDirectoryEntry {
  about: string;
  /** Who issued the credential. Public; the licence number is not. */
  issuingBody: string | null;
  credentialKind: string;
}

/** GET /professionals/directory, before the envelope splits it. */
export interface ProfessionalDirectoryPage {
  items: ProfessionalDirectoryEntry[];
  currentPage: number;
  perPage: number;
  total: number;
}

/** GET and PUT /professionals/location. */
export interface ProfessionalLocationView {
  city: string | null;
}

const DEFAULT_PER_PAGE = 20;

/**
 * Professional profiles — creators listed as practitioners in one category,
 * reached through a paid DM.
 *
 * The shape of this feature comes from one decision: WAWU is where the
 * CONVERSATION starts, not where the engagement is delivered. A buyer browses
 * a category, finds someone, pays to send the first message, and the two of
 * them take it from there. So there is no booking, no scheduling, no escrow
 * and no invoicing in here — the money that changes hands on WAWU is the
 * message fee, which DirectMessage already charges, already time-limits and
 * (since the refund work) can actually return.
 *
 * The other decision is that a licence is field-specific. `certified_
 * professional` on the verification ladder is global and answers "is this
 * person a qualified professional at all"; being listed here answers "at
 * what", which is what someone browsing Legal Services needs to know. Hence
 * one application per person per category.
 */
@Injectable()
export class ProfessionalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  // -------------------------------------------------------------------
  // Applying
  // -------------------------------------------------------------------

  /**
   * POST /professionals/applications.
   *
   * A rejected application is REPLACED in place rather than added to. That is
   * what the unique key on (wawuUserId, category) is for: someone who fixes a
   * blurry document and reapplies should not leave two rows in a queue a
   * person has to work through, and it stops an applicant flooding that queue
   * by pressing submit repeatedly.
   */
  async apply(wawuUserId: string, dto: ApplyProfessionalDto) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { accountType: true },
    });
    // Offering services for money is a creator activity — it is the same
    // account type that publishes and gets paid. A buyer account applying
    // here would be approved into a directory it cannot transact from.
    if (profile?.accountType !== AccountType.creator) {
      throw new ForbiddenException(
        'Only a creator account can apply to be listed as a professional.',
      );
    }

    this.assertCredentialFitsCategory(dto);

    const existing = await this.prisma.professionalProfile.findUnique({
      where: {
        wawuUserId_category: { wawuUserId, category: dto.category },
      },
      select: { id: true, status: true },
    });

    if (existing?.status === 'pending') {
      throw new ConflictException(
        'You already have an application under review for this category.',
      );
    }
    if (existing?.status === 'approved') {
      throw new ConflictException(
        'You are already listed as a professional in this category.',
      );
    }

    const data = {
      wawuUserId,
      category: dto.category,
      headline: dto.headline,
      about: dto.about,
      services: dto.services ?? [],
      credentialKind: dto.credentialKind,
      licenceNumber: dto.licenceNumber ?? null,
      issuingBody: dto.issuingBody ?? null,
      documents: dto.documents ?? [],
      status: 'pending' as const,
      // Cleared on resubmission: the previous reason belongs to the previous
      // application, and leaving it would show a rejected banner on a fresh
      // one that nobody has looked at yet.
      rejectionReason: null,
      submittedAt: new Date(),
      reviewedAt: null,
      listed: true,
    };

    return this.prisma.professionalProfile.upsert({
      where: { wawuUserId_category: { wawuUserId, category: dto.category } },
      create: data,
      update: data,
    });
  }

  /**
   * The regulated-category rule, in one place.
   *
   * In a regulated category the reviewer's job is to ring the issuing body and
   * confirm the licence, so an application without a licence number and a body
   * to ring is not reviewable — accepting it would put a row in the queue that
   * can only ever be rejected. Outside those categories there is usually no
   * register at all, which is why a portfolio is a legitimate answer there and
   * never here.
   */
  private assertCredentialFitsCategory(dto: ApplyProfessionalDto): void {
    if (!isRegulatedCategory(dto.category)) return;

    if (dto.credentialKind !== 'licence') {
      throw new BadRequestException(
        `${dto.category.replace(/_/g, ' ')} is a regulated field, so a practising licence is required — a portfolio or a general qualification cannot be accepted here.`,
      );
    }
    if (!dto.licenceNumber?.trim()) {
      throw new BadRequestException(
        'A licence number is required in a regulated field, so it can be confirmed with the body that issued it.',
      );
    }
    if (!dto.issuingBody?.trim()) {
      throw new BadRequestException(
        'The body that issued the licence is required, so it can be contacted to confirm it.',
      );
    }
  }

  /** GET /professionals/applications/mine — every category this person applied in. */
  async listMine(wawuUserId: string) {
    return this.prisma.professionalProfile.findMany({
      where: { wawuUserId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  /**
   * PATCH /professionals/applications/:id/listing.
   *
   * Availability, not approval. A professional who is at capacity hides
   * themselves without withdrawing an application a human already reviewed —
   * and gets back into the directory by flipping this, not by reapplying.
   */
  async setListed(wawuUserId: string, id: string, listed: boolean) {
    const row = await this.prisma.professionalProfile.findUnique({
      where: { id },
      select: { wawuUserId: true, status: true },
    });
    if (!row) throw new NotFoundException('Professional profile not found');
    if (row.wawuUserId !== wawuUserId) {
      throw new ForbiddenException('This professional profile is not yours.');
    }
    if (row.status !== 'approved') {
      throw new ConflictException(
        'Only an approved professional profile can be hidden or shown.',
      );
    }
    return this.prisma.professionalProfile.update({
      where: { id },
      data: { listed },
    });
  }

  // -------------------------------------------------------------------
  // Browsing
  // -------------------------------------------------------------------

  /**
   * GET /professionals — the directory.
   *
   * Approved AND listed only. A pending application is not a professional,
   * and showing one would mean the badge on the card was granted by pressing
   * submit.
   */
  async list(query: ListProfessionalsQueryDto) {
    return this.pageOf(
      query.category ? { category: query.category } : {},
      query.page ?? 1,
      query.perPage ?? DEFAULT_PER_PAGE,
    );
  }

  /**
   * One page of approved, listed professionals, narrowed by `filter`. The
   * web's directory (GET /professionals) and the mobile one (GET
   * /professionals/directory) both read through here, so a listing looks the
   * same on both and the web's answer is unchanged.
   */
  private async pageOf(
    filter: Prisma.ProfessionalProfileWhereInput,
    page: number,
    perPage: number,
  ): Promise<{
    items: ProfessionalListItem[];
    currentPage: number;
    perPage: number;
    total: number;
  }> {
    const where: Prisma.ProfessionalProfileWhereInput = {
      status: 'approved',
      listed: true,
      ...filter,
    };

    const [rows, total] = await Promise.all([
      this.prisma.professionalProfile.findMany({
        where,
        orderBy: [{ reviewedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.professionalProfile.count({ where }),
    ]);

    if (rows.length === 0) {
      return { items: [], currentPage: page, perPage, total };
    }

    const ids = rows.map((r) => r.wawuUserId);
    const listingIds = rows.map((r) => r.id);
    const [identities, profiles, states, pieceCounts, ratings] =
      await Promise.all([
        this.wawuId.lookupPublicIdentities(ids),
        this.prisma.userProfile.findMany({
          where: { wawuUserId: { in: ids } },
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
        this.prisma.creatorState.findMany({
          where: { wawuUserId: { in: ids } },
          select: {
            wawuUserId: true,
            dmEnabled: true,
            dmPrice: true,
            dmResponseHours: true,
          },
        }),
        this.prisma.contentPiece.groupBy({
          by: ['creatorWawuId'],
          where: { creatorWawuId: { in: ids }, status: ContentStatus.live },
          _count: { _all: true },
        }),
        // One grouped read for the whole page. Per LISTING, not per person: a
        // review of someone's legal advice does not transfer to their
        // photography listing.
        this.prisma.professionalReview.groupBy({
          by: ['professionalId'],
          where: { professionalId: { in: listingIds } },
          _avg: { stars: true },
          _count: { _all: true },
        }),
      ]);

    const handleBy = new Map(profiles.map((p) => [p.wawuUserId, p.handle]));
    const avatarBy = new Map(profiles.map((p) => [p.wawuUserId, p.avatarUrl]));
    const ticksBy = new Map(
      profiles.map((p) => [p.wawuUserId, deriveVerificationState(p)]),
    );
    const stateBy = new Map(states.map((s) => [s.wawuUserId, s]));
    const pieceBy = new Map(
      pieceCounts.map((c) => [c.creatorWawuId, c._count._all]),
    );
    const ratingBy = new Map(
      ratings.map((r) => [
        r.professionalId,
        { avg: r._avg.stars, count: r._count._all },
      ]),
    );

    const items: ProfessionalListItem[] = rows.map((r) => {
      const identity = identities.get(r.wawuUserId);
      const handle = handleBy.get(r.wawuUserId) ?? null;
      const state = stateBy.get(r.wawuUserId);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        id: r.id,
        wawuId: r.wawuUserId,
        name: fullName || handle || r.wawuUserId,
        handle,
        category: r.category,
        headline: r.headline,
        services: r.services,
        // An approved professional listing without a UserProfile row on this
        // service has no ticks to show; unverified() is the honest answer,
        // not an assumed green one.
        verification: ticksBy.get(r.wawuUserId) ?? unverified(),
        avatarUrl: avatarBy.get(r.wawuUserId) ?? null,
        pieceCount: pieceBy.get(r.wawuUserId) ?? 0,
        // A professional who never switched paid messages on, or never set a
        // price, cannot be contacted. Reported honestly rather than rendering
        // a "Message" button that dead-ends — and never as free.
        dmEnabled: (state?.dmEnabled ?? false) && (state?.dmPrice ?? 0) > 0,
        dmPrice: state?.dmPrice ?? null,
        dmResponseHours: state?.dmResponseHours ?? 24,
        ratingAvg: roundToOneDecimal(ratingBy.get(r.id)?.avg ?? null),
        reviewCount: ratingBy.get(r.id)?.count ?? 0,
      };
    });

    return { items, currentPage: page, perPage, total };
  }

  /** GET /professionals/:id — one listing, in full. */
  async detail(id: string) {
    const row = await this.prisma.professionalProfile.findFirst({
      where: { id, status: 'approved', listed: true },
    });
    if (!row) throw new NotFoundException('Professional profile not found');

    const [identities, profile, state, pieceCount, rating] = await Promise.all([
      this.wawuId.lookupPublicIdentities([row.wawuUserId]),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: row.wawuUserId },
        select: {
          handle: true,
          bio: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
      this.prisma.creatorState.findUnique({
        where: { wawuUserId: row.wawuUserId },
        select: { dmEnabled: true, dmPrice: true, dmResponseHours: true },
      }),
      this.prisma.contentPiece.count({
        where: { creatorWawuId: row.wawuUserId, status: ContentStatus.live },
      }),
      this.ratingFor(row.id),
    ]);

    const identity = identities.get(row.wawuUserId);
    const fullName = [identity?.firstName, identity?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      id: row.id,
      wawuId: row.wawuUserId,
      name: fullName || profile?.handle || row.wawuUserId,
      handle: profile?.handle ?? null,
      category: row.category,
      headline: row.headline,
      about: row.about,
      services: row.services,
      verification: deriveVerificationState(profile),
      avatarUrl: profile?.avatarUrl ?? null,
      /**
       * The issuing body is public; the licence NUMBER is not. A buyer is
       * entitled to know who certified this person so they can check the
       * register themselves — publishing the number itself just hands out an
       * identifier that can be used to impersonate them.
       */
      issuingBody: row.issuingBody,
      credentialKind: row.credentialKind,
      pieceCount,
      dmEnabled: (state?.dmEnabled ?? false) && (state?.dmPrice ?? 0) > 0,
      dmPrice: state?.dmPrice ?? null,
      dmResponseHours: state?.dmResponseHours ?? 24,
      ratingAvg: rating.ratingAvg,
      reviewCount: rating.reviewCount,
    };
  }

  // -------------------------------------------------------------------
  // The mobile directory (PROS-02)
  // -------------------------------------------------------------------

  /** GET /professionals/fields: the fields the app filters and applies by. */
  fields(): ProfessionalFieldView[] {
    return fieldViews();
  }

  /**
   * GET /professionals/directory: the listings GET /professionals serves,
   * filtered by a canvas field instead of a category, each with its field,
   * city, usual reply time and message price.
   */
  async directory(
    query: ListProfessionalDirectoryQueryDto,
  ): Promise<ProfessionalDirectoryPage> {
    const field = query.field ? findField(query.field) : undefined;
    const result = await this.pageOf(
      field ? { category: { in: [...field.categories] } } : {},
      query.page ?? 1,
      query.perPage ?? DEFAULT_PER_PAGE,
    );
    const extras = await this.directoryExtras(
      result.items.map((i) => i.wawuId),
    );
    return {
      ...result,
      items: result.items.map((item) => withExtras(item, extras)),
    };
  }

  /**
   * GET /professionals/directory/:id: one listing as GET /professionals/:id
   * serves it, with the same extras as the directory. Not found for a
   * pending, rejected or hidden listing, exactly like GET /professionals/:id.
   */
  async directoryProfile(id: string): Promise<ProfessionalDirectoryProfile> {
    const listing = await this.detail(id);
    const extras = await this.directoryExtras([listing.wawuId]);
    const { about, issuingBody, credentialKind, ...card } = listing;
    return {
      ...withExtras(card, extras),
      about,
      issuingBody,
      credentialKind,
    };
  }

  /** GET /professionals/location: the caller's own city, or null. */
  async location(wawuUserId: string): Promise<ProfessionalLocationView> {
    const row = await this.prisma.professionalLocation.findUnique({
      where: { wawuUserId },
      select: { city: true },
    });
    return { city: row?.city ?? null };
  }

  /**
   * PUT /professionals/location: set the city on your card.
   *
   * A creator account only, the same rule as applying: the city is read only
   * beside a professional listing, and only a creator can hold one.
   */
  async setLocation(
    wawuUserId: string,
    city: string,
  ): Promise<ProfessionalLocationView> {
    await this.assertCreator(wawuUserId);
    const row = await this.prisma.professionalLocation.upsert({
      where: { wawuUserId },
      create: { wawuUserId, city },
      update: { city },
      select: { city: true },
    });
    return { city: row.city };
  }

  /** DELETE /professionals/location: the card stops showing a city. */
  async clearLocation(wawuUserId: string): Promise<ProfessionalLocationView> {
    await this.assertCreator(wawuUserId);
    await this.prisma.professionalLocation.deleteMany({
      where: { wawuUserId },
    });
    return { city: null };
  }

  private async assertCreator(wawuUserId: string): Promise<void> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { accountType: true },
    });
    if (profile?.accountType !== AccountType.creator) {
      throw new ForbiddenException(
        'Only a creator account can set where it works.',
      );
    }
  }

  /** City and reply times for a page of professionals, in two reads. */
  private async directoryExtras(wawuUserIds: string[]): Promise<{
    cityBy: Map<string, string>;
    replyBy: Map<string, ReplyTimeStats>;
  }> {
    if (wawuUserIds.length === 0) {
      return { cityBy: new Map(), replyBy: new Map() };
    }
    const unique = [...new Set(wawuUserIds)];
    const [locations, replies] = await Promise.all([
      this.prisma.professionalLocation.findMany({
        where: { wawuUserId: { in: unique } },
        select: { wawuUserId: true, city: true },
      }),
      this.replyTimes(unique),
    ]);
    return {
      cityBy: new Map(locations.map((l) => [l.wawuUserId, l.city])),
      replyBy: replies,
    };
  }

  /**
   * Median reply time over each professional's most recent answered paid
   * messages (professional-reply-time.ts), one query for the whole page.
   * Per PERSON, not per listing: a paid message goes to the person, and the
   * same person answers it whichever field they were found in.
   */
  private async replyTimes(
    wawuUserIds: string[],
  ): Promise<Map<string, ReplyTimeStats>> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        creatorWawuId: string;
        medianSeconds: number | null;
        answered: number;
      }>
    >`
      SELECT "creatorWawuId",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "seconds") AS "medianSeconds",
             COUNT(*)::int AS "answered"
      FROM (
        SELECT "creatorWawuId",
               EXTRACT(EPOCH FROM ("respondedAt" - "sentAt"))::double precision AS "seconds",
               ROW_NUMBER() OVER (
                 PARTITION BY "creatorWawuId" ORDER BY "respondedAt" DESC, "id"
               ) AS "rank"
        FROM "DirectMessage"
        WHERE "creatorWawuId" IN (${Prisma.join(wawuUserIds)})
          AND "status" = ${DmStatus.responded}::"DmStatus"
          AND "respondedAt" IS NOT NULL
      ) AS "answered"
      WHERE "rank" <= ${REPLY_TIME_DEFAULTS.sample}
      GROUP BY "creatorWawuId"`;
    return new Map(
      rows.map((r) => [
        r.creatorWawuId,
        toReplyStats(
          r.medianSeconds === null ? null : Number(r.medianSeconds),
          Number(r.answered),
        ),
      ]),
    );
  }

  // -------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------

  /**
   * POST /professionals/:id/reviews — rate somebody you actually dealt with.
   *
   * ── WHO MAY WRITE ONE, AND WHY IT IS THIS ──────────────────────────────
   * The engagement itself happens off WAWU: this backend takes no money for
   * professional work, holds no booking and knows nothing about whether a
   * contract was delivered. What it does hold is the PAID INTRODUCTION.
   * DirectMessage records that this author paid to message this professional
   * and, in `status`, whether the professional replied.
   *
   * So the gate is a DM from the author to that professional which the
   * professional RESPONDED to. That relationship costs real money to
   * manufacture, it cannot be faked by pressing a button, and it excludes
   * both the person who never made contact and the one whose message was
   * ignored and refunded — rating somebody for a conversation that never
   * happened is not a review of their work.
   *
   * An UPSERT on (professionalId, authorWawuId): changing your mind replaces
   * your own rating rather than casting a second vote.
   */
  async review(
    professionalId: string,
    authorWawuId: string,
    dto: CreateProfessionalReviewDto,
  ): Promise<ProfessionalReviewView> {
    const listing = await this.prisma.professionalProfile.findFirst({
      where: { id: professionalId, status: 'approved' },
      select: { id: true, wawuUserId: true },
    });
    // Unlisted is deliberately still reviewable: a professional who has gone
    // temporarily unavailable should not be able to switch off the rating of
    // work they have already done.
    if (!listing) throw new NotFoundException('Professional profile not found');

    if (listing.wawuUserId === authorWawuId) {
      throw new ForbiddenException('You cannot review your own listing.');
    }

    const dealt = await this.prisma.directMessage.findFirst({
      where: {
        creatorWawuId: listing.wawuUserId,
        senderWawuId: authorWawuId,
        status: DmStatus.responded,
      },
      select: { id: true },
    });
    if (!dealt) {
      throw new ForbiddenException(
        'Only someone this professional has replied to can rate them. Send a message first, and rate them once they answer.',
      );
    }

    const body = dto.body?.trim() || null;
    const saved = await this.prisma.professionalReview.upsert({
      where: {
        professionalId_authorWawuId: { professionalId, authorWawuId },
      },
      create: { professionalId, authorWawuId, stars: dto.stars, body },
      update: { stars: dto.stars, body },
    });

    const rating = await this.ratingFor(professionalId);
    return {
      id: saved.id,
      professionalId: saved.professionalId,
      authorWawuId: saved.authorWawuId,
      stars: saved.stars,
      body: saved.body,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      ratingAvg: rating.ratingAvg,
      reviewCount: rating.reviewCount,
    };
  }

  /** The aggregate for one listing. Null average when nobody has reviewed it. */
  private async ratingFor(
    professionalId: string,
  ): Promise<{ ratingAvg: number | null; reviewCount: number }> {
    const agg = await this.prisma.professionalReview.aggregate({
      where: { professionalId },
      _avg: { stars: true },
      _count: { _all: true },
    });
    return {
      ratingAvg: roundToOneDecimal(agg._avg.stars),
      reviewCount: agg._count._all,
    };
  }
}

/**
 * A listing with the directory's extras. `dmPrice` (whole naira, the older
 * routes' unit) becomes `messagePriceKobo`, and only while they are taking
 * messages: a price on somebody who is not is a button that dead-ends.
 */
function withExtras(
  item: ProfessionalListItem,
  extras: {
    cityBy: Map<string, string>;
    replyBy: Map<string, ReplyTimeStats>;
  },
): ProfessionalDirectoryEntry {
  const { dmPrice, ...rest } = item;
  const reply = extras.replyBy.get(item.wawuId) ?? NO_REPLY_STATS;
  return {
    ...rest,
    field: fieldForCategory(item.category),
    city: extras.cityBy.get(item.wawuId) ?? null,
    usualReplyMinutes: reply.usualReplyMinutes,
    answeredMessageCount: reply.answeredCount,
    messagePriceKobo: item.dmEnabled && dmPrice !== null ? dmPrice * 100 : null,
  };
}

/**
 * One decimal, the precision the card prints ("4.9").
 *
 * Null in, null out. Rounding "no reviews" into 0.0 would put a zero-star
 * rating on every professional nobody has got to yet, which reads as a
 * verdict rather than an absence.
 */
function roundToOneDecimal(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10) / 10;
}

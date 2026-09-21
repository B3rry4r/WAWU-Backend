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
import { AccountType, ContentStatus } from '../../generated/prisma/enums';
import type { ApplyProfessionalDto } from './dto/apply-professional.dto';
import type { ListProfessionalsQueryDto } from './dto/list-professionals-query.dto';
import { isRegulatedCategory } from './professional-categories';

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
    const page = query.page ?? 1;
    const perPage = query.perPage ?? DEFAULT_PER_PAGE;
    const where = {
      status: 'approved' as const,
      listed: true,
      ...(query.category ? { category: query.category } : {}),
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
    const [identities, profiles, states, pieceCounts] = await Promise.all([
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

    const [identities, profile, state, pieceCount] = await Promise.all([
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
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, ReferralCode } from '../../../generated/prisma/client';
import { WaitlistStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PLANS_CONFIG,
  priceIn,
  tierById,
  type PlansConfig,
} from '../../plans/plans-config';
import { WaitlistError } from '../waitlist-error';
import { readReferralCode } from './referral-code';
import { ReferralService } from './referral.service';
import type {
  CreateReferralCodeDto,
  UpdateReferralCodeDto,
} from './referral.dto';
import type { AdminReferralCodeView } from './referral-view.type';

/** Prisma's unique-constraint refusal (P2002). */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i += 1) if (v.charCodeAt(i) < 0x20) return true;
  return false;
}

/**
 * The team's side of referral codes (REF-01): list them with their counts,
 * create one, change one. Codes are never deleted, only switched off. A price
 * or limit change touches only the row; registrations already started keep the
 * `amountKobo` they were made with, so it affects only those started after.
 */
@Injectable()
export class ReferralAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
  ) {}

  /**
   * The most a code may charge: the price of the offer open now, or, when none
   * is open, of the dearest offer in the plans file.
   */
  private ceilingKobo(now: Date, tier: string | null = null): number {
    // A code bound to a tier may charge up to that tier's own live price (R-125).
    if (tier !== null) {
      const t = tierById(this.plans, tier);
      if (t === null) throw this.tierUnknown();
      return priceIn(t.price, 'NGN');
    }
    const offers = this.plans.eventOffers;
    const open = offers.filter(
      (o) => o.openFrom <= now && (o.openUntil === null || now <= o.openUntil),
    );
    return Math.max(
      0,
      ...(open.length > 0 ? open : offers).map((o) => o.priceKobo),
    );
  }

  private tidyCommunity(raw: string): string {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t === '' || hasControlChar(raw))
      throw new WaitlistError(
        'referral_invalid',
        'Enter the name of the community this code is for.',
      );
    return t;
  }

  private tierUnknown(): WaitlistError {
    return new WaitlistError(
      'referral_invalid',
      'Choose a plan the app sells: verify, plus or founding.',
    );
  }

  private checkPrice(
    priceKobo: number,
    now: Date,
    tier: string | null = null,
  ): void {
    const ceiling = this.ceilingKobo(now, tier);
    if (priceKobo < 0 || priceKobo > ceiling)
      throw new WaitlistError(
        'referral_invalid',
        `The price must be from 0 to the standard price (${ceiling} kobo).`,
      );
  }

  private view(
    row: ReferralCode,
    paid: { count: number; kobo: number },
    held: number,
  ): AdminReferralCodeView {
    return {
      id: row.id,
      code: row.code,
      community: row.community,
      priceKobo: row.priceKobo,
      limit: row.usageLimit,
      active: row.active,
      paidCount: paid.count,
      heldCount: held,
      paidKobo: paid.kobo,
      tier: row.tier,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** GET /admin/waitlist/referral-codes: every code, the first made first. */
  async list(now: Date = new Date()): Promise<AdminReferralCodeView[]> {
    const rows = await this.prisma.referralCode.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const [paid, heldBy] = await Promise.all([
      this.prisma.waitlistRegistration.groupBy({
        by: ['referralCode'],
        where: { referralCode: { not: null }, status: WaitlistStatus.paid },
        _count: { _all: true },
        _sum: { paidKobo: true },
      }),
      // Held places are people, as the registration counts them (D3).
      new ReferralService(this.prisma).heldByCode(this.prisma, now),
    ]);
    const paidBy = new Map(
      paid.map((p) => [
        p.referralCode,
        { count: p._count._all, kobo: p._sum.paidKobo ?? 0 },
      ]),
    );
    return rows.map((r) =>
      this.view(
        r,
        paidBy.get(r.code) ?? { count: 0, kobo: 0 },
        heldBy.get(r.code) ?? 0,
      ),
    );
  }

  private async one(
    id: string,
    now: Date = new Date(),
  ): Promise<AdminReferralCodeView> {
    const list = await this.list(now);
    const found = list.find((c) => c.id === id);
    if (!found) throw this.notFound();
    return found;
  }

  private notFound(): WaitlistError {
    return new WaitlistError(
      'referral_not_found',
      'We could not find that referral code.',
    );
  }

  /** POST /admin/waitlist/referral-codes. */
  async create(
    dto: CreateReferralCodeDto,
    adminId: string | null,
    now: Date = new Date(),
  ): Promise<AdminReferralCodeView> {
    const code = readReferralCode(dto.code);
    if (code === null)
      throw new WaitlistError(
        'referral_invalid',
        'A referral code is 3 to 20 letters and numbers.',
      );
    const community = this.tidyCommunity(dto.community);
    const tier = dto.tier === undefined || dto.tier === '' ? null : dto.tier;
    this.checkPrice(dto.priceKobo, now, tier);
    let row: ReferralCode;
    try {
      row = await this.prisma.referralCode.create({
        data: {
          code,
          community,
          priceKobo: dto.priceKobo,
          usageLimit: dto.limit ?? null,
          tier,
          active: dto.active ?? true,
          createdBy: adminId,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new WaitlistError(
          'referral_code_taken',
          'That referral code already exists. Change it, or edit the existing one.',
        );
      throw e;
    }
    return this.view(row, { count: 0, kobo: 0 }, 0);
  }

  /** PATCH /admin/waitlist/referral-codes/{id}. */
  async update(
    id: string,
    dto: UpdateReferralCodeDto,
    now: Date = new Date(),
  ): Promise<AdminReferralCodeView> {
    const data: Prisma.ReferralCodeUpdateInput = {};
    if (dto.community !== undefined)
      data.community = this.tidyCommunity(dto.community);
    const tierChange =
      dto.tier === undefined ? undefined : dto.tier === '' ? null : dto.tier;
    if (dto.priceKobo !== undefined || tierChange !== undefined) {
      // The price is checked against the tier it will be charged for, whichever
      // of the two changed (the other is read from the code as it is now).
      const current = await this.prisma.referralCode.findUnique({
        where: { id },
        select: { priceKobo: true, tier: true },
      });
      if (current === null) throw this.notFound();
      const tier = tierChange === undefined ? current.tier : tierChange;
      const price = dto.priceKobo ?? current.priceKobo;
      this.checkPrice(price, now, tier);
      if (dto.priceKobo !== undefined) data.priceKobo = dto.priceKobo;
      if (tierChange !== undefined) data.tier = tierChange;
    }
    if (dto.limit !== undefined) data.usageLimit = dto.limit;
    if (dto.active !== undefined) data.active = dto.active;
    if (Object.keys(data).length === 0)
      throw new WaitlistError(
        'referral_invalid',
        'Send at least one thing to change: the community, the price, the limit or whether it is on.',
      );
    const done = await this.prisma.referralCode.updateMany({
      where: { id },
      data,
    });
    if (done.count === 0) throw this.notFound();
    return this.one(id, now);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, ReferralCode } from '../../../generated/prisma/client';
import { WaitlistStatus } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { REFERRAL_HOLD_MS } from '../waitlist-config';
import { WaitlistError } from '../waitlist-error';
import { readReferralCode } from './referral-code';
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
  private ceilingKobo(now: Date): number {
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

  private checkPrice(priceKobo: number, now: Date): void {
    const ceiling = this.ceilingKobo(now);
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** GET /admin/waitlist/referral-codes: every code, the first made first. */
  async list(now: Date = new Date()): Promise<AdminReferralCodeView[]> {
    const rows = await this.prisma.referralCode.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const [paid, held] = await Promise.all([
      this.prisma.waitlistRegistration.groupBy({
        by: ['referralCode'],
        where: { referralCode: { not: null }, status: WaitlistStatus.paid },
        _count: { _all: true },
        _sum: { paidKobo: true },
      }),
      this.prisma.waitlistRegistration.groupBy({
        by: ['referralCode'],
        where: {
          referralCode: { not: null },
          status: WaitlistStatus.pending,
          createdAt: { gt: new Date(now.getTime() - REFERRAL_HOLD_MS) },
        },
        _count: { _all: true },
      }),
    ]);
    const paidBy = new Map(
      paid.map((p) => [
        p.referralCode,
        { count: p._count._all, kobo: p._sum.paidKobo ?? 0 },
      ]),
    );
    const heldBy = new Map(held.map((h) => [h.referralCode, h._count._all]));
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
    this.checkPrice(dto.priceKobo, now);
    let row: ReferralCode;
    try {
      row = await this.prisma.referralCode.create({
        data: {
          code,
          community,
          priceKobo: dto.priceKobo,
          usageLimit: dto.limit ?? null,
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
    if (dto.priceKobo !== undefined) {
      this.checkPrice(dto.priceKobo, now);
      data.priceKobo = dto.priceKobo;
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

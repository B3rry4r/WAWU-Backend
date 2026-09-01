import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReferralService, type AdminReferralCodeView } from '../../referral/referral.service';
import { PRICE_TABLE } from '../../creator-subscription/creator-subscription.service';
import type {
  CreateReferralCodeDto,
  UpdateReferralCodeDto,
} from '../../referral/dto/referral.dto';

/**
 * Referral-code administration.
 *
 * The admin view carries usage and the label; the public one does not — see
 * ReferralCodeView. Two explicit shapes rather than returning the Prisma row,
 * because a Prisma model re-exported as a wire type leaks every column added
 * to it later, and TypeScript will not catch it (a wider object satisfies a
 * narrower declared type).
 */
@Injectable()
export class AdminReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly referral: ReferralService,
  ) {}

  private toView(row: {
    code: string;
    label: string;
    discountPercent: number;
    tier: keyof typeof PRICE_TABLE;
    active: boolean;
    maxUses: number | null;
    usedCount: number;
    expiresAt: Date | null;
    createdAt: Date;
  }): AdminReferralCodeView {
    const originalPriceNaira = PRICE_TABLE[row.tier];
    return {
      code: row.code,
      label: row.label,
      discountPercent: row.discountPercent,
      tier: row.tier,
      originalPriceNaira,
      priceNaira: this.referral.discountedPrice(originalPriceNaira, row.discountPercent),
      active: row.active,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(): Promise<AdminReferralCodeView[]> {
    const rows = await this.prisma.referralCode.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async create(dto: CreateReferralCodeDto, adminId: string): Promise<AdminReferralCodeView> {
    const code = ReferralService.normalise(dto.code);
    const existing = await this.prisma.referralCode.findUnique({ where: { code } });
    // Codes are matched case-insensitively, so "Launch" and "LAUNCH" are the
    // same code — saying so is better than silently overwriting one.
    if (existing) throw new ConflictException('That code already exists.');

    const row = await this.prisma.referralCode.create({
      data: {
        code,
        label: dto.label,
        discountPercent: dto.discountPercent,
        tier: dto.tier,
        maxUses: dto.maxUses ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdByAdmin: adminId,
      },
    });
    return this.toView(row);
  }

  async update(rawCode: string, dto: UpdateReferralCodeDto): Promise<AdminReferralCodeView> {
    const code = ReferralService.normalise(rawCode);
    const exists = await this.prisma.referralCode.findUnique({ where: { code } });
    if (!exists) throw new NotFoundException('No such code.');

    // The TIER is deliberately not editable. A code is issued against a price;
    // repointing it at another plan silently changes what everybody holding it
    // was promised. Deactivate it and issue a new one instead.
    const row = await this.prisma.referralCode.update({
      where: { code },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.discountPercent !== undefined ? { discountPercent: dto.discountPercent } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.maxUses !== undefined ? { maxUses: dto.maxUses } : {}),
        ...(dto.expiresAt !== undefined ? { expiresAt: new Date(dto.expiresAt) } : {}),
      },
    });
    return this.toView(row);
  }

  /**
   * Deactivates rather than deletes.
   *
   * The redemption rows are how "who joined through this blog" is answerable,
   * which is the whole reason a blog gets a code. Deleting the code would
   * cascade them away and take the answer with it.
   */
  async deactivate(rawCode: string): Promise<AdminReferralCodeView> {
    return this.update(rawCode, { active: false });
  }
}

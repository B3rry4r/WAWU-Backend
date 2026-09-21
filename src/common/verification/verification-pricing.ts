import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { VerificationKindValue } from './verification-state';

/**
 * WHAT A TICK COSTS, AND WHERE THAT NUMBER LIVES.
 *
 * Not in a service. A price is a commercial decision, and the only reason
 * every rate in this backend is currently a module constant is that nothing
 * had asked to change one without a deploy yet. `PlatformSettings` was
 * declared for exactly this ("flipped from the dashboard, not from a deploy")
 * and had no reader until now; the two price columns live there and this is
 * the only thing that reads them.
 *
 * The constants below are the DEFAULTS the column defaults were written from,
 * and the fallback when the settings row has not been created. They are not a
 * second source of truth: whenever a row exists, the row wins.
 *
 * Naira, whole numbers. There is no other currency in this product.
 */
export const DEFAULT_VERIFICATION_PRICE_NGN: Record<
  VerificationKindValue,
  number
> = {
  creator: 4999,
  professional: 9999,
};

/** The single settings row. `PlatformSettings.id` defaults to 1 by design. */
const SETTINGS_ID = 1;

export interface VerificationPrices {
  creator: number;
  professional: number;
  /** Naira. Stated so a client never has to assume it. */
  currency: 'NGN';
  /** Both ticks are sold by the year. */
  termMonths: 12;
}

@Injectable()
export class VerificationPricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Both prices, as configured.
   *
   * Reads rather than upserts. A price lookup happens on every pricing screen
   * and should not write; the row is created the first time an admin changes
   * a price, and until then the defaults stand in.
   */
  async prices(): Promise<VerificationPrices> {
    const row = await this.prisma.platformSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: {
        creatorVerificationPriceNgn: true,
        professionalVerificationPriceNgn: true,
      },
    });
    return {
      creator:
        row?.creatorVerificationPriceNgn ??
        DEFAULT_VERIFICATION_PRICE_NGN.creator,
      professional:
        row?.professionalVerificationPriceNgn ??
        DEFAULT_VERIFICATION_PRICE_NGN.professional,
      currency: 'NGN',
      termMonths: 12,
    };
  }

  /** What one tick costs today, in whole naira. */
  async priceFor(kind: VerificationKindValue): Promise<number> {
    const all = await this.prices();
    return kind === 'creator' ? all.creator : all.professional;
  }
}

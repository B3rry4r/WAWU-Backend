import { BadRequestException, Injectable } from '@nestjs/common';
import { commissionRate } from '../event-ticketing/event-ticketing.constants';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import type { ContentSaleTerms } from './content-sale-terms.type';

const KOBO = 100;

/** The four quick prices, in the order the price step draws them (admin settings, FIX-110). */
export const CONTENT_PRESET_KEYS = [
  'content.price_preset_1_kobo',
  'content.price_preset_2_kobo',
  'content.price_preset_3_kobo',
  'content.price_preset_4_kobo',
] as const;

/** What a review usually takes, in hours (admin setting, FIX-110). */
export const CONTENT_REVIEW_HOURS_KEY = 'content.review_hours';

/**
 * What a creator is told on the create flow's price step and on "Sent for
 * review" (M24, M25, FIX-110): the share they keep, what that is at the price
 * they are typing, the listing fee and the quick prices. Every figure is the
 * Hub's, so the app never multiplies or divides money (R-21).
 *
 * - The share is the one split (R-5, 85/15), read from the same commission
 *   config every sale snapshots, rounded down to the kobo like the sale.
 * - There is no listing fee: registration, profile creation and listing are
 *   free (B1), nothing charges one, so the Hub says 0. A fee would be a new
 *   charge in the create flow, with its own setting and its own task.
 * - The quick prices and the review hours are admin settings, read every
 *   time, so an edit shows with no restart.
 */
@Injectable()
export class ContentSaleTermsService {
  constructor(private readonly settings: PlanSettingsService) {}

  terms(priceKobo: number | undefined): ContentSaleTerms {
    if (priceKobo !== undefined && priceKobo % KOBO !== 0) {
      throw new BadRequestException(
        'The price must be a whole number of naira.',
      );
    }
    const creatorSharePct = Math.round((1 - commissionRate()) * 100);
    return {
      creatorSharePct,
      listingFeeKobo: 0,
      presets: CONTENT_PRESET_KEYS.map((key) => ({
        priceKobo: this.settings.number(key),
      })),
      reviewHours: this.settings.number(CONTENT_REVIEW_HOURS_KEY),
      priceKobo: priceKobo ?? null,
      earnPerSaleKobo:
        priceKobo === undefined
          ? null
          : Math.floor((priceKobo * creatorSharePct) / 100),
    };
  }
}

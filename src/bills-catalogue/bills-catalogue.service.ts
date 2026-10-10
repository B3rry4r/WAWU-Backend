import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FintavaClient } from '../fintava/fintava-client';
import { FintavaError } from '../fintava/fintava-error';
import type { FintavaDisco } from '../fintava/fintava.interface';
import { PersonWindowLimiter } from '../money/person-window-limiter';
import { BillsError, BILLS_RETRY_AFTER_SECONDS } from './bills-catalogue-error';
import {
  readBillsCatalogueConfig,
  type BillsCatalogueConfig,
} from './bills-catalogue-config';
import type { MeterPreviewDto } from './bills-catalogue.dto';
import type {
  ElectricityBillersView,
  MeterPreviewView,
} from './bills-catalogue.views';
import { electricityBillers } from './electricity-billers';

/**
 * Fintava answers like this when its bills service cannot be used at all, however often we ask: no key or base URL in
 * config, a refused key, an inactive merchant. That is "bills are not switched on" (S13), not a failure to retry.
 */
const UNUSABLE = new Set<string>([
  'not_configured',
  'auth',
  'merchant_inactive',
]);

/**
 * The electricity catalogue and the meter check (BILLS-01, S2 to S4, S10 and S13), read from Fintava through its client
 * (MONEY-06). The app never talks to Fintava; it reads these two answers. Nothing here moves or reads money.
 *
 * - The disco list is kept for `BILLS_CATALOGUE_CACHE_SECONDS` (PROVISIONAL, 60) and asked once at a time, so the screens
 *   that open it together cost one call. A list that failed is never kept.
 * - A meter check is the person's own call, counted per person after the token is verified.
 * - Nothing a meter check answers is logged: the name and address on a meter belong to someone else.
 */
@Injectable()
export class BillsCatalogueService {
  private readonly config: BillsCatalogueConfig;
  readonly limiter: PersonWindowLimiter;
  private kept: { at: number; discos: FintavaDisco[] } | null = null;
  private asking: Promise<FintavaDisco[]> | null = null;
  /** The clock; a test may replace it. */
  now: () => number = () => Date.now();

  constructor(
    private readonly fintava: FintavaClient,
    config: ConfigService,
  ) {
    this.config = readBillsCatalogueConfig(config);
    this.limiter = new PersonWindowLimiter(
      [
        {
          name: 'minute',
          limit: this.config.previewPerMinute,
          windowMs: 60_000,
        },
      ],
      (retryAfterSeconds) =>
        new BillsError(
          'bills_rate_limited',
          'You have checked a lot of meters. Wait a moment, then try again.',
          { retryAfterSeconds },
        ),
    );
  }

  private async discos(): Promise<FintavaDisco[]> {
    const ttlMs = this.config.cacheSeconds * 1000;
    if (this.kept && this.now() - this.kept.at < ttlMs) return this.kept.discos;
    this.asking ??= this.fintava
      .listDiscos()
      .then((discos) => {
        this.kept = { at: this.now(), discos };
        return discos;
      })
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }

  /** Reads Fintava's list. `null` is "bills cannot be used" (S13); anything else that fails is a 503 to try again. */
  private async read(): Promise<ElectricityBillersView | null> {
    let discos: FintavaDisco[];
    try {
      discos = await this.discos();
    } catch (e) {
      if (e instanceof FintavaError) {
        if (UNUSABLE.has(e.kind)) return null;
        throw this.unreachable();
      }
      throw e;
    }
    const billers = electricityBillers(discos, this.config.presetsKobo);
    return { available: billers.length > 0, billers };
  }

  private unreachable(): BillsError {
    return new BillsError(
      'provider_unreachable',
      'Bill payments are not available right now. Try again in a moment.',
      {
        retryAfterSeconds: BILLS_RETRY_AFTER_SECONDS,
      },
    );
  }

  /** S2 and S3: the companies Fintava lists as available, each with its plan, limits and quick amounts. */
  async electricityBillers(): Promise<ElectricityBillersView> {
    return (await this.read()) ?? { available: false, billers: [] };
  }

  /** S4 and S10: the name (and address) on a meter, or 422 `meter_not_found`. */
  async previewMeter(
    wawuUserId: string,
    dto: MeterPreviewDto,
  ): Promise<MeterPreviewView> {
    const view = await this.read();
    if (view === null) {
      throw new BillsError(
        'bills_unavailable',
        "Bill payments aren't switched on yet.",
      );
    }
    const biller = view.billers.find((b) => b.code === dto.code);
    if (!biller) {
      throw new BillsError(
        'biller_not_found',
        'That electricity company is not available now. Pick one from the list.',
      );
    }
    this.limiter.take(wawuUserId);
    try {
      const preview = await this.fintava.previewMeter({
        meterNumber: dto.meterNumber,
        disco: biller.code,
        planType: biller.plan,
      });
      if (preview === null) {
        throw new BillsError(
          'meter_not_found',
          "We couldn't find this meter. Check the number.",
        );
      }
      return {
        meterNumber: dto.meterNumber,
        code: biller.code,
        plan: biller.plan,
        name: preview.ownerName,
        address: preview.ownerAddress,
      };
    } catch (e) {
      if (e instanceof FintavaError) {
        if (UNUSABLE.has(e.kind))
          throw new BillsError(
            'bills_unavailable',
            "Bill payments aren't switched on yet.",
          );
        // A refusal in Fintava's validation shape is a number it cannot read: not a meter it knows.
        if (e.kind === 'validation')
          throw new BillsError(
            'meter_not_found',
            "We couldn't find this meter. Check the number.",
          );
        throw this.unreachable();
      }
      throw e;
    }
  }
}

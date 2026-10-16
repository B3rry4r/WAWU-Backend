import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FintavaClient } from '../fintava/fintava-client';
import { FintavaError } from '../fintava/fintava-error';
import {
  isNotAnOwner,
  nameWordsOf,
  withoutLeadingInvisible,
} from '../fintava/fintava-meter-answer';
import type { FintavaDisco } from '../fintava/fintava.interface';
import { PersonWindowLimiter } from '../money/person-window-limiter';
import { BillsError, BILLS_RETRY_AFTER_SECONDS } from './bills-catalogue-error';
import {
  BILLS_CATALOGUE_DEFAULTS,
  readBillsCatalogueConfig,
  type BillsCatalogueConfig,
} from './bills-catalogue-config';
import type { MeterPreviewDto } from './bills-catalogue.dto';
import type {
  ElectricityBillerView,
  ElectricityBillersView,
  MeterPreviewView,
} from './bills-catalogue.views';
import { companyShortNames, electricityBillers } from './electricity-billers';
import { boundBytes, clipGraphemes } from './graphemes';

/**
 * Fintava answers like this when its bills service cannot be used at all, however often we ask: no key or base URL in
 * config, a refused key, an inactive merchant. That is "bills are not switched on" (S13), not a failure to retry.
 */
const UNUSABLE = new Set<string>([
  'not_configured',
  'auth',
  'merchant_inactive',
]);

/** The most characters of Fintava's text (an owner's name or address) the Hub passes on (D9). */
export const PROVIDER_TEXT_MAX = 200;

/**
 * Text cut to `PROVIDER_TEXT_MAX` characters a person sees, without trailing spaces. The spaces and invisible characters at
 * its start come off first (a name that opens with 250 zero-width spaces would be cut to nothing but them otherwise), then
 * the text is read only as far as `maxBytes` bytes (R3-6: a name of five megabytes costs no more than one of that size),
 * then the cut falls between graphemes (R2-5): a family emoji, a flag, or a letter with its accent is kept whole or left
 * out whole, never split. When the byte bound cut the text, its last grapheme may be only part of one and is left out.
 */
export function clipProviderText(
  text: string,
  maxBytes: number = BILLS_CATALOGUE_DEFAULTS.providerTextMaxBytes,
): string {
  const { text: bounded, cut } = boundBytes(
    withoutLeadingInvisible(text),
    maxBytes,
  );
  return clipGraphemes(bounded, PROVIDER_TEXT_MAX, undefined, cut).trimEnd();
}

/** A name as compared with a company's: lower case, letters and digits only. */
function nameForm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The electricity catalogue and the meter check (BILLS-01, S2 to S4, S10 and S13), read from Fintava through its client
 * (MONEY-06). The app never talks to Fintava; it reads these two answers. Nothing here moves or reads money.
 *
 * - The disco list is kept for `BILLS_CATALOGUE_CACHE_SECONDS` (PROVISIONAL, 60) and asked once at a time, so the screens
 *   that open it together cost one call. A list that failed is never kept.
 * - A meter check is the person's own call, counted per person after the token is verified.
 * - Nothing a meter check answers is logged: the name and address on a meter belong to someone else.
 * - A meter is "found" only for an owner's name that is not the company's own. The success body has never been seen, so
 *   everything else (no name, an unreadable body, a name that is the company's) is an answer that is not green.
 * - A check that finds Fintava's bills service off holds "off" for the cache window (R2-U1): the
 *   list says `available: false` without asking Fintava, so a list that still answers cannot flip S2 back to the normal
 *   screen a moment after the check sent the person to S13. Once the window passes, the next ask goes to Fintava again.
 */
@Injectable()
export class BillsCatalogueService {
  private readonly config: BillsCatalogueConfig;
  readonly limiter: PersonWindowLimiter;
  private kept: { at: number; discos: FintavaDisco[] } | null = null;
  private asking: Promise<FintavaDisco[]> | null = null;
  /** Until when a check that found bills off holds "off" (milliseconds on `now`); null when none does. */
  private offUntil: number | null = null;
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
    if (this.offUntil !== null) {
      if (this.now() < this.offUntil) return null;
      this.offUntil = null;
    }
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
      const name = clipProviderText(
        preview.ownerName,
        this.config.providerTextMaxBytes,
      );
      // A name with nothing left once the invisible start is off and the bound has cut (the text starts with a character a
      // person can see, so only the cut can leave nothing), or the company's own, says nothing about who owns the meter
      // (R3-6, R3-1).
      if (name === '' || this.isCompanyName(name, biller)) {
        throw this.unconfirmed();
      }
      const address =
        preview.ownerAddress === null
          ? ''
          : clipProviderText(
              preview.ownerAddress,
              this.config.providerTextMaxBytes,
            );
      return {
        meterNumber: dto.meterNumber,
        code: biller.code,
        plan: biller.plan,
        name,
        address: address === '' ? null : address,
      };
    } catch (e) {
      if (e instanceof FintavaError) {
        if (UNUSABLE.has(e.kind) || e.serviceNotAvailable) {
          // The list we kept may still say "available", and Fintava's list may still answer: neither may flip S2 back to the
          // normal screen. Bills stay off for the cache window, without asking Fintava again (R2-U1); the kept list is
          // older than the window by then, so it is not read again either.
          this.offUntil = this.now() + this.config.cacheSeconds * 1000;
          throw new BillsError(
            'bills_unavailable',
            "Bill payments aren't switched on yet.",
          );
        }
        // A refusal in Fintava's validation shape is a number it cannot read: not a meter it knows.
        if (e.kind === 'validation')
          throw new BillsError(
            'meter_not_found',
            "We couldn't find this meter. Check the number.",
          );
        // An answer that is not a name and not a plain "no such meter".
        if (e.kind === 'bad_response') throw this.unconfirmed();
        throw this.unreachable();
      }
      throw e;
    }
  }

  private unconfirmed(): BillsError {
    return new BillsError(
      'meter_unconfirmed',
      "We couldn't confirm this meter. Try again.",
    );
  }

  /**
   * True when `name` is the company itself and not a person: its name, with either plan word, Fintava's own wording, its
   * code (the same letters and digits whatever the capitals, spaces and marks), or a name made only of the company's own
   * words (its name, code, description and short names such as IKEDC) and the words a company's name is made of (plc,
   * limited, distribution company, disco, electric, electricity, prepaid, bill payment; R3-1). One word that is none of
   * those makes it an owner: another company's name on this meter, or "Ikeja Ada".
   */
  private isCompanyName(name: string, biller: ElectricityBillerView): boolean {
    const listed = this.kept?.discos.find((d) => d.code === biller.code);
    const own = [
      biller.name,
      `${biller.name} prepaid`,
      `${biller.name} postpaid`,
      biller.code,
      listed?.description,
    ];
    const given = nameForm(name);
    if (own.some((o) => o !== undefined && nameForm(o) === given)) return true;
    const words = new Set<string>();
    for (const text of [...own, ...companyShortNames(biller.code)]) {
      if (text !== undefined) for (const w of nameWordsOf(text)) words.add(w);
    }
    return isNotAnOwner(name, words);
  }
}

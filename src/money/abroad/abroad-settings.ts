import { Injectable } from '@nestjs/common';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';

/**
 * The admin settings of sending abroad (task NUV-11; registry in
 * src/plan-settings/plan-setting-registry.ts, group "Send abroad"): the
 * switch (default on), WAWU's fee in kobo (default 0, R-10), the most per
 * send and per day for each currency (none until named), and the countries
 * not offered. Read live on every request, so an admin's change takes hold
 * within the settings' refresh (15 seconds).
 */
@Injectable()
export class AbroadSettings {
  /** The partner's fee per corridor from the environment, read once and checked at boot (a wrong figure stops the server). */
  private readonly providerFees: ReadonlyMap<string, number>;

  constructor(private readonly plan: PlanSettingsService) {
    this.providerFees = readProviderFees(process.env);
  }

  /** What the payment partner charges on top for a send, or null when no figure is configured (R-10). */
  providerFeeMinor(
    source: string,
    destination: string,
    method: 'bank' | 'mobile_money',
  ): number | null {
    return providerFeeFor(this.providerFees, source, destination, method);
  }

  get enabled(): boolean {
    return this.plan.number('abroad.enabled') === 1;
  }

  /** WAWU's fee for one send, in kobo, taken from the naira wallet. */
  get wawuFeeKobo(): number {
    return this.plan.number('abroad.wawu_fee_kobo');
  }

  maxPerSend(currency: string): number | null {
    return limitOf(this.plan.lines('abroad.max_per_send'), currency);
  }

  maxPerDay(currency: string): number | null {
    return limitOf(this.plan.lines('abroad.max_per_day'), currency);
  }

  countriesOff(): Set<string> {
    return new Set(this.plan.lines('abroad.corridors_off'));
  }
}

/** The figure on a `USD 500000` line for a currency, or null when none is set. */
export function limitOf(lines: string[], currency: string): number | null {
  for (const line of lines) {
    const [code, amount] = line.split(' ');
    if (code === currency) return Number(amount);
  }
  return null;
}

const FEE_PREFIX = 'ABROAD_PROVIDER_FEE_';

/**
 * `ABROAD_PROVIDER_FEE_<DESTINATION>_<RAIL>` (`GHS_MOBILE_MONEY`, `AUD_BANK`): the partner's fee for a send to that currency and
 * rail, in USD cents: what the dev server charged a dollar account (24 Oct 2026, USD to GHS mobile money: 150). A fee that differs by
 * the sending currency is named `..._FROM_<SOURCE>` (`ABROAD_PROVIDER_FEE_AUD_BANK_FROM_NGN=0`, in kobo) and wins for that source.
 * A source with neither is not estimated (null): the review then says the receipt names the fee. Each value is a whole number of
 * the sending currency's smallest unit; a value that is set and wrong stops the server at boot, naming it.
 */
export function readProviderFees(
  env: Record<string, string | undefined>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(FEE_PREFIX) || raw === undefined || raw.trim() === '')
      continue;
    const name = key.slice(FEE_PREFIX.length);
    if (!/^[A-Z]{3,4}_(BANK|MOBILE_MONEY)(_FROM_[A-Z]{3,4})?$/.test(name)) {
      throw new Error(
        `${key} is not a setting of this kind: use ${FEE_PREFIX}<CURRENCY>_<BANK or MOBILE_MONEY> and optionally _FROM_<CURRENCY>.`,
      );
    }
    if (!/^[0-9]{1,12}$/.test(raw.trim())) {
      throw new Error(
        `${key} must be a whole number of the sending currency's smallest unit (for example 150 for USD 1.50).`,
      );
    }
    out.set(name, Number(raw.trim()));
  }
  return out;
}

export function providerFeeFor(
  fees: ReadonlyMap<string, number>,
  source: string,
  destination: string,
  method: 'bank' | 'mobile_money',
): number | null {
  const rail = method === 'mobile_money' ? 'MOBILE_MONEY' : 'BANK';
  const base = `${destination}_${rail}`;
  const specific = fees.get(`${base}_FROM_${source}`);
  if (specific !== undefined) return specific;
  // The plain figure is the dollar one.
  return source === 'USD' ? (fees.get(base) ?? null) : null;
}

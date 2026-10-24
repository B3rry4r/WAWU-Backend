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
  constructor(private readonly plan: PlanSettingsService) {}

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

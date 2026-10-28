import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { FX_CURRENCIES } from '../fx-currencies';
import { FxSettings } from '../fx-settings';

/**
 * NUVION-FIX 10.1 (Nuvion's answer 10, 27 Oct 2026): every amount at Nuvion uses 2 decimals in minor units (100 is 1.00),
 * stablecoins included; the docs' six places are a typo. A setting that could move a currency off 2 could make every amount
 * 10,000 times too big or too small, so there is none: decimals are always 2.
 */

const plan = { number: () => 1 } as unknown as PlanSettingsService;
const config = (env: Record<string, string>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

describe('NUVION-FIX 10.1: decimals are always 2', () => {
  it('every currency counts 2 places, whatever FX_DECIMALS_<CODE> says', () => {
    const env: Record<string, string> = {};
    for (const c of FX_CURRENCIES) env[`FX_DECIMALS_${c.code}`] = '6';
    env.FX_DECIMALS_NGN = '0';
    const settings = new FxSettings(config(env), plan);
    for (const c of FX_CURRENCIES) {
      expect(settings.decimalsOf(c.code)).toBe(2);
      expect(c.decimals).toBe(2);
    }
    expect(settings.decimalsOf('NGN')).toBe(2);
  });

  it('the setting is gone from .env.example, the settings code and the conventions', () => {
    const root = join(__dirname, '../../../..');
    const read = (p: string) => readFileSync(join(root, p), 'utf8');
    expect(read('.env.example')).not.toContain('FX_DECIMALS');
    expect(read('src/money/fx/fx-settings.ts')).not.toContain('FX_DECIMALS');
    expect(read('src/money/fx/fx-currencies.ts')).not.toContain('FX_DECIMALS');
    expect(read('docs/contract/CONVENTIONS.md')).not.toContain('FX_DECIMALS');
    expect(read('docs/contract/CONVENTIONS.md')).not.toMatch(
      /decimals[^.]*read from config/,
    );
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { loadPlanSettingsDefaults } from '../../../plan-settings/plan-settings-defaults';
import { buildRegistry } from '../../../plan-settings/plan-setting-registry';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import { AddMoneySettings } from '../add-money-config';
import {
  AddMoneyService,
  PAID_REVIEW_AFTER_MS,
  statusLine,
} from '../add-money.service';

/**
 * NUVION-FIX (Nuvion's answers, 27 Oct 2026): naira cannot be added by card, mobile money or open banking, and card
 * acquiring is suspended in production. No database and no provider: the settings and the rails they allow.
 */

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const FULL_ENV: Record<string, string> = {
  ADD_MONEY_FEE_CARD: '75',
  ADD_MONEY_FEE_USSD: '0',
  ADD_MONEY_FEE_OPEN_BANKING: '0',
  NUVION_ENCRYPTION_PUBLIC_KEY: publicKey.replace(/\n/g, '\\n'),
  ADD_MONEY_RETURN_URL:
    'https://hub.test.example/api/hub/money/add-money/return',
};

function settingsOf(env: Record<string, string>): AddMoneySettings {
  return new AddMoneySettings(new ConfigService(env));
}

/** A service that can answer `railProblem` only: every collaborator it does not reach is a bare object. */
function serviceOf(
  env: Record<string, string>,
  planOn: boolean,
): AddMoneyService {
  const provider = {
    configured: true,
    addMoneyRails: ['card', 'apple_pay', 'ussd', 'open_banking'],
    startAddMoney: () => undefined,
    confirmAddMoney: () => undefined,
    readAddMoney: () => undefined,
    findAddMoney: () => undefined,
    cancelAddMoney: () => undefined,
  } as unknown as WalletProvider;
  const plan = {
    number: () => (planOn ? 1 : 0),
  } as unknown as PlanSettingsService;
  return new AddMoneyService(
    {} as unknown as PrismaService,
    provider,
    settingsOf(env),
    plan,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('NUVION-FIX 1.1: card and USSD rails are off until an admin switches them on', () => {
  it('the seed and the registry both read 0 for the two switches', () => {
    const seed = loadPlanSettingsDefaults();
    expect(seed.extras.values['money.add_money_card_on']).toBe(0);
    expect(seed.extras.values['money.add_money_ussd_on']).toBe(0);
    const registry = buildRegistry(seed.plans, seed.extras);
    for (const key of ['money.add_money_card_on', 'money.add_money_ussd_on']) {
      const def = registry.find((d) => d.key === key);
      expect(def?.default).toBe(0);
      expect(def?.label).not.toMatch(/the default\)/);
      // The note an admin reads names the reason and where it came from.
      expect(def?.provisional).toBe('ADD-MONEY-NGN-OFF');
    }
    expect(seed.extras.provisional['ADD-MONEY-NGN-OFF']).toContain('Nuvion');
  });

  it('with the switches at their default (0) every rail answers off, whatever is configured', () => {
    const s = serviceOf(
      { ...FULL_ENV, ADD_MONEY_USSD_CHANNEL: 'NG-MTN-C2B' },
      false,
    );
    for (const rail of ['card', 'apple_pay', 'ussd', 'open_banking'] as const) {
      expect(s.railProblem(rail)).not.toBeNull();
    }
  });
});

describe('NUVION-FIX 1.3: USSD only with an NG- channel, and no naira open banking', () => {
  it('a Kenyan or Tanzanian channel is not used for naira: USSD is not offered', () => {
    for (const channel of ['KE-SAFARICOM-C2B', 'TZ-VODACOM-C2B']) {
      const s = serviceOf(
        { ...FULL_ENV, ADD_MONEY_USSD_CHANNEL: channel },
        true,
      );
      expect(
        settingsOf({ ...FULL_ENV, ADD_MONEY_USSD_CHANNEL: channel })
          .ussdChannel,
      ).toBeNull();
      expect(s.railProblem('ussd')).not.toBeNull();
    }
  });

  it('an NG- channel offers USSD', () => {
    const env = { ...FULL_ENV, ADD_MONEY_USSD_CHANNEL: 'NG-MTN-C2B' };
    expect(settingsOf(env).ussdChannel).toBe('NG-MTN-C2B');
    expect(serviceOf(env, true).railProblem('ussd')).toBeNull();
  });

  it('a channel that is not shaped like a channel still stops the server at start', () => {
    expect(() =>
      settingsOf({ ...FULL_ENV, ADD_MONEY_USSD_CHANNEL: 'ng-mtn' }),
    ).toThrow(/ADD_MONEY_USSD_CHANNEL/);
  });

  it('open banking is never offered for naira, with the return address and the charge both set', () => {
    const s = serviceOf(
      { ...FULL_ENV, ADD_MONEY_USSD_CHANNEL: 'NG-MTN-C2B' },
      true,
    );
    expect(s.railProblem('open_banking')).toBe('This is not available.');
    const options = s.options();
    expect(options.rails.find((r) => r.rail === 'open_banking')).toMatchObject({
      available: false,
      reason: 'This is not available.',
    });
    // The other hosted way (Apple Pay) is untouched by it.
    expect(s.railProblem('apple_pay')).toBeNull();
  });
});

describe('NUVION-FIX 5.1: a card settles in 6 days, so the review waits 8', () => {
  it('the review timer is 8 days', () => {
    expect(PAID_REVIEW_AFTER_MS).toBe(8 * 24 * 60 * 60_000);
  });

  it('a card payment that is paid says when it reaches the wallet; other ways keep their words', () => {
    for (const rail of ['card', 'apple_pay']) {
      const line = statusLine({
        status: 'processing',
        rail,
        failureMessage: null,
      });
      expect(line).toContain(
        'Card payments reach your wallet in about 6 days.',
      );
      expect(line).not.toMatch(/a little while|\u2014/);
    }
    expect(
      statusLine({ status: 'processing', rail: 'ussd', failureMessage: null }),
    ).toBe(
      'Paid. Your wallet is being topped up. This can take a little while.',
    );
  });
});

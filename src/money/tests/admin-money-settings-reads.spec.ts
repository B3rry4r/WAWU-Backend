import type { ConfigService } from '@nestjs/config';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminCapitalController } from '../../capital/admin-capital.controller';
import { AdminCapitalService } from '../../capital/admin-capital.service';
import { CapitalSettings } from '../../capital/capital-config';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { AdminCardsController } from '../cards/admin-cards.controller';
import { AdminCardsService } from '../cards/admin-cards.service';
import { CardSettings } from '../cards/card-config';
import { FxAdminController } from '../fx/fx-admin.controller';
import { FxAdminService } from '../fx/fx-admin.service';
import { FxSettings } from '../fx/fx-settings';

/**
 * The three read-only admin routes the dashboard's money screens use
 * (OPS-27, R-83, R-84): the currencies with their switches, fees, daily limits
 * and places; the card settings; the Capital settings. They only read what the
 * Hub already holds, so these are plain unit checks with no database and no
 * provider: the values are those of the environment and the admin settings the
 * services are built with.
 */

function config(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function plan(values: Record<string, number>): PlanSettingsService {
  return {
    number: (key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`no setting ${key}`);
      return v;
    },
  } as unknown as PlanSettingsService;
}

const ALL_ON = {
  'fx.product.open_account.on': 1,
  'fx.product.swap.on': 1,
  'fx.product.crypto_send.on': 1,
  'fx.currency.USD.on': 1,
  'fx.currency.EUR.on': 1,
  'fx.currency.GBP.on': 1,
  'fx.currency.CAD.on': 1,
  'fx.currency.AED.on': 1,
  'fx.currency.GHS.on': 1,
  'fx.currency.USDT.on': 1,
  'fx.currency.USDC.on': 1,
  'fx.currency.RLUSD.on': 1,
};

function fxAdmin(env: Record<string, string>, values: Record<string, number>) {
  const settings = new FxSettings(config(env), plan(values));
  return new FxAdminService({} as never, {} as never, settings);
}

const rolesOf = (proto: object, name: string) =>
  [
    ...(Reflect.getMetadata(
      'adminRoles',
      (proto as Record<string, object>)[name],
    ) as string[]),
  ].sort();

describe('GET admin/money/fx/currencies', () => {
  it('lists the nine currencies with the places, switch, fee and limit in force', () => {
    const view = fxAdmin(
      {
        FX_SWAP_FEE_USD_MINOR: '150',
        FX_FEE_COLLECTOR_USD_BAN: 'ACC1234567',
        FX_SEND_FEE_USDT_MINOR: '250000',
        FX_FEE_COLLECTOR_USDT_BAN: 'ACC7654321',
        FX_DAILY_LIMIT_USD_MINOR: '500000',
        FX_SWAP_FEE_NGN_MINOR: '2500',
        FX_DAILY_LIMIT_NGN_MINOR: '100000000',
      },
      { ...ALL_ON, 'fx.currency.GBP.on': 0 },
    ).currencies();

    expect(view.currencies.map((c) => c.code)).toEqual([
      'USD',
      'EUR',
      'GBP',
      'CAD',
      'AED',
      'GHS',
      'USDT',
      'USDC',
      'RLUSD',
    ]);
    const by = Object.fromEntries(view.currencies.map((c) => [c.code, c]));
    // A coin counts 2 places like every other currency (Nuvion, 27 Oct 2026; NUVION-FIX 10.1): no setting changes it.
    expect(by.USDT).toMatchObject({
      currency: 'USDT',
      decimals: 2,
      kind: 'stablecoin',
      sendFeeMinor: 250000,
      enabled: true,
    });
    expect(by.USDC.decimals).toBe(2);
    expect(by.USD).toMatchObject({
      decimals: 2,
      swapFeeMinor: 150,
      sendFeeMinor: 0,
      dailyLimitMinor: 500000,
      enabled: true,
    });
    // A switch that is off shows off; a limit nobody set is null, a fee is 0.
    expect(by.GBP.enabled).toBe(false);
    expect(by.EUR).toMatchObject({ dailyLimitMinor: null, swapFeeMinor: 0 });
    expect(view.products).toEqual({
      openAccount: true,
      swap: true,
      cryptoSend: true,
    });
    expect(view.naira).toEqual({
      code: 'NGN',
      decimals: 2,
      swapFeeKobo: 2500,
      dailyLimitKobo: 100000000,
    });
  });

  it('shows a product that is switched off, and a switch that cannot be read as off', () => {
    const view = fxAdmin(
      {},
      {
        'fx.product.swap.on': 0,
        'fx.product.open_account.on': 1,
      },
    ).currencies();
    expect(view.products).toEqual({
      openAccount: true,
      swap: false,
      cryptoSend: false,
    });
    expect(view.currencies.every((c) => c.enabled === false)).toBe(true);
  });

  it('is superadmin and finance only, like every admin money route', () => {
    expect(rolesOf(FxAdminController.prototype, 'currencies')).toEqual([
      AdminRole.finance,
      AdminRole.superadmin,
    ]);
  });
});

describe('GET admin/money/cards/settings', () => {
  const cards = (env: Record<string, string>, values: Record<string, number>) =>
    new AdminCardsService(
      {} as never,
      {} as never,
      {} as never,
      new CardSettings(config(env)),
      plan(values),
    );

  it('reads the switch, both fees and both counts', () => {
    expect(
      cards(
        {
          NUVION_FEE_CARD_CREATE: '65772',
          WAWU_FEE_CARD_KOBO: '10000',
          WALLET_CARD_MAX_ACTIVE: '3',
          WALLET_CARD_MAX_PER_DAY: '4',
        },
        { 'cards.enabled': 1 },
      ).cardSettings(),
    ).toEqual({
      enabled: true,
      providerFeeKobo: 65772,
      wawuFeeKobo: 10000,
      maxActive: 3,
      maxPerDay: 4,
    });
  });

  it('shows the provider fee as null while it is not set, and the defaults', () => {
    expect(cards({}, { 'cards.enabled': 0 }).cardSettings()).toEqual({
      enabled: false,
      providerFeeKobo: null,
      wawuFeeKobo: 0,
      maxActive: 5,
      maxPerDay: 10,
    });
  });

  it('is superadmin and finance only', () => {
    expect(rolesOf(AdminCardsController.prototype, 'settings')).toEqual([
      AdminRole.finance,
      AdminRole.superadmin,
    ]);
  });
});

describe('GET admin/capital/orders/settings', () => {
  const capital = (
    env: Record<string, string>,
    values: Record<string, number>,
  ) =>
    new AdminCapitalService(
      {} as never,
      plan(values),
      new CapitalSettings(config(env)),
    );

  it('reads the switch, the limits and the fee rule', () => {
    expect(
      capital(
        {
          CAPITAL_MIN_KOBO: '500000',
          CAPITAL_MAX_KOBO: '50000000',
          CAPITAL_DAILY_MAX_KOBO: '100000000',
          CAPITAL_WAWU_FEE_KOBO: '5000',
          CAPITAL_WAWU_FEE_BPS: '50',
        },
        { 'capital.enabled': 0 },
      ).capitalSettings(),
    ).toEqual({
      enabled: false,
      minKobo: 500000,
      maxKobo: 50000000,
      dailyMaxKobo: 100000000,
      feeFlatKobo: 5000,
      feeBasisPoints: 50,
    });
  });

  it('shows no limit as null and no fee as zero', () => {
    expect(capital({}, { 'capital.enabled': 1 }).capitalSettings()).toEqual({
      enabled: true,
      minKobo: null,
      maxKobo: null,
      dailyMaxKobo: null,
      feeFlatKobo: 0,
      feeBasisPoints: 0,
    });
  });

  it('is superadmin and finance only', () => {
    expect(rolesOf(AdminCapitalController.prototype, 'settings')).toEqual([
      AdminRole.finance,
      AdminRole.superadmin,
    ]);
  });
});

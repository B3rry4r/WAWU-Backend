import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FX_ENTITY, FxStandin } from '../../../../test/nuvion/fx-standin';
import { NuvionStandin } from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
import { NuvionFxArea } from '../../../nuvion/areas/fx';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import type { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import { FxAccountsService } from '../../fx/fx-accounts.service';
import { FxController } from '../../fx/fx.controller';
import { MoneyDeviceController } from '../../pin/money-device.controller';
import { MoneyPinController } from '../../pin/money-pin.controller';
import { MoneyPinResetController } from '../../pin/money-pin-reset.controller';
import { FxOperationsService } from '../../fx/fx-operations.service';
import { FxPort } from '../../fx/fx-provider';
import { FxSettings } from '../../fx/fx-settings';
import {
  type OpenWallet,
  WORLD_WALLET_OK,
  worldWalletOf,
} from '../../gate/wallet-gate';
import type { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import type {
  IdempotencyScope,
  IdempotencyService,
} from '../../payments/idempotency';

/**
 * WALLET-41 round 1 (G-WALLET-41-3): a person outside Nigeria has no naira
 * wallet, and swaps between their foreign accounts and coins and sends coins
 * out all the same. The foreign-account services over the real database and
 * the Nuvion stand-in (dev-shaped answers, test/nuvion/fx-standin.ts).
 */

jest.setTimeout(60_000);

const USER = 'b29world-fx-user';
const WALLET: OpenWallet = {
  wawuUserId: USER,
  customerId: FX_ENTITY,
  walletId: '',
  accountNumber: '',
};
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => (e instanceof MoneyError ? e.code : String(e)),
  );

describe('a world wallet swaps and sends (WALLET-41, G-WALLET-41-3)', () => {
  const standin = new NuvionStandin();
  const fx = new FxStandin(standin);
  const prisma = new PrismaService();
  let guard: OutboundGuard;
  let area: NuvionFxArea;
  let accounts: FxAccountsService;
  let ops: FxOperationsService;
  const ledgerRows: Array<Record<string, unknown>> = [];
  let n = 0;

  const scope = (route: string): IdempotencyScope => {
    n += 1;
    return {
      wawuUserId: USER,
      method: 'POST',
      route,
      key: `w-${n}`,
      fingerprint: `f-${n}`,
    };
  };

  function build() {
    const settings = new FxSettings(
      { get: () => undefined } as unknown as ConfigService,
      { number: () => 1 } as unknown as PlanSettingsService,
    );
    const provider = {
      name: 'nuvion',
      label: 'Nuvion',
      configured: true,
      fx: area,
      // A world wallet has no naira account: asked for one, the test fails loudly.
      getBalance: () => Promise.reject(new Error('no naira account')),
    } as unknown as WalletProvider;
    const port = new FxPort(provider);
    accounts = new FxAccountsService(port, prisma, settings);
    const idem = {
      attach: () => Promise.resolve(),
      finish: () => Promise.resolve(),
      release: () => Promise.resolve(),
    } as unknown as IdempotencyService;
    const ledger = {
      record: (row: Record<string, unknown>) => {
        ledgerRows.push(row);
        return Promise.resolve({
          entryId: 'e',
          created: true,
          discrepancy: null,
        });
      },
    } as unknown as LedgerService;
    ops = new FxOperationsService(
      port,
      prisma,
      settings,
      accounts,
      idem,
      ledger,
    );
  }

  async function clean() {
    for (const m of ['fxOperation', 'fxQuote', 'fxAccount'] as const) {
      await (
        prisma[m] as unknown as {
          deleteMany: (a: object) => Promise<unknown>;
        }
      ).deleteMany({ where: { wawuUserId: USER } });
    }
    await prisma.nuvionEntity.deleteMany({ where: { wawuUserId: USER } });
    await prisma.fintavaWalletOpening.deleteMany({
      where: { wawuUserId: USER },
    });
  }

  async function provId(accountId: string): Promise<string> {
    return (
      await prisma.fxAccount.findUniqueOrThrow({ where: { id: accountId } })
    ).providerAccountId!;
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start(8591);
    fx.install();
    area = new NuvionFxArea(
      new NuvionClient(
        standin.settings(),
        'nv_test_sk_WORLDfxKEY0000000000000',
      ),
    );
    await clean();
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: USER,
        state: 'open',
        bvnHash: `hash-${USER}`,
        bvnVerifiedAt: new Date(),
        phone: '+14165550777',
        provider: 'nuvion',
        worldCountry: 'CA',
        worldFirstCurrency: 'USD',
        worldAccountOpenedAt: new Date(),
      },
    });
    await prisma.nuvionEntity.create({
      data: { wawuUserId: USER, entityId: FX_ENTITY, status: 'approved' },
    });
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => {
    ledgerRows.length = 0;
    fx.detailsMode = 'active';
    fx.refuseSends = true;
    fx.transferStatus = 'successful';
    build();
  });

  it('every foreign-account route takes a world wallet', () => {
    const proto = FxController.prototype as unknown as Record<string, unknown>;
    const routes = [
      'currencies',
      'list',
      'open',
      'account',
      'transactions',
      'quote',
      'swap',
      'swapById',
      'sendQuote',
      'send',
      'sendById',
    ];
    for (const name of routes) {
      expect([
        name,
        Reflect.getMetadata(WORLD_WALLET_OK, proto[name] as object),
      ]).toEqual([name, true]);
    }
  });

  it('the PIN, the phone approval and the PIN reset take a world wallet too: a swap and a send need a PIN', () => {
    for (const c of [
      MoneyPinController,
      MoneyDeviceController,
      MoneyPinResetController,
    ]) {
      expect([c.name, Reflect.getMetadata(WORLD_WALLET_OK, c)]).toEqual([
        c.name,
        true,
      ]);
    }
  });

  it('is found from the opening and the entity, and only while it is open', async () => {
    expect(await worldWalletOf(prisma, USER)).toEqual(WALLET);
    expect(await worldWalletOf(prisma, 'someone-else')).toBeNull();
  });

  it('swaps between two foreign accounts at a held quote, with no naira anywhere', async () => {
    const usd = await accounts.open(WALLET, { currency: 'USD' });
    const eur = await accounts.open(WALLET, { currency: 'EUR' });
    const usdProv = await provId(usd.id);
    fx.fund(usdProv, 20_000);
    const q = await ops.quote(WALLET, {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAccountId: usd.id,
      toAccountId: eur.id,
      amountFromMinor: 5_000,
    });
    expect(q).toMatchObject({
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      amountFromMinor: 5_000,
    });
    const s = await ops.swap(WALLET, scope('POST money/fx/swaps'), {
      quoteId: q.id,
    });
    expect(s).toMatchObject({
      status: 'completed',
      fromCurrency: 'USD',
      toCurrency: 'EUR',
    });
    expect(fx.balanceOf(usdProv)).toBe(15_000);
    expect(
      (await accounts.get(WALLET, eur.id)).balance?.availableMinor,
    ).toBeGreaterThan(0);
    // The naira ledger is for naira swaps only.
    expect(ledgerRows).toHaveLength(0);
    expect(await ops.readSwap(WALLET, s.id)).toMatchObject({
      id: s.id,
      status: 'completed',
    });
  });

  it('refuses the naira side plainly: there is no naira account to swap from or into', async () => {
    const usd = (await accounts.list(WALLET)).accounts.find(
      (a) => a.currency === 'USD',
    )!;
    expect(
      await code(
        ops.quote(WALLET, {
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          toAccountId: usd.id,
          amountFromMinor: 100_000,
        }),
      ),
    ).toBe('fx_account_not_open');
    expect(
      await code(
        ops.quote(WALLET, {
          fromCurrency: 'USD',
          toCurrency: 'NGN',
          fromAccountId: usd.id,
          amountFromMinor: 1_000,
        }),
      ),
    ).toBe('fx_account_not_open');
  });

  it('sends a stablecoin out with no naira wallet, and the figures are the account’s own', async () => {
    fx.refuseSends = false;
    const usdc = await accounts.open(WALLET, {
      currency: 'USDC',
      chain: 'matic',
    });
    const prov = await provId(usdc.id);
    fx.fund(prov, 5_000);
    const s = await ops.send(WALLET, scope('POST money/fx/sends'), {
      currency: 'USDC',
      accountId: usdc.id,
      chain: 'matic',
      address: `0x${'12'.repeat(20)}`,
      amountMinor: 1_200,
    });
    expect(s).toMatchObject({
      status: 'completed',
      currency: 'USDC',
      amountMinor: 1_200,
    });
    expect(fx.balanceOf(prov)).toBe(3_800);
    expect(ledgerRows).toHaveLength(0);
  });

  it('an account an admin froze pays nothing out, as for anyone', async () => {
    const usd = (await accounts.list(WALLET)).accounts.find(
      (a) => a.currency === 'USD',
    )!;
    const eur = (await accounts.list(WALLET)).accounts.find(
      (a) => a.currency === 'EUR',
    )!;
    await prisma.fxAccount.update({
      where: { id: usd.id },
      data: { status: 'frozen', frozenAt: new Date(), frozenReason: 'test' },
    });
    expect(
      await code(
        ops.quote(WALLET, {
          fromCurrency: 'USD',
          toCurrency: 'EUR',
          fromAccountId: usd.id,
          toAccountId: eur.id,
          amountFromMinor: 100,
        }),
      ),
    ).toBe('account_frozen');
    await prisma.fxAccount.update({
      where: { id: usd.id },
      data: { status: 'open', frozenAt: null, frozenReason: null },
    });
  });

  it('leaves a swap the provider has not finished pending, and the sweep settles it on the world wallet', async () => {
    const usd = (await accounts.list(WALLET)).accounts.find(
      (a) => a.currency === 'USD',
    )!;
    const eur = (await accounts.list(WALLET)).accounts.find(
      (a) => a.currency === 'EUR',
    )!;
    fx.fund(await provId(usd.id), 10_000);
    fx.transferStatus = 'pending';
    const q = await ops.quote(WALLET, {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAccountId: usd.id,
      toAccountId: eur.id,
      amountFromMinor: 1_000,
    });
    const s = await ops.swap(WALLET, scope('POST money/fx/swaps'), {
      quoteId: q.id,
    });
    expect(s.status).toBe('pending');
    fx.transfers[fx.transfers.length - 1].status = 'successful';
    expect(
      await ops.sweep(new Date(Date.now() + 60_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(await ops.readSwap(WALLET, s.id)).toMatchObject({
      status: 'completed',
    });
  });
});

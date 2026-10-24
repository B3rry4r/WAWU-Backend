import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  FX_ENTITY,
  FX_NGN_ACCOUNT,
  FxStandin,
} from '../../../../test/nuvion/fx-standin';
import { NuvionStandin } from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
import { NuvionFxArea } from '../../../nuvion/areas/fx';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import { NuvionFxHandler } from '../../../nuvion/handlers/fx.handler';
import { NuvionWalletProvider } from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import type { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import type { OpenWallet } from '../../gate/wallet-gate';
import type { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import type {
  IdempotencyScope,
  IdempotencyService,
} from '../../payments/idempotency';
import { FxAccountsService } from '../fx-accounts.service';
import { FxAdminService } from '../fx-admin.service';
import { FxOperationsService, lagosDay } from '../fx-operations.service';
import { FxPort } from '../fx-provider';
import { FxSettings } from '../fx-settings';

/**
 * WALLET-21: the foreign-account services over the real database and the
 * Nuvion stand-in (dev-shaped answers, test/nuvion/fx-standin.ts). The
 * provider's balance is read from the stand-in's account, never from a row.
 */

const USER = 'b18fx-user-1';
const WALLET: OpenWallet = {
  wawuUserId: USER,
  customerId: FX_ENTITY,
  walletId: `${FX_ENTITY}:${FX_NGN_ACCOUNT}`,
  accountNumber: '0123456789',
};
const ADMIN = { id: 'adm-1', email: 'fin@wawu.test', role: 'finance' } as never;

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => (e instanceof MoneyError ? e.code : String(e)),
  );

describe('foreign accounts, swaps and sends (WALLET-21)', () => {
  const standin = new NuvionStandin();
  const fx = new FxStandin(standin);
  const prisma = new PrismaService();
  let guard: OutboundGuard;
  let area: NuvionFxArea;
  let accounts: FxAccountsService;
  let ops: FxOperationsService;
  let admin: FxAdminService;
  let settings: FxSettings;
  const env: Record<string, string> = {};
  const off = new Set<string>();
  const ledgerRows: Array<Record<string, unknown>> = [];
  const keys = { calls: [] as string[] };
  let n = 0;

  const scope = (): IdempotencyScope => {
    n += 1;
    return {
      wawuUserId: USER,
      method: 'POST',
      route: 'POST money/fx/swaps',
      key: `k-${n}`,
      fingerprint: `f-${n}`,
    };
  };

  function build() {
    const plan = {
      number: (k: string) => (off.has(k) ? 0 : 1),
    } as unknown as PlanSettingsService;
    settings = new FxSettings(
      { get: (k: string) => env[k] } as unknown as ConfigService,
      plan,
    );
    const provider = {
      name: 'nuvion',
      label: 'Nuvion',
      configured: true,
      fx: area,
      getBalance: ({ walletId }: { walletId: string }) =>
        Promise.resolve({
          availableKobo: BigInt(fx.balanceOf(walletId.split(':')[1])),
          bookedKobo: BigInt(fx.balanceOf(walletId.split(':')[1])),
        }),
    } as unknown as WalletProvider;
    const port = new FxPort(provider);
    accounts = new FxAccountsService(port, prisma, settings);
    const idem = {
      attach: () => Promise.resolve(),
      finish: (s: IdempotencyScope) => {
        keys.calls.push(`finish ${s.key}`);
        return Promise.resolve();
      },
      release: (s: IdempotencyScope) => {
        keys.calls.push(`release ${s.key}`);
        return Promise.resolve();
      },
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
    admin = new FxAdminService(prisma, port, settings);
  }

  async function clean() {
    await prisma.fxAdminAudit.deleteMany({
      where: { subjectWawuId: { startsWith: 'b18fx-' } },
    });
    await prisma.fxOperation.deleteMany({
      where: { wawuUserId: { startsWith: 'b18fx-' } },
    });
    await prisma.fxQuote.deleteMany({
      where: { wawuUserId: { startsWith: 'b18fx-' } },
    });
    await prisma.fxAccount.deleteMany({
      where: { wawuUserId: { startsWith: 'b18fx-' } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { startsWith: 'b18fx-' } },
    });
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start(8311);
    fx.install();
    area = new NuvionFxArea(
      new NuvionClient(
        standin.settings(),
        'nv_test_sk_WALLET21serviceKEY000000000',
      ),
    );
    await clean();
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
    await standin.stop();
    guard.restore();
    expect(guard.violations).toEqual([]);
  });
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    off.clear();
    ledgerRows.length = 0;
    keys.calls.length = 0;
    fx.detailsMode = 'active';
    fx.refuseSends = true;
    fx.transferStatus = 'successful';
    fx.accounts.get(FX_NGN_ACCOUNT)!.balance = {
      available: 790_921,
      current: 790_921,
      overdraft_used: 0,
    };
    build();
  });

  /** The provider's id for one of our account rows. */
  async function provId(accountId: string): Promise<string> {
    const row = await prisma.fxAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    return row.providerAccountId!;
  }

  async function openUsd() {
    return accounts.open(WALLET, { currency: 'USD' });
  }

  it('opens an account once: asking again returns it and asks the provider nothing more', async () => {
    await clean();
    const a = await openUsd();
    const before = standin.seen.filter(
      (r) => r.path === '/accounts' && r.method === 'POST',
    ).length;
    const b = await openUsd();
    expect(b.id).toBe(a.id);
    expect(
      standin.seen.filter((r) => r.path === '/accounts' && r.method === 'POST')
        .length,
    ).toBe(before);
    expect(a).toMatchObject({
      currency: 'USD',
      kind: 'fiat',
      chain: null,
      status: 'open',
      decimals: 2,
    });
    expect(a.details).toMatchObject({
      status: 'active',
      routingNumber: '101019644',
      swiftCode: 'NOWHUS33',
    });
    expect(await prisma.fxAccount.count({ where: { wawuUserId: USER } })).toBe(
      1,
    );
  });

  it('makes a stablecoin account per chain, and refuses a chain a coin is not held on', async () => {
    const eth = await accounts.open(WALLET, { currency: 'USDT', chain: 'eth' });
    const base = await accounts.open(WALLET, {
      currency: 'USDT',
      chain: 'base',
    });
    expect(eth.id).not.toBe(base.id);
    expect(eth).toMatchObject({ kind: 'stablecoin', chain: 'eth' });
    expect(base.details?.chain).toBe('base');
    expect(await code(accounts.open(WALLET, { currency: 'USDT' }))).toBe(
      'chain_mismatch',
    );
    expect(
      await code(accounts.open(WALLET, { currency: 'RLUSD', chain: 'sol' })),
    ).toBe('chain_mismatch');
    expect(
      await code(accounts.open(WALLET, { currency: 'USD', chain: 'eth' })),
    ).toBe('chain_mismatch');
    const rl = await accounts.open(WALLET, { currency: 'RLUSD', chain: 'eth' });
    expect(rl.currency).toBe('RLUSD');
  });

  it("shows the provider's balance, not a sum of rows", async () => {
    const usd = await openUsd();
    const prov = [...fx.accounts.values()].find(
      (x) => x.id !== FX_NGN_ACCOUNT && x.currency === 'USD',
    )!;
    fx.fund(prov.id, 4_321);
    const list = await accounts.list(WALLET);
    const row = list.accounts.find((x) => x.id === usd.id)!;
    expect(row.balance).toEqual({
      currency: 'USD',
      availableMinor: 4_321,
      bookedMinor: 4_321,
    });
  });

  it('refuses to open when an admin switched the currency or the product off', async () => {
    off.add('fx.currency.EUR.on');
    expect(await code(accounts.open(WALLET, { currency: 'EUR' }))).toBe(
      'fx_switched_off',
    );
    off.clear();
    off.add('fx.product.open_account.on');
    expect(await code(accounts.open(WALLET, { currency: 'EUR' }))).toBe(
      'fx_switched_off',
    );
    expect(accounts.currencies().products).toEqual({
      openAccount: false,
      swap: true,
      cryptoSend: true,
    });
    off.clear();
    off.add('fx.currency.GBP.on');
    expect(
      accounts.currencies().currencies.find((c) => c.code === 'GBP')?.enabled,
    ).toBe(false);
  });

  it('answers currency_not_supported on a provider without foreign accounts (Fintava)', async () => {
    const bare = new FxPort({
      name: 'fintava',
      label: 'Fintava',
      configured: true,
    } as unknown as WalletProvider);
    const svc = new FxAccountsService(bare, prisma, settings);
    expect(await code(svc.list(WALLET))).toBe('currency_not_supported');
    expect(() => svc.currencies()).toThrow(MoneyError);
  });

  it('swaps naira to dollars at the held quote: the naira side is written to the ledger, the quote is spent', async () => {
    const usd = await openUsd();
    const had = (await accounts.get(WALLET, usd.id)).balance!.availableMinor;
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    expect(q).toMatchObject({
      amountFromMinor: 100_000,
      amountToMinor: 74,
      wawuFeeMinor: 0,
      totalFromMinor: 100_000,
      providerFeeMinor: null,
      fromDecimals: 2,
      toDecimals: 2,
    });
    expect(q.validForSeconds).toBeGreaterThan(170);
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    expect(s).toMatchObject({
      status: 'completed',
      amountFromMinor: 100_000,
      amountToMinor: 74,
      fromCurrency: 'NGN',
      toCurrency: 'USD',
    });
    const after = await accounts.get(WALLET, usd.id);
    expect(after.balance?.availableMinor).toBe(had + 74);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      direction: 'out',
      status: 'completed',
      amountKobo: 100_000,
      wallet: { kind: 'user', wawuUserId: USER, accountNumber: '0123456789' },
    });
    expect(await code(ops.swap(WALLET, scope(), { quoteId: q.id }))).toBe(
      'quote_expired',
    );
    expect(await ops.readSwap(WALLET, s.id)).toMatchObject({
      id: s.id,
      status: 'completed',
    });
    expect(keys.calls.some((c) => c.startsWith('finish'))).toBe(true);
  });

  it('swaps dollars back to naira and writes the naira credit', async () => {
    const usd = await openUsd();
    const prov = [...fx.accounts.values()]
      .filter((x) => x.currency === 'USD')
      .pop()!;
    fx.fund(prov.id, 1_000);
    const q = await ops.quote(WALLET, {
      fromCurrency: 'USD',
      toCurrency: 'NGN',
      fromAccountId: usd.id,
      amountFromMinor: 100,
    });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    expect(s.status).toBe('completed');
    expect(ledgerRows[0]).toMatchObject({
      direction: 'in',
      amountKobo: 131_544,
    });
  });

  it('refuses a quote whose real expiry has passed, before anything is sent', async () => {
    const usd = await openUsd();
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    await prisma.fxQuote.update({
      where: { id: q.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const sent = standin.seen.filter(
      (r) => r.path === '/transfers' && r.method === 'POST',
    ).length;
    expect(await code(ops.swap(WALLET, scope(), { quoteId: q.id }))).toBe(
      'quote_expired',
    );
    expect(
      standin.seen.filter((r) => r.path === '/transfers' && r.method === 'POST')
        .length,
    ).toBe(sent);
  });

  it("refuses a swap the provider's balance cannot cover, with the figures, and does not spend the quote", async () => {
    const usd = await openUsd();
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 900_000,
    });
    const err = await ops
      .swap(WALLET, scope(), { quoteId: q.id })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).getResponse()).toMatchObject({
      reason: {
        code: 'insufficient_funds',
        currency: 'NGN',
        balanceMinor: 790_921,
        totalMinor: 900_000,
        shortfallMinor: 109_079,
      },
    });
    expect(
      (await prisma.fxQuote.findUnique({ where: { id: q.id } }))?.usedAt,
    ).toBeNull();
  });

  it('holds a per-currency daily limit over the Lagos day, swaps and sends together', async () => {
    await clean();
    env.FX_DAILY_LIMIT_NGN_MINOR = '150000';
    build();
    const usd = await openUsd();
    const mk = () =>
      ops.quote(WALLET, {
        fromCurrency: 'NGN',
        toCurrency: 'USD',
        toAccountId: usd.id,
        amountFromMinor: 100_000,
      });
    const first = await mk();
    await ops.swap(WALLET, scope(), { quoteId: first.id });
    const second = await mk();
    const err = await ops
      .swap(WALLET, scope(), { quoteId: second.id })
      .catch((e: unknown) => e);
    expect((err as MoneyError).getResponse()).toMatchObject({
      reason: {
        code: 'daily_limit_exceeded',
        currency: 'NGN',
        limitMinor: 150_000,
        remainingTodayMinor: 50_000,
      },
    });
    expect(lagosDay(new Date('2026-10-24T23:30:00Z'))).toBe('2026-10-25');
  });

  it("moves WAWU's fee from config as a second transfer to the collector, and refuses a fee with nowhere to pay it", async () => {
    expect(
      () =>
        new FxSettings(
          {
            get: (k: string) => ({ FX_SWAP_FEE_NGN_MINOR: '500' })[k],
          } as unknown as ConfigService,
          { number: () => 1 } as unknown as PlanSettingsService,
        ),
    ).toThrow(/FX_FEE_COLLECTOR_NGN_BAN/);
    env.FX_SWAP_FEE_NGN_MINOR = '500';
    env.FX_FEE_COLLECTOR_NGN_BAN = '0099990001';
    build();
    const usd = await openUsd();
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    expect(q).toMatchObject({ wawuFeeMinor: 500, totalFromMinor: 100_500 });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    const fee = fx.transfers
      .filter((t) => String(t.unique_reference).endsWith('-fee'))
      .pop();
    expect(fee).toMatchObject({
      amount: 500,
      narration: 'WAWU fee',
      currency: 'NGN',
    });
    expect(
      (await prisma.fxOperation.findUnique({ where: { id: s.id } }))?.feeLeg,
    ).toBe('done');
  });

  it('refuses a swap while an admin has the account frozen, and a freeze leaves one audit row', async () => {
    const usd = await openUsd();
    const froze = await admin.setFrozen(
      ADMIN,
      usd.id,
      'freeze',
      'under review',
    );
    expect(froze).toMatchObject({
      status: 'frozen',
      frozenReason: 'under review',
    });
    await admin.setFrozen(ADMIN, usd.id, 'freeze', 'again');
    expect(
      await prisma.fxAdminAudit.count({ where: { fxAccountId: usd.id } }),
    ).toBe(1);
    expect(
      await code(
        ops.quote(WALLET, {
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          toAccountId: usd.id,
          amountFromMinor: 100_000,
        }),
      ),
    ).toBe('account_frozen');
    expect((await accounts.get(WALLET, usd.id)).status).toBe('frozen');
    await admin.setFrozen(ADMIN, usd.id, 'unfreeze', 'cleared');
    expect(
      await prisma.fxAdminAudit.findMany({
        where: { fxAccountId: usd.id },
        orderBy: { actedAt: 'asc' },
      }),
    ).toMatchObject([
      {
        action: 'freeze',
        actedByAdminEmail: 'fin@wawu.test',
        actedByAdminRole: 'finance',
      },
      { action: 'unfreeze' },
    ]);
    expect(
      await code(
        ops.quote(WALLET, {
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          toAccountId: usd.id,
          amountFromMinor: 100_000,
        }),
      ),
    ).toBe('no error');
  });

  it("answers dev's refusal of a stablecoin send plainly, moves nothing and gives the key back; a wrong chain or address is refused first", async () => {
    const usdt = await accounts.open(WALLET, {
      currency: 'USDT',
      chain: 'eth',
    });
    const prov = [...fx.accounts.values()]
      .filter((x) => x.currency === 'UST')
      .pop()!;
    fx.fund(prov.id, 5_000);
    const good = `0x${'cd'.repeat(20)}`;
    expect(
      await code(
        ops.send(WALLET, scope(), {
          currency: 'USDT',
          accountId: usdt.id,
          chain: 'base',
          address: good,
          amountMinor: 100,
        }),
      ),
    ).toBe('chain_mismatch');
    expect(
      await code(
        ops.send(WALLET, scope(), {
          currency: 'USDT',
          accountId: usdt.id,
          chain: 'eth',
          address: 'not-an-address-at-all-1',
          amountMinor: 100,
        }),
      ),
    ).toBe('address_invalid');
    const s = scope();
    const err = await ops
      .send(WALLET, s, {
        currency: 'USDT',
        accountId: usdt.id,
        chain: 'eth',
        address: good,
        amountMinor: 100,
      })
      .catch((e: unknown) => e);
    expect((err as MoneyError).getResponse()).toMatchObject({
      reason: { code: 'provider_declined' },
    });
    expect(JSON.stringify((err as MoneyError).getResponse())).not.toMatch(
      /[–—]/,
    );
    expect(keys.calls).toContain(`release ${s.key}`);
    expect(fx.balanceOf(prov.id)).toBe(5_000 + 0);
    const row = await prisma.fxOperation.findFirst({
      where: { wawuUserId: USER, kind: 'send' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).toMatchObject({ status: 'failed' });
    const quote = await ops.sendQuote(WALLET, {
      currency: 'USDT',
      accountId: usdt.id,
      chain: 'eth',
      amountMinor: 100,
    });
    expect(quote).toMatchObject({
      providerFeeMinor: null,
      wawuFeeMinor: 0,
      availableMinor: 5_000,
      currency: 'USDT',
    });
  });

  it('sends a stablecoin once the provider takes it', async () => {
    fx.refuseSends = false;
    const usdc = await accounts.open(WALLET, {
      currency: 'USDC',
      chain: 'matic',
    });
    const prov = { id: await provId(usdc.id) };
    const had = fx.balanceOf(prov.id);
    fx.fund(prov.id, 5_000);
    const s = await ops.send(WALLET, scope(), {
      currency: 'USDC',
      accountId: usdc.id,
      chain: 'matic',
      address: `0x${'12'.repeat(20)}`,
      amountMinor: 1_200,
    });
    expect(s).toMatchObject({
      status: 'completed',
      currency: 'USDC',
      chain: 'matic',
      amountMinor: 1_200,
    });
    expect(fx.balanceOf(prov.id)).toBe(had + 3_800);
    expect(await ops.readSend(WALLET, s.id)).toMatchObject({ id: s.id });
    expect(await code(ops.readSwap(WALLET, s.id))).toBe('not_found');
    off.add('fx.product.crypto_send.on');
    expect(
      await code(
        ops.sendQuote(WALLET, {
          currency: 'USDC',
          accountId: usdc.id,
          chain: 'matic',
          amountMinor: 100,
        }),
      ),
    ).toBe('fx_switched_off');
  });

  it("leaves a swap the provider has not finished pending, and the sweep settles it from the provider's own record", async () => {
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: USER,
        customerId: FX_ENTITY,
        walletId: WALLET.walletId,
        accountNumber: WALLET.accountNumber,
        provider: 'nuvion',
      },
    });
    const usd = await openUsd();
    fx.transferStatus = 'pending';
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    expect(s.status).toBe('pending');
    expect(ledgerRows).toHaveLength(0);
    fx.transfers[fx.transfers.length - 1].status = 'successful';
    expect(
      await ops.sweep(new Date(Date.now() + 60_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(await ops.readSwap(WALLET, s.id)).toMatchObject({
      status: 'completed',
    });
    expect(ledgerRows).toHaveLength(1);
    expect(await ops.sweep(new Date(Date.now() + 120_000))).toBe(0);
    expect(ledgerRows).toHaveLength(1);
  });

  it("records a delivery about a foreign account in the ledger of these accounts once, and settles our swap from the provider's record", async () => {
    await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: USER } });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: USER,
        customerId: FX_ENTITY,
        walletId: WALLET.walletId,
        accountNumber: WALLET.accountNumber,
        provider: 'nuvion',
      },
    });
    const usd = await openUsd();
    fx.transferStatus = 'pending';
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    expect(s.status).toBe('pending');
    const transfer = fx.transfers[fx.transfers.length - 1];
    transfer.status = 'successful';
    transfer.account_id = await provId(usd.id);
    const provider = new NuvionWalletProvider(
      new NuvionClient(
        standin.settings(),
        'nv_test_sk_WALLET21handlerKEY00000000',
      ),
    );
    const moduleRef = {
      get: (token: unknown) => {
        if (token === WALLET_PROVIDER) return provider;
        if (token === FxOperationsService) return ops;
        throw new Error('not here');
      },
    };
    const handler = new NuvionFxHandler(prisma, moduleRef as never);
    const delivery = {
      id: 'd1',
      eventId: 'ev-1',
      event: 'outflows.completed',
      resourceId: String(transfer.id),
      entityId: FX_ENTITY,
      data: transfer,
      receivedAt: new Date(),
      attempts: 1,
    };
    expect((await handler.handle(delivery)).outcome).toBe('done');
    expect(
      (await handler.handle({ ...delivery, eventId: 'ev-1-again' })).outcome,
    ).toBe('done');
    const rows = await prisma.fxMovement.findMany({
      where: { wawuUserId: USER, providerTransferId: String(transfer.id) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'completed',
      currency: 'USD',
      amountMinor: 100_000n,
    });
    expect(await ops.readSwap(WALLET, s.id)).toMatchObject({
      status: 'completed',
    });
    expect(ledgerRows).toHaveLength(1);
    const other = await handler.handle({
      ...delivery,
      eventId: 'ev-2',
      data: { ...transfer, account_id: FX_NGN_ACCOUNT },
    });
    expect(other.outcome).toBe('done');
    expect(other.note).toMatch(/not a foreign account of ours/);
    await prisma.fxMovement.deleteMany({ where: { wawuUserId: USER } });
  });

  it('lists swaps and sends for the admin, newest first, in pages, and refuses one that is not there', async () => {
    const page = await admin.operations({ wawuUserId: USER, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const next = await admin.operations({
      wawuUserId: USER,
      limit: 2,
      cursor: page.nextCursor!,
    });
    expect(next.items[0].createdAt <= page.items[1].createdAt).toBe(true);
    const only = await admin.operations({
      wawuUserId: USER,
      kind: 'send',
      status: 'failed',
    });
    expect(
      only.items.every((o) => o.kind === 'send' && o.status === 'failed'),
    ).toBe(true);
    const mine = await admin.personAccounts(USER);
    expect(mine.accounts.length).toBeGreaterThan(0);
    expect(
      await code(admin.operation('00000000-0000-4000-8000-000000000000')),
    ).toBe('not_found');
  });
});

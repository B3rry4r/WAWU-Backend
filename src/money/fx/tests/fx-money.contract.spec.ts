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
import { NuvionReconcileHandler } from '../../../nuvion/handlers/reconcile.handler';
import { NuvionWalletProvider } from '../../../nuvion/nuvion-wallet-provider';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
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
import type { FxAccount } from '../../../../generated/prisma/client';
import { NotificationService } from '../../../notification/notification.service';
import { FxAccountsService } from '../fx-accounts.service';
import { FxAdminService } from '../fx-admin.service';
import { FxOperationsService, lagosDay } from '../fx-operations.service';
import { FxPort } from '../fx-provider';
import { FxSettings } from '../fx-settings';
import { accountView } from '../fx-views';
import { creditSourceOf } from '../../money-in-notice/money-in-sources';

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
/** WAWU's own (operational) account number, as the provider says it. */
const PLATFORM = '0099990001';
const ADMIN = { id: 'adm-1', email: 'fin@wawu.test', role: 'finance' } as never;

/** WALK4-FIX M-2: every "ready" notice written by the services in this file (the webhook handler, the person's read, the sweep). */
const told: Array<{ kind: string; userWawuId: string; currency?: string }> = [];
const notifier = {
  emitOrThrow: (event: {
    kind: string;
    userWawuId: string;
    currency?: string;
  }) => {
    told.push(event);
    return Promise.resolve({});
  },
};

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
  const nairaLegs: Array<Record<string, unknown>> = [];
  let nairaMode: 'ok' | 'pending' | 'refused' | 'unknown' = 'ok';

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
      getPlatformAccount: () =>
        Promise.resolve({
          accountNumber: PLATFORM,
          accountName: 'WAWU',
          availableKobo: 0n,
          bookedKobo: 0n,
        }),
      // The naira send's own path for WAWU's fee (WALLET-07): a book
      // transfer from the payer's wallet to WAWU's account, by reference.
      walletToWallet: (input: Record<string, unknown>) => {
        nairaLegs.push(input);
        if (nairaMode === 'refused') {
          return Promise.reject(
            new WalletProviderError({
              kind: 'insufficient_funds',
              provider: 'nuvion',
              operation: 'wallet to wallet',
              messages: ['not enough'],
            }),
          );
        }
        if (nairaMode === 'unknown') {
          return Promise.reject(
            new WalletProviderError({
              kind: 'outcome_unknown',
              provider: 'nuvion',
              operation: 'wallet to wallet',
            }),
          );
        }
        return Promise.resolve({
          ourReference: String(input.reference),
          providerReference: null,
          secondaryReference: null,
          transactionId: 'T1',
          amountKobo: input.amountKobo,
          totalKobo: input.amountKobo,
          feeKobo: 0n,
          sourceAvailableKobo: null,
          pending: nairaMode === 'pending',
        });
      },
      getBalance: ({ walletId }: { walletId: string }) =>
        Promise.resolve({
          availableKobo: BigInt(fx.balanceOf(walletId.split(':')[1])),
          bookedKobo: BigInt(fx.balanceOf(walletId.split(':')[1])),
        }),
    } as unknown as WalletProvider;
    const port = new FxPort(provider);
    accounts = new FxAccountsService(
      port,
      prisma,
      settings,
      notifier as unknown as NotificationService,
    );
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

  /**
   * `ops.sweep()` takes every pending operation and every owed fee of the provider in the database, whoever's they are: a row left
   * by another suite (or an earlier test of this one) would be settled inside this suite's sweeps and move its counts (WALLET-21 L3).
   */
  async function removeStraySweepRows() {
    await prisma.fxOperation.deleteMany({
      where: {
        provider: 'nuvion',
        OR: [
          { status: 'pending' },
          { status: 'completed', feeLeg: 'owed' },
          { status: 'completed', feeLeg: { startsWith: 'owed:' } },
        ],
      },
    });
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    guard = guardOutbound();
    await standin.start();
    fx.install();
    area = new NuvionFxArea(
      new NuvionClient(
        standin.settings(),
        'nv_test_sk_WALLET21serviceKEY000000000',
      ),
    );
    await clean();
    await removeStraySweepRows();
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
    told.length = 0;
    nairaLegs.length = 0;
    nairaMode = 'ok';
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

  it("says why an account has no details, in the provider's words, and asks again once 5 minutes have passed (verifier M2: CAD and AED answered 503 on dev)", async () => {
    fx.detailsMode = 'unavailable';
    const cad = await accounts.open(WALLET, { currency: 'CAD' });
    expect(cad.details).toBeNull();
    expect(cad.detailsStatus).toBe('unavailable');
    expect(cad.detailsNote).toMatch(
      /partner services is temporarily unavailable/,
    );
    const listed = (await accounts.list(WALLET)).accounts.find(
      (a) => a.id === cad.id,
    )!;
    expect(listed).toMatchObject({ detailsStatus: 'unavailable' });
    expect(listed.detailsNote).toMatch(/temporarily unavailable/);
    expect(JSON.stringify(listed)).not.toMatch(/on their way|[\u2013\u2014]/);
    // NUVION-FIX 9.5: the details are asked for at most every 5 minutes, so the next ask is 5 minutes on.
    await prisma.fxAccount.update({
      where: { id: cad.id },
      data: { detailsAskedAt: new Date(Date.now() - 6 * 60_000) },
    });
    fx.detailsMode = 'pending';
    const pending = await accounts.get(WALLET, cad.id);
    expect(pending).toMatchObject({
      detailsStatus: 'pending',
      detailsNote: null,
    });
    fx.details.get(
      (await prisma.fxAccount.findUniqueOrThrow({ where: { id: cad.id } }))
        .providerAccountId!,
    )!.status = 'active';
    expect(await accounts.get(WALLET, cad.id)).toMatchObject({
      detailsStatus: 'ready',
      detailsNote: null,
    });
    const usd = await openUsd();
    expect(usd).toMatchObject({ detailsStatus: 'ready', detailsNote: null });
  });

  // -------------------------------------------------------------------------
  // NUVION-FIX (Nuvion's answers, 27 Oct 2026): account details come later (5 to 30 minutes)
  // -------------------------------------------------------------------------

  const detailPosts = () =>
    standin.seen.filter(
      (r) => r.method === 'POST' && r.path === '/account-details',
    ).length;
  const SECOND: OpenWallet = { ...WALLET, wawuUserId: 'b18fx-user-95' };

  it('9.4: an account with no details record and no refusal is pending, not unavailable; a refusal keeps its words', () => {
    const row = {
      id: 'r1',
      wawuUserId: USER,
      provider: 'nuvion',
      currency: 'USD',
      chain: '',
      providerCustomerId: FX_ENTITY,
      providerAccountId: 'acc-1',
      ban: null,
      detailsId: null,
      status: 'open',
      frozenAt: null,
      frozenReason: null,
      detailsAskedAt: null,
      detailsReadyAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as FxAccount;
    expect(accountView(row, settings, null, null, null)).toMatchObject({
      detailsStatus: 'pending',
      detailsNote: null,
    });
    expect(accountView(row, settings, null, null)).toMatchObject({
      detailsStatus: 'pending',
    });
    expect(
      accountView(row, settings, null, null, 'The provider said no.'),
    ).toMatchObject({
      detailsStatus: 'unavailable',
      detailsNote: 'The provider said no.',
    });
  });

  it('9.5: the details are asked for at most every 5 minutes, however often the wallet is read', async () => {
    fx.detailsMode = 'unavailable';
    const before = detailPosts();
    const cad = await accounts.open(SECOND, { currency: 'CAD' });
    expect(detailPosts()).toBe(before + 1);
    await accounts.list(SECOND);
    await accounts.get(SECOND, cad.id);
    await accounts.list(SECOND);
    expect(detailPosts()).toBe(before + 1);
    // The refusal is still told while the ask is waited out.
    expect(
      (await accounts.list(SECOND)).accounts.find((a) => a.id === cad.id),
    ).toMatchObject({ detailsStatus: 'unavailable' });
    await prisma.fxAccount.update({
      where: { id: cad.id },
      data: { detailsAskedAt: new Date(Date.now() - 6 * 60_000) },
    });
    await accounts.list(SECOND);
    expect(detailPosts()).toBe(before + 2);
    await accounts.get(SECOND, cad.id);
    expect(detailPosts()).toBe(before + 2);
  });

  describe("9.6: the person is told when a foreign account's details are ready", () => {
    function providerOf() {
      return new NuvionWalletProvider(
        new NuvionClient(
          standin.settings(),
          'nv_test_sk_NVFIX96handlerKEY0000000000',
        ),
      );
    }
    function moduleRefOf(provider = providerOf()) {
      return {
        get: (token: unknown) => {
          if (token === WALLET_PROVIDER) return provider;
          if (token === NotificationService) return notifier;
          if (token === FxOperationsService) return ops;
          throw new Error('not here');
        },
      };
    }
    function handlerOf(): NuvionFxHandler {
      return new NuvionFxHandler(prisma, moduleRefOf() as never);
    }
    /** The 15 minute sweep (NuvionReconcileHandler), over the same stand-in. */
    function sweeperOf(): NuvionReconcileHandler {
      return new NuvionReconcileHandler(prisma, moduleRefOf() as never);
    }
    /** Makes an account look as if it were opened this many minutes ago (the sweep leaves a young one alone). */
    const opened = (accountId: string, minutes: number) =>
      prisma.fxAccount.update({
        where: { id: accountId },
        data: { createdAt: new Date(Date.now() - minutes * 60_000) },
      });
    const toldTo = (user: string) => told.filter((e) => e.userWawuId === user);
    const delivery = (providerAccountId: string, detailsId: string) => ({
      id: 'd96',
      eventId: `ev-96-${detailsId}-${told.length}-${Math.random()}`,
      event: 'account_details.updated',
      resourceId: detailsId,
      entityId: FX_ENTITY,
      data: {
        id: detailsId,
        entity_id: FX_ENTITY,
        account_id: providerAccountId,
        status: 'active',
      },
      receivedAt: new Date(),
      attempts: 1,
    });
    const detailsOf = async (accountId: string) => {
      const id = await provId(accountId);
      return { id, record: fx.details.get(id)! };
    };

    it('says nothing while the record still reads pending, then tells the person once when it is active, with the currency in the words', async () => {
      fx.detailsMode = 'pending';
      const usd = await accounts.open(SECOND, { currency: 'USD' });
      const { id, record } = await detailsOf(usd.id);
      const handler = handlerOf();
      // The delivery says active; the record, read back, says pending.
      const early = await handler.handle(delivery(id, String(record.id)));
      expect(early.outcome).toBe('done');
      expect(told).toEqual([]);
      record.status = 'active';
      const ready = await handler.handle(delivery(id, String(record.id)));
      expect(ready.outcome).toBe('done');
      // WALK4-FIX M-2: the notice names the currency; this assertion had no currency field.
      expect(told).toEqual([
        {
          kind: 'wallet_ready',
          userWawuId: SECOND.wawuUserId,
          currency: 'USD',
        },
      ]);
      await handler.handle(delivery(id, String(record.id)));
      expect(told).toHaveLength(1);
      const row = await prisma.fxAccount.findUniqueOrThrow({
        where: { id: usd.id },
      });
      expect(row.detailsReadyAt).not.toBeNull();
    });

    it('says nothing for details that were active in the response that opened the account: the person is looking at them', async () => {
      fx.detailsMode = 'active';
      const gbp = await accounts.open(SECOND, { currency: 'GBP' });
      const g = await detailsOf(gbp.id);
      await handlerOf().handle(delivery(g.id, String(g.record.id)));
      await accounts.get(SECOND, gbp.id);
      await sweeperOf().rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toEqual([]);
    });

    it('M-2: details the person finds active on their own read are told once (this used to be marked seen and never told)', async () => {
      fx.detailsMode = 'pending';
      const eur = await accounts.open(SECOND, { currency: 'EUR' });
      const e = await detailsOf(eur.id);
      await accounts.get(SECOND, eur.id);
      expect(told).toEqual([]);
      e.record.status = 'active';
      // The person's own read finds it ready first: they are told, once.
      expect(await accounts.get(SECOND, eur.id)).toMatchObject({
        detailsStatus: 'ready',
      });
      expect(told).toEqual([
        {
          kind: 'wallet_ready',
          userWawuId: SECOND.wawuUserId,
          currency: 'EUR',
        },
      ]);
      // Reading again, the list, a late delivery and a sweep write nothing more.
      await accounts.get(SECOND, eur.id);
      await accounts.list(SECOND);
      await handlerOf().handle(delivery(e.id, String(e.record.id)));
      await opened(eur.id, 10);
      await sweeperOf().rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toHaveLength(1);
    });

    it('M-2: the sweep finds details that turned active with the delivery lost and the owner away, and tells once', async () => {
      fx.detailsMode = 'pending';
      const aed = await accounts.open(SECOND, { currency: 'AED' });
      const a = await detailsOf(aed.id);
      const sweep = sweeperOf();
      // Young, and pending: left alone.
      await sweep.rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toEqual([]);
      a.record.status = 'active';
      // Active but young (under 5 minutes): not read yet.
      await sweep.rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toEqual([]);
      await opened(aed.id, 10);
      const first = await sweep.rereadForeignDetails(new Date());
      expect(first?.told).toBeGreaterThanOrEqual(1);
      expect(toldTo(SECOND.wawuUserId)).toEqual([
        {
          kind: 'wallet_ready',
          userWawuId: SECOND.wawuUserId,
          currency: 'AED',
        },
      ]);
      // Again, the whole sweep, a late delivery and the person's read: nothing more.
      await sweep.rereadForeignDetails(new Date());
      await sweep.sweep(new Date());
      await handlerOf().handle(delivery(a.id, String(a.record.id)));
      await accounts.get(SECOND, aed.id);
      expect(toldTo(SECOND.wawuUserId)).toHaveLength(1);
    });

    it("M-2 race: the delivery, the person's read and two sweeps at the same moment write one notice", async () => {
      fx.detailsMode = 'pending';
      const ghs = await accounts.open(SECOND, { currency: 'GHS' });
      const c = await detailsOf(ghs.id);
      c.record.status = 'active';
      await opened(ghs.id, 10);
      const sweepA = sweeperOf();
      const sweepB = sweeperOf();
      await Promise.all([
        handlerOf().handle(delivery(c.id, String(c.record.id))),
        accounts.get(SECOND, ghs.id),
        sweepA.rereadForeignDetails(new Date()),
        sweepB.rereadForeignDetails(new Date()),
        accounts.list(SECOND),
      ]);
      expect(toldTo(SECOND.wawuUserId)).toEqual([
        {
          kind: 'wallet_ready',
          userWawuId: SECOND.wawuUserId,
          currency: 'GHS',
        },
      ]);
      const row = await prisma.fxAccount.findUniqueOrThrow({
        where: { id: ghs.id },
      });
      expect(row.detailsReadyAt).not.toBeNull();
    });

    it('patch round 1: an account opened over 3 days ago and found active on its first read is marked seen, not told late', async () => {
      fx.detailsMode = 'pending';
      const eur = await accounts.open(SECOND, { currency: 'EUR' });
      const e = await detailsOf(eur.id);
      e.record.status = 'active';
      await opened(eur.id, 5 * 24 * 60);
      expect(await accounts.get(SECOND, eur.id)).toMatchObject({
        detailsStatus: 'ready',
      });
      expect(toldTo(SECOND.wawuUserId)).toEqual([]);
      expect(
        (await prisma.fxAccount.findUniqueOrThrow({ where: { id: eur.id } }))
          .detailsReadyAt,
      ).not.toBeNull();
      await accounts.list(SECOND);
      await sweeperOf().rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toEqual([]);
    });

    it('patch round 1: accounts whose details stay pending do not starve a newer account that is active: the sweep pages past them', async () => {
      await clean();
      fx.detailsMode = 'pending';
      const gbp = await accounts.open(SECOND, { currency: 'GBP' });
      const usd = await accounts.open(SECOND, { currency: 'USD' });
      const u = await detailsOf(usd.id);
      u.record.status = 'active';
      await opened(gbp.id, 40);
      await opened(usd.id, 10);
      const sweep = sweeperOf();
      sweep.detailsBatchSize = 1;
      await sweep.rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toEqual([
        {
          kind: 'wallet_ready',
          userWawuId: SECOND.wawuUserId,
          currency: 'USD',
        },
      ]);
    });

    it('M-2: a notice that cannot be written leaves the account unmarked, so the next path tells', async () => {
      fx.detailsMode = 'pending';
      const usdt = await accounts.open(SECOND, {
        currency: 'USDT',
        chain: 'eth',
      });
      const u = await detailsOf(usdt.id);
      u.record.status = 'active';
      await opened(usdt.id, 10);
      const emit = notifier.emitOrThrow;
      notifier.emitOrThrow = () => Promise.reject(new Error('down'));
      try {
        await accounts.get(SECOND, usdt.id);
        await sweeperOf().rereadForeignDetails(new Date());
      } finally {
        notifier.emitOrThrow = emit;
      }
      expect(told).toEqual([]);
      expect(
        (await prisma.fxAccount.findUniqueOrThrow({ where: { id: usdt.id } }))
          .detailsReadyAt,
      ).toBeNull();
      await sweeperOf().rereadForeignDetails(new Date());
      expect(toldTo(SECOND.wawuUserId)).toEqual([
        {
          kind: 'wallet_ready',
          userWawuId: SECOND.wawuUserId,
          currency: 'USDT',
        },
      ]);
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
      // WALK4-FIX L-1: this assertion pinned the defect (null: the review said "Shown on your receipt" before the PIN). Nuvion's
      // quote carries no fee and its swaps charge none (applicable_fee 0 on dev), so the Hub names the configured bank charge,
      // 0 unless set, as a figure.
      providerFeeMinor: 0,
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

  it('L-1: the quote names the bank charge as a figure before the PIN: 0 by default, the configured one when set, and the funds check counts it', async () => {
    const usd = await openUsd();
    const dollars = {
      fromCurrency: 'USD' as const,
      toCurrency: 'NGN' as const,
      fromAccountId: usd.id,
    };
    // Default: a figure, never null.
    const plain = await ops.quote(WALLET, { ...dollars, amountFromMinor: 10 });
    expect(plain.providerFeeMinor).toBe(0);
    expect(plain.totalFromMinor).toBe(10);
    // The bank charge of the sending currency, from config (R-10), counted in the total.
    env.FX_SWAP_PROVIDER_FEE_NGN_MINOR = '300';
    env.FX_SWAP_FEE_NGN_MINOR = '500';
    build();
    const naira = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    expect(naira).toMatchObject({
      providerFeeMinor: 300,
      wawuFeeMinor: 500,
      totalFromMinor: 100_800,
    });
    // The wallet holds 790,921: 790,700 and WAWU's 500 fit, the bank's 300 on top does not.
    const edge = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 790_300,
    });
    expect(edge.totalFromMinor).toBe(791_100);
    const err = await ops
      .swap(WALLET, scope(), { quoteId: edge.id })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).getResponse()).toMatchObject({
      reason: {
        code: 'insufficient_funds',
        balanceMinor: 790_921,
        totalMinor: 791_100,
        shortfallMinor: 179,
      },
    });
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
    // WALK4-FIX L-2: what the swap writes is what the money-in notice reads back as a swap, never as a person.
    const row = ledgerRows[0] as {
      category: string;
      counterparty: { kind: 'wawu'; name: string };
    };
    expect(row.counterparty.name).toBe('Swap from USD');
    expect(
      creditSourceOf({
        category: row.category,
        linkKind: null,
        counterpartyKind: row.counterparty.kind,
        counterpartyName: row.counterparty.name,
        counterpartyAccountNumber: null,
        counterpartyBankName: null,
      }),
    ).toMatchObject({ source: 'swap', senderName: null });
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

  /** The person's naira wallet row, which the sweep reads to act for them. */
  async function ensureWallet() {
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
  }

  /** A naira-source swap of 100,000 kobo with a 500 kobo fee, and its operation. */
  async function nairaSwapWithFee() {
    env.FX_SWAP_FEE_NGN_MINOR = '500';
    build();
    await ensureWallet();
    const usd = await openUsd();
    const q = await ops.quote(WALLET, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: 100_000,
    });
    expect(q).toMatchObject({ wawuFeeMinor: 500, totalFromMinor: 100_500 });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    const row = () =>
      prisma.fxOperation.findUniqueOrThrow({ where: { id: s.id } });
    return { s, row };
  }

  it("collects WAWU's fee on a swap out of naira the way a naira send does: to WAWU's account, by reference plus -fee, in the ledger (verifier H1)", async () => {
    const { s, row } = await nairaSwapWithFee();
    expect(nairaLegs).toHaveLength(1);
    expect(nairaLegs[0]).toMatchObject({
      fromAccountNumber: WALLET.accountNumber,
      toAccountNumber: PLATFORM,
      amountKobo: 500n,
      reference: `${(await row()).reference}-fee`,
    });
    expect(s.wawuFeeMinor).toBe(500);
    expect((await row()).feeLeg).toBe('done');
    // the swap's debit, the fee's debit from the payer, the fee's credit to WAWU
    expect(ledgerRows).toHaveLength(3);
    expect(
      ledgerRows.map(
        (r) =>
          `${(r.wallet as { kind: string }).kind}/${String(r.direction)}/${String(r.amountKobo)}`,
      ),
    ).toEqual(['user/out/100000', 'user/out/500', 'merchant/in/500']);
  });

  it('a fee the provider refuses is not marked paid: it is tried again under a new reference, and given back after three refusals', async () => {
    nairaMode = 'refused';
    const { s, row } = await nairaSwapWithFee();
    expect((await row()).feeLeg).toBe('owed:2');
    expect(ledgerRows).toHaveLength(1);
    await ops.sweep(new Date(Date.now() + 60_000));
    expect((await row()).feeLeg).toBe('owed:3');
    await ops.sweep(new Date(Date.now() + 120_000));
    const after = await row();
    expect(after.feeLeg).toBe('uncollected');
    expect(after.wawuFeeMinor).toBe(0n);
    expect(
      nairaLegs.map((l) => String(l.reference).replace(after.reference, '')),
    ).toEqual(['-fee', '-fee-2', '-fee-3']);
    expect((await ops.readSwap(WALLET, s.id)).wawuFeeMinor).toBe(0);
    await ops.sweep(new Date(Date.now() + 180_000));
    expect(nairaLegs).toHaveLength(3);
  });

  it('a refused fee that a later try collects is marked paid once, under the new reference', async () => {
    nairaMode = 'refused';
    const { row } = await nairaSwapWithFee();
    nairaMode = 'ok';
    await ops.sweep(new Date(Date.now() + 60_000));
    const after = await row();
    expect(after.feeLeg).toBe('done');
    expect(String(nairaLegs[nairaLegs.length - 1].reference)).toBe(
      `${after.reference}-fee-2`,
    );
    await ops.sweep(new Date(Date.now() + 120_000));
    expect(nairaLegs).toHaveLength(2);
    expect(
      ledgerRows.filter(
        (r) => (r.wallet as { kind: string }).kind === 'merchant',
      ),
    ).toHaveLength(1);
  });

  it('a fee whose answer was lost, or is unfinished, stays owed under the SAME reference and is never marked paid until the provider says it completed', async () => {
    nairaMode = 'unknown';
    const { row } = await nairaSwapWithFee();
    expect((await row()).feeLeg).toBe('owed');
    nairaMode = 'pending';
    await ops.sweep(new Date(Date.now() + 60_000));
    expect((await row()).feeLeg).toBe('owed');
    nairaMode = 'ok';
    await ops.sweep(new Date(Date.now() + 120_000));
    const after = await row();
    expect(after.feeLeg).toBe('done');
    expect(new Set(nairaLegs.map((l) => l.reference))).toEqual(
      new Set([`${after.reference}-fee`]),
    );
  });

  it('L2: a caller holding an older copy of the operation cannot write an older fee state over a newer one', async () => {
    nairaMode = 'refused';
    const { row } = await nairaSwapWithFee();
    const stale = await row();
    expect(stale.feeLeg).toBe('owed:2');
    nairaMode = 'ok';
    await ops.sweep(new Date(Date.now() + 60_000));
    const settled = await row();
    expect(settled.feeLeg).toBe('done');
    // A look that began before the sweep above and ends after it: the provider refuses what it is asked now.
    nairaMode = 'refused';
    await (
      ops as unknown as {
        feeLeg: (w: OpenWallet, o: typeof stale) => Promise<void>;
      }
    ).feeLeg(WALLET, stale);
    const after = await row();
    expect(after.feeLeg).toBe('done');
    expect(after.wawuFeeMinor).toBe(500n);
  });

  it('a fee in a foreign currency is paid to the collector account in that currency, and refused at start without one', async () => {
    expect(
      () =>
        new FxSettings(
          {
            get: (k: string) => ({ FX_SWAP_FEE_USD_MINOR: '5' })[k],
          } as unknown as ConfigService,
          { number: () => 1 } as unknown as PlanSettingsService,
        ),
    ).toThrow(/FX_FEE_COLLECTOR_USD_BAN/);
    const collector = fx.addCollector('0088880001', 'USD');
    env.FX_SWAP_FEE_USD_MINOR = '5';
    env.FX_FEE_COLLECTOR_USD_BAN = '0088880001';
    build();
    const usd = await openUsd();
    const prov = [...fx.accounts.values()]
      .filter((x) => x.currency === 'USD' && x.id !== collector.id)
      .pop()!;
    fx.fund(prov.id, 1_000);
    const q = await ops.quote(WALLET, {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAccountId: usd.id,
      toAccountId: (await accounts.open(WALLET, { currency: 'EUR' })).id,
      amountFromMinor: 200,
    });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    expect(
      (await prisma.fxOperation.findUniqueOrThrow({ where: { id: s.id } }))
        .feeLeg,
    ).toBe('done');
    expect(fx.balanceOf(collector.id)).toBe(5);
  });

  it("a foreign fee sent to the payer's own account (a wrong collector) is refused by the provider and never marked paid, however many times it is asked again", async () => {
    await ensureWallet();
    const usd = await openUsd();
    const prov = [...fx.accounts.values()]
      .filter((x) => x.currency === 'USD' && x.type === 'checking')
      .pop()!;
    fx.fund(prov.id, 1_000);
    env.FX_SWAP_FEE_USD_MINOR = '5';
    env.FX_FEE_COLLECTOR_USD_BAN = prov.nuvion_ban;
    build();
    const eur = await accounts.open(WALLET, { currency: 'EUR' });
    const q = await ops.quote(WALLET, {
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAccountId: usd.id,
      toAccountId: eur.id,
      amountFromMinor: 200,
    });
    const s = await ops.swap(WALLET, scope(), { quoteId: q.id });
    const row = () =>
      prisma.fxOperation.findUniqueOrThrow({ where: { id: s.id } });
    expect((await row()).feeLeg).not.toBe('done');
    await ops.sweep(new Date(Date.now() + 60_000));
    await ops.sweep(new Date(Date.now() + 120_000));
    await ops.sweep(new Date(Date.now() + 180_000));
    expect((await row()).feeLeg).toBe('uncollected');
    expect((await row()).wawuFeeMinor).toBe(0n);
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
    await ensureWallet();
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

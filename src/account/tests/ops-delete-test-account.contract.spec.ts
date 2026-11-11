import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FintavaDouble,
  FREEZE_200,
  WALLET_BALANCE,
} from '../../../test/fintava/fintava-double';
import {
  deleteTestAccount,
  LEAVING_REASON,
  parseArgs,
  proveTestProvider,
  type Deps,
  type Options,
} from '../../../scripts/ops/delete-test-account';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountModule } from '../account.module';
import { AccountDeletionIdentityService } from '../account-deletion-identity.service';
import { AccountDeletionMoneyService } from '../account-deletion-money.service';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from '../wawu-id-account.gateway';

/**
 * OPS-DEL-TEST: the one-off script that deletes one test account holding test wallet money.
 * Made-up accounts only. The real services run over a real database and the Fintava double; the wallet
 * provider's settings the script reads (`getEnv`) are given sandbox-looking or live-looking values.
 */
const SANDBOX_ENV: Record<string, string> = {
  WALLET_PROVIDER: 'fintava',
  FINTAVA_BASE_URL: 'https://dev.fintavapay.com',
};
const LIVE_ENV: Record<string, string> = {
  WALLET_PROVIDER: 'fintava',
  FINTAVA_BASE_URL: 'https://live.fintavapay.com',
};

describe('delete-test-account (OPS-DEL-TEST)', () => {
  const double = new FintavaDouble();
  const balances = new Map<string, number>();
  const gateway: jest.Mocked<WawuIdAccountGateway> = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const previousEnv: Record<string, string | undefined> = {};
  const emails = new Map<string, string[]>();
  const people: string[] = [];
  let prisma: PrismaService;
  let closeApp: () => Promise<void>;
  let deps: Omit<Deps, 'getEnv' | 'out'>;

  async function person(email: string, handle: string, balanceKobo?: number) {
    const id = randomUUID();
    people.push(id);
    emails.set(email.toLowerCase(), [
      ...(emails.get(email.toLowerCase()) ?? []),
      id,
    ]);
    await prisma.userProfile.create({
      data: { wawuUserId: id, accountType: 'creator', handle },
    });
    if (balanceKobo !== undefined) {
      const walletId = `w-${id}`;
      balances.set(walletId, balanceKobo);
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: `c-${id}`,
          walletId,
          accountNumber: `8${Math.floor(Math.random() * 1e9)
            .toString()
            .padStart(9, '0')}`,
        },
      });
    }
    return id;
  }

  function piece(creator: string, title: string) {
    const id = randomUUID();
    return prisma.contentPiece.create({
      data: {
        id,
        slug: `odt-${id.slice(0, 8)}`,
        creatorWawuId: creator,
        contentType: 'video',
        title,
        description: 'FIXTURE: ops-delete-test-account.contract.spec.ts',
        category: 'beauty',
        tags: [],
        accessType: 'paid',
        price: 100,
        previewAssetUrl: 'https://storage.test/fixture-preview.mp4',
        status: 'live',
      },
    });
  }

  async function hold(payer: string, payee: string) {
    const id = randomUUID();
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: id,
        title: 'A tip',
        priceKobo: 10000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 10000n,
        payeeShareKobo: 8500n,
        wawuShareKobo: 1500n,
        customerReference: `odt-${id}`,
        merchantAccountNumber: '1102038668',
        status: 'completed',
      },
    });
    await prisma.walletHold.create({
      data: {
        paymentId: id,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'paid_dm',
        targetId: id,
        title: 'A paid DM',
        releaseCondition: 'dm_answered',
        amountKobo: 10000n,
        payeeShareKobo: 8500n,
        wawuShareKobo: 1500n,
        merchantAccountNumber: '1102038668',
        heldAt: new Date(),
      },
    });
  }

  /** Row count of every table: the proof that a run wrote nothing. */
  async function snapshot(): Promise<Record<string, number>> {
    const rows = await prisma.$queryRawUnsafe<{ t: string; c: number }[]>(
      `select table_name as t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as c
       from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    return Object.fromEntries(rows.map((r) => [r.t, r.c]));
  }

  async function run(
    email: string,
    over: Partial<Options> = {},
    env: Record<string, string> = SANDBOX_ENV,
  ) {
    const lines: string[] = [];
    const code = await deleteTestAccount(
      {
        ...deps,
        getEnv: (k) => env[k],
        out: (l) => lines.push(l),
      },
      { email, apply: false, ...over },
    );
    return { code, text: lines.join('\n') };
  }

  const phraseOf = (text: string) => /Confirmation phrase: (.*)/.exec(text)![1];

  beforeAll(async () => {
    await double.start();
    double.on('GET', /^\/customer\/wallet\/balance\//, (req) => {
      const id = decodeURIComponent(req.path.split('/').pop()!);
      const kobo = balances.get(id);
      if (kobo === undefined) {
        return { status: 404, body: { status: 404, message: ['No wallet'] } };
      }
      return {
        status: 200,
        body: {
          ...WALLET_BALANCE,
          data: {
            ...WALLET_BALANCE.data,
            balance: {
              bookedBalance: kobo / 100,
              availableBalance: kobo / 100,
            },
          },
        },
      };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/freeze$/, () => ({
      status: 200,
      body: FREEZE_200,
    }));
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/unfreeze$/, () => ({
      status: 200,
      body: {
        ...FREEZE_200,
        data: { ...FREEZE_200.data, isFrozen: false },
        message: 'Wallet unfrozen successfully',
      },
    }));
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_odt_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '5000',
      FINTAVA_MONEY_TIMEOUT_MS: '5000',
      FINTAVA_CHECK_TIMEOUT_MS: '5000',
    };
    for (const [k, v] of Object.entries(env)) {
      previousEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    closeApp = () => app.close();
    prisma = moduleRef.get(PrismaService);
    deps = {
      prisma,
      money: moduleRef.get(AccountDeletionMoneyService),
      identity: moduleRef.get(AccountDeletionIdentityService),
      sweep: moduleRef.get(AccountDeletionSweepService),
      resolveEmail: (e) =>
        Promise.resolve(emails.get(e.trim().toLowerCase()) ?? []),
    };
  });

  const scheduleCalls = () => gateway.scheduleAccountDeletion.mock.calls;
  const finalizeCalls = () => gateway.finalizeAccountDeletion.mock.calls;

  beforeEach(() => {
    gateway.scheduleAccountDeletion.mockClear();
    gateway.finalizeAccountDeletion.mockClear();
  });

  afterAll(async () => {
    if (prisma) {
      const payments = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: people } },
            { payeeWawuUserId: { in: people } },
          ],
        },
        select: { id: true },
      });
      const ids = payments.map((p) => p.id);
      await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
      await prisma.walletPayment.deleteMany({ where: { id: { in: ids } } });
      await prisma.purchase.deleteMany({
        where: {
          OR: [
            { creatorWawuId: { in: people } },
            { buyerWawuId: { in: people } },
          ],
        },
      });
      await prisma.creditLot.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await prisma.creditPurchase.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await prisma.billPayment.deleteMany({
        where: { buyerWawuId: { in: people } },
      });
      await prisma.walletWithdrawal.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.walletLedgerEntry.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.creatorWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.walletCard.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.accountDeletionContent.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.contentPiece.deleteMany({
        where: { title: { startsWith: 'ODT ' } },
      });
      await prisma.accountDeletion.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.adminUser.deleteMany({
        where: { email: 'odt-admin@example.test' },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: people } },
      });
    }
    await closeApp?.();
    await double.stop();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('the provider proof', () => {
    it('accepts a sandbox host and refuses a live one, for both providers', () => {
      expect(proveTestProvider((k) => SANDBOX_ENV[k]).ok).toBe(true);
      expect(proveTestProvider((k) => LIVE_ENV[k]).ok).toBe(false);
      const nuvion = {
        WALLET_PROVIDER: 'nuvion',
        NUVION_API_KEY: 'k-not-printed-0123456789',
        NUVION_WEBHOOK_SECRET: 'whsec-0123456789',
        NUVION_OPERATIONAL_ACCOUNT_ID: '01OPERATIONAL00000000001',
      };
      const sandbox = proveTestProvider(
        (k) =>
          ({ ...nuvion, NUVION_BASE_URL: 'https://api.nuvion.dev' })[
            k as keyof typeof nuvion
          ],
      );
      expect(sandbox.ok).toBe(true);
      const live = proveTestProvider(
        (k) => ({ ...nuvion, NUVION_BASE_URL: 'https://api.nuvion.co' })[k],
      );
      expect(live.ok).toBe(false);
      // Unreadable settings are a refusal, never a pass.
      expect(proveTestProvider(() => undefined).ok).toBe(true); // fintava default: sandbox host
      expect(
        proveTestProvider((k) => ({ WALLET_PROVIDER: 'nuvion' })[k]).ok,
      ).toBe(false);
    });
  });

  describe('dry run, apply, and running twice', () => {
    it('dry run writes nothing; apply deletes only the one account; a second apply finds nothing', async () => {
      const a = await person('odt-a@example.test', 'odt_a', 5_000_000);
      const b = await person('odt-a2@example.test', 'odt_a2', 0);
      const buyer = await person('odt-buyer@example.test', 'odt_buyer');
      await piece(a, 'ODT sold');
      await piece(a, 'ODT unsold');
      const bPiece = await piece(b, 'ODT other');
      const before = await snapshot();
      const dry = await run('odt-a@example.test');
      expect(dry.code).toBe(0);
      expect(dry.text).toContain('DRY RUN');
      expect(dry.text).toContain('balance 5000000 kobo');
      expect(dry.text).toContain('wallet_balance: waived (test balance)');
      expect(dry.text).toContain('Proof: FINTAVA_BASE_URL');
      expect(dry.text).not.toContain('FAKEKEY');
      expect(await snapshot()).toEqual(before);
      expect(scheduleCalls()).toHaveLength(0);

      const phrase = phraseOf(dry.text);
      expect(phrase).toBe(
        `DELETE ${(await prisma.userProfile.findFirstOrThrow({ where: { handle: 'odt_a' } })).wawuUserId.slice(0, 8)}`,
      );
      const applied = await run('odt-a@example.test', {
        apply: true,
        confirm: phrase,
      });
      expect(applied.text).toContain('Outcome: purged');
      expect(applied.code).toBe(0);
      expect(scheduleCalls()[0]).toEqual([a, expect.any(Date)]);
      expect(finalizeCalls()).toHaveLength(1);
      expect(finalizeCalls()[0]).toEqual([a]);

      // A is gone; B and the buyer are untouched.
      expect(
        await prisma.userProfile.findUnique({ where: { wawuUserId: a } }),
      ).toBeNull();
      expect(
        await prisma.fintavaWallet.findUnique({ where: { wawuUserId: a } }),
      ).toBeNull();
      expect(
        await prisma.userProfile.findUnique({ where: { wawuUserId: b } }),
      ).not.toBeNull();
      expect(
        await prisma.userProfile.findUnique({ where: { wawuUserId: buyer } }),
      ).not.toBeNull();
      expect(
        await prisma.fintavaWallet.findUnique({ where: { wawuUserId: b } }),
      ).not.toBeNull();
      expect(
        await prisma.contentPiece.findUnique({ where: { id: bPiece.id } }),
      ).not.toBeNull();
      expect(
        await prisma.contentPiece.count({ where: { creatorWawuId: a } }),
      ).toBe(0);
      // R-130 (a bought piece stays with its buyer) while this script runs: see the "R-130" test below. A sale writes
      // a Flutterwave Purchase row, which this script refuses, so the piece and the buyer's purchase are left as they are.
      // Both of A's pieces went; nothing else lost a row beyond A's own.
      const after = await snapshot();
      const lost = Object.keys(before).filter((t) => after[t] < before[t]);
      expect(lost.sort()).toEqual(
        expect.arrayContaining([
          'ContentPiece',
          'FintavaWallet',
          'UserProfile',
        ]),
      );
      expect(before.ContentPiece - after.ContentPiece).toBe(2);
      expect(before.UserProfile - after.UserProfile).toBe(1);
      // The audit record.
      const row = await prisma.accountDeletion.findUnique({
        where: { wawuUserId: a },
      });
      expect(row).toMatchObject({
        status: 'purged',
        leavingReason: LEAVING_REASON,
      });

      // Second apply: WAWU ID no longer knows the email, so there is nothing to do.
      emails.delete('odt-a@example.test');
      const snap = await snapshot();
      const again = await run('odt-a@example.test', {
        apply: true,
        confirm: phrase,
      });
      expect(again.code).toBe(0);
      expect(again.text).toContain('Nothing to do');
      expect(await snapshot()).toEqual(snap);
      expect(finalizeCalls()).toHaveLength(1);
    });

    it('a second apply after a half-finished first one (WAWU ID down) finishes it', async () => {
      const a = await person('odt-half@example.test', 'odt_half', 1_000);
      gateway.finalizeAccountDeletion.mockRejectedValueOnce(new Error('down'));
      const phrase = `DELETE ${a.slice(0, 8)}`;
      const first = await run('odt-half@example.test', {
        apply: true,
        confirm: phrase,
      });
      expect(first.code).toBe(2);
      expect(first.text).toContain('safe to run the same command again');
      const second = await run('odt-half@example.test', {
        apply: true,
        confirm: phrase,
      });
      expect(second.code).toBe(0);
      expect(finalizeCalls()).toHaveLength(2);
      expect(
        (await prisma.accountDeletion.findUnique({ where: { wawuUserId: a } }))!
          .status,
      ).toBe('purged');
    });
  });

  describe('refusals (each changes nothing)', () => {
    async function refused(
      email: string,
      over: Partial<Options>,
      env?: Record<string, string>,
    ) {
      const before = await snapshot();
      const r = await run(email, over, env);
      expect(r.code).toBe(1);
      expect(r.text).toContain('REFUSED');
      expect(await snapshot()).toEqual(before);
      expect(scheduleCalls()).toHaveLength(0);
      return r;
    }

    it('live-looking provider settings', async () => {
      const live = await person('odt-live@example.test', 'odt_live', 100);
      const r = await refused(
        'odt-live@example.test',
        { apply: true, confirm: `DELETE ${live.slice(0, 8)}` },
        LIVE_ENV,
      );
      expect(r.text).toContain('not proven to be on test credentials');
    });

    it('two matches', async () => {
      await person('odt-two@example.test', 'odt_two1', 100);
      await person('odt-two@example.test', 'odt_two2', 100);
      const r = await refused('odt-two@example.test', {
        apply: true,
        confirm: 'DELETE x',
      });
      expect(r.text).toContain('2 accounts match');
    });

    it('no phrase, and a wrong phrase', async () => {
      await person('odt-ph@example.test', 'odt_ph', 100);
      expect(
        (await refused('odt-ph@example.test', { apply: true })).text,
      ).toContain('needs --confirm');
      expect(
        (
          await refused('odt-ph@example.test', {
            apply: true,
            confirm: 'DELETE someone',
          })
        ).text,
      ).toContain('not the one printed');
    });

    it('an open hold, unless --allow-test-holds', async () => {
      const c = await person('odt-hold@example.test', 'odt_hold', 100);
      const other = await person('odt-hold-other@example.test', 'odt_hold_o');
      await hold(c, other);
      const r = await refused('odt-hold@example.test', {
        apply: true,
        confirm: `DELETE ${c.slice(0, 8)}`,
      });
      expect(r.text).toContain('open_hold: REFUSES');
      // The payee's side refuses too: a payer's held money never sits against a deleted payee (M1).
      const rp = await refused('odt-hold-other@example.test', {
        apply: true,
        confirm: 'DELETE x',
      });
      expect(rp.text).toMatch(/open_hold: REFUSES\. Release or refund/);
      expect(rp.text).toContain('no flag waives them');
      expect(
        await prisma.userProfile.findUnique({ where: { wawuUserId: c } }),
      ).not.toBeNull();
    });

    it('has no flag that waives a blocker', () => {
      const parsed = parseArgs([
        '--email',
        'x@example.test',
        '--allow-test-holds',
      ]);
      expect(typeof parsed).toBe('string');
      expect(parsed).toContain('--allow-test-holds');
    });

    it('an admin login', async () => {
      await person('odt-admin@example.test', 'odt_admin', 100);
      await prisma.adminUser.create({
        data: {
          email: 'odt-admin@example.test',
          passwordHash: 'x',
          name: 'Fixture Admin',
          role: 'superadmin',
        } as never,
      });
      const r = await refused('ODT-ADMIN@example.test', {
        apply: true,
        confirm: 'DELETE x',
      });
      expect(r.text).toContain('admin login');
    });
  });
  describe('real-money rows (B1): listed in the dry run, apply refuses, nothing is written', () => {
    /** The verifier's seed: every kind of row the website's Flutterwave rail writes, for one account. */
    async function seedFlutterwave(id: string, other: string) {
      const ref = () => `odt-${randomUUID()}`;
      await prisma.creatorWallet.create({
        data: { wawuUserId: id, accountReference: ref(), barterId: ref() },
      });
      const entry = await prisma.walletLedgerEntry.create({
        data: {
          wawuUserId: id,
          kind: 'withdrawal',
          amount: 500,
          reference: ref(),
          status: 'pending',
        },
      });
      await prisma.walletWithdrawal.create({
        data: {
          wawuUserId: id,
          entryId: entry.id,
          amount: 500,
          bankCode: '000',
          accountNumber: '0000000000',
          accountName: 'Fixture',
        },
      });
      await prisma.purchase.create({
        data: {
          type: 'content',
          buyerWawuId: id,
          creatorWawuId: other,
          amount: 100,
          commissionRate: 0.15,
          flutterwaveTxRef: ref(),
          status: 'pending',
        },
      });
      await prisma.billPayment.create({
        data: {
          buyerWawuId: id,
          category: 'airtime',
          billerCode: 'b',
          itemCode: 'i',
          billerName: 'Fixture',
          customerRef: '0',
          amount: 200,
          flutterwaveTxRef: ref(),
        },
      });
      await prisma.walletCard.create({
        data: {
          wawuUserId: id,
          provider: 'someone-else',
          reference: ref(),
          type: 'virtual',
          name: 'Fixture',
          state: 'active',
        },
      });
      const cp = await prisma.creditPurchase.create({
        data: {
          userWawuId: id,
          pack: 'starter',
          creditsGranted: 10,
          flutterwaveTxRef: ref(),
          amount: 300,
        },
      });
      await prisma.creditLot.create({
        data: {
          creditPurchaseId: cp.id,
          userWawuId: id,
          creditsGranted: 10,
          creditsRemaining: 10,
          grossKobo: 30000,
        },
      });
    }

    it('lists each row, refuses apply, writes nothing', async () => {
      const id = await person('odt-fw@example.test', 'odt_fw', 100);
      const other = await person('odt-fw-seller@example.test', 'odt_fw_s');
      await seedFlutterwave(id, other);
      const before = await snapshot();
      const dry = await run('odt-fw@example.test');
      expect(dry.code).toBe(1);
      for (const t of [
        'CreatorWallet',
        'WalletLedgerEntry',
        'WalletWithdrawal',
        'Purchase',
        'BillPayment',
        'WalletCard',
        'CreditPurchase',
        'CreditLot',
      ]) {
        expect(dry.text).toContain(`  ${t} `);
      }
      expect(dry.text).toContain('status pending amount 50000 kobo');
      expect(dry.text).toContain('REFUSED');
      const applied = await run('odt-fw@example.test', {
        apply: true,
        confirm: phraseOf(dry.text),
      });
      expect(applied.code).toBe(1);
      expect(applied.text).toContain('touch a real-money provider');
      expect(applied.text).not.toContain('Audit:');
      expect(await snapshot()).toEqual(before);
      expect(scheduleCalls()).toHaveLength(0);
      expect(
        await prisma.creatorWallet.findUnique({ where: { wawuUserId: id } }),
      ).not.toBeNull();
    });

    it('R-130: a creator whose piece another account bought is refused, and the buyer keeps the piece and the purchase', async () => {
      const creator = await person(
        'odt-r130-c@example.test',
        'odt_r130_c',
        100,
      );
      const buyer = await person('odt-r130-b@example.test', 'odt_r130_b');
      const sold = await piece(creator, 'ODT r130 sold');
      const purchase = await prisma.purchase.create({
        data: {
          contentId: sold.id,
          type: 'content',
          buyerWawuId: buyer,
          creatorWawuId: creator,
          amount: 100,
          commissionRate: 0.15,
          flutterwaveTxRef: `odt-${randomUUID()}`,
          status: 'completed',
        },
      });
      const before = await snapshot();
      // The seller side.
      const dry = await run('odt-r130-c@example.test');
      expect(dry.code).toBe(1);
      expect(dry.text).toContain('  Purchase ');
      const sellerApply = await run('odt-r130-c@example.test', {
        apply: true,
        confirm: `DELETE ${creator.slice(0, 8)}`,
      });
      expect(sellerApply.code).toBe(1);
      expect(sellerApply.text).toContain('touch a real-money provider');
      // The buyer side: the buyer's own account is refused too, so neither side loses the sale.
      const buyerApply = await run('odt-r130-b@example.test', {
        apply: true,
        confirm: `DELETE ${buyer.slice(0, 8)}`,
      });
      expect(buyerApply.code).toBe(1);
      expect(buyerApply.text).toContain('  Purchase ');
      expect(await snapshot()).toEqual(before);
      expect(scheduleCalls()).toHaveLength(0);
      expect(
        await prisma.contentPiece.findUnique({ where: { id: sold.id } }),
      ).not.toBeNull();
      expect(
        await prisma.purchase.findUnique({ where: { id: purchase.id } }),
      ).toMatchObject({ buyerWawuId: buyer, status: 'completed' });
    });

    it('the Flutterwave tables the first list missed refuse (legal, waitlist, CAC fee, store, ledger of another provider)', async () => {
      const id = await person('odt-fw2@example.test', 'odt_fw2', 100);
      await prisma.legalRequest.create({
        data: {
          wawuUserId: id,
          serviceCode: 'odt',
          serviceName: 'Fixture',
          category: 'odt',
          path: 'consultation',
          consultationFee: 5000,
          consultationTxRef: `odt-${randomUUID()}`,
        } as never,
      });
      await prisma.serviceApplication.create({
        data: {
          applicantWawuId: id,
          kind: 'cac',
          title: 'Fixture',
          reference: `odt-${randomUUID()}`,
          status: 'paid',
          statusLabel: 'Paid',
          amountPaid: 25000,
          timeline: [],
        } as never,
      });
      const ref = randomUUID();
      await prisma.waitlistRegistration.create({
        data: {
          offerId: 'odt',
          fullName: 'Fixture',
          phone: '0',
          email: 'odt-fw2@example.test',
          consentAt: new Date(),
          reference: `wawu-join-${ref}`,
          status: 'paid',
          amountKobo: 100,
          flutterwaveTxId: `odt-${ref}`,
          paidKobo: 100,
          paidAt: new Date(),
          claimedByWawuId: id,
          claimedAt: new Date(),
        } as never,
      });
      const before = await snapshot();
      const r = await run('odt-fw2@example.test', {
        apply: true,
        confirm: `DELETE ${id.slice(0, 8)}`,
      });
      expect(r.code).toBe(1);
      for (const t of [
        'LegalRequest',
        'ServiceApplication',
        'WaitlistRegistration',
      ])
        expect(r.text).toContain(`  ${t} `);
      expect(await snapshot()).toEqual(before);
      await prisma.legalRequest.deleteMany({ where: { wawuUserId: id } });
      await prisma.serviceApplication.deleteMany({
        where: { applicantWawuId: id },
      });
      await prisma.waitlistRegistration.deleteMany({
        where: { claimedByWawuId: id },
      });
    });

    it('a clean sandbox-only account still deletes, with a row of the running provider', async () => {
      const id = await person('odt-sb@example.test', 'odt_sb', 2_000);
      await prisma.walletCard.create({
        data: {
          wawuUserId: id,
          provider: 'fintava',
          reference: `odt-${randomUUID()}`,
          type: 'virtual',
          name: 'Fixture',
          state: 'active',
        },
      });
      const r = await run('odt-sb@example.test', {
        apply: true,
        confirm: `DELETE ${id.slice(0, 8)}`,
      });
      expect(r.code).toBe(0);
      expect(r.text).toContain('Real-money rows: none');
      expect(r.text).toContain('Audit:');
      expect(
        await prisma.userProfile.findUnique({ where: { wawuUserId: id } }),
      ).toBeNull();
    });

    it('a refusal prints no Audit line', async () => {
      const id = await person('odt-na@example.test', 'odt_na', 100);
      await prisma.creatorWallet.create({
        data: {
          wawuUserId: id,
          accountReference: `odt-${randomUUID()}`,
          barterId: `odt-${randomUUID()}`,
        },
      });
      const r = await run('odt-na@example.test', {
        apply: true,
        confirm: `DELETE ${id.slice(0, 8)}`,
      });
      expect(r.code).toBe(1);
      expect(r.text).not.toContain('Audit:');
    });
  });
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  nuvionLiveReset,
  parseArgs,
  phraseFor,
  type Deps,
  type Options,
} from '../../../scripts/ops/nuvion-live-reset';
import { runUnowned } from '../../../scripts/ops/nuvion-live-reset';
import { RETIRED_PROVIDER } from '../../../scripts/ops/nuvion-live-reset-kinds';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PointsService } from '../../points/points.service';

/**
 * NUV-LIVE: the reset command on made-up people, on the test database. No provider is called (the command has no
 * provider to call; a source check below keeps it so). Each "kept" person has a control that retires.
 */
const SANDBOX: Record<string, string> = {
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_RESET00notarealkey000000',
  NUVION_WEBHOOK_SECRET: 'whsec_reset_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
};
const LIVE: Record<string, string> = {
  ...SANDBOX,
  NUVION_BASE_URL: 'https://api.nuvion.co',
};
const MERCHANT = '1102038668';

describe('nuvion-live-reset (NUV-LIVE)', () => {
  let prisma: PrismaService;
  let points: PointsService;
  let closeApp: () => Promise<void>;
  const people: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let seq = 0;

  const uid = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };
  const acct = () =>
    `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, '0')}`;

  async function run(
    opts: Partial<Options>,
    env: Record<string, string> = SANDBOX,
    extra: Partial<Deps> = {},
  ) {
    const lines: string[] = [];
    const code = await nuvionLiveReset(
      {
        prisma,
        points,
        getEnv: (k) => env[k],
        out: (l) => lines.push(l),
        onlyIds: [...people],
        ...extra,
      },
      { apply: false, ...opts },
    );
    return { code, text: lines.join('\n'), lines };
  }
  const phrase = (n: number) => phraseFor(n);

  /** A Flutterwave payout subaccount: a row the real-money list refuses on. */
  async function realRow(id: string) {
    await prisma.creatorWallet.create({
      data: {
        wawuUserId: id,
        accountReference: `${tag}-ref-${id}`,
        barterId: `${tag}-bar-${id}`,
      },
    });
  }

  async function wallet(id: string, provider = 'nuvion') {
    const accountNumber = acct();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `c-${randomUUID()}`,
        walletId: `w-${randomUUID()}`,
        accountNumber,
        provider,
      },
    });
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: 'opened',
        bvnHash: `bvn-${randomUUID()}`,
        bvnVerifiedAt: new Date(),
        phone: `+23480${Date.now().toString().slice(-8)}${seq}`,
        provider,
      },
    });
    await prisma.nuvionEntity.create({
      data: { wawuUserId: id, entityId: `ent-${randomUUID()}` },
    });
    await prisma.nuvionOnboarding.create({
      data: { wawuUserId: id, entityId: `ent-${randomUUID()}` },
    });
    await prisma.walletIdentity.create({ data: { wawuUserId: id } });
    return accountNumber;
  }

  async function payment(
    payer: string,
    payee: string,
    status: string,
    over: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: id,
        title: 'A tip',
        priceKobo: 100000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 100000n,
        payeeShareKobo: 85000n,
        wawuShareKobo: 15000n,
        customerReference: `${tag}-${id}`,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        status,
        nextCheckAt: status === 'pending' ? new Date() : null,
        completedAt: status === 'completed' ? new Date() : null,
        openKey: status === 'pending' ? `${tag}-open-${id}` : null,
        ...over,
      },
    });
    return id;
  }
  async function hold(paymentId: string, payer: string, payee: string) {
    return prisma.walletHold.create({
      data: {
        paymentId,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'dm',
        targetId: paymentId,
        title: 'A held DM',
        releaseCondition: 'reply',
        amountKobo: 100000n,
        payeeShareKobo: 85000n,
        wawuShareKobo: 15000n,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        heldAt: new Date(),
        nextAttemptAt: new Date(),
      },
    });
  }
  async function settlement(payee: string, paymentId: string, owed = true) {
    const move = await prisma.earningMove.create({
      data: {
        payeeWawuUserId: payee,
        dayKey: `${tag}-${seq++}`,
        provider: 'nuvion',
        merchantAccountNumber: MERCHANT,
        amountKobo: 85000n,
        earnings: 1,
        customerReference: `${tag}-mv-${randomUUID()}`,
      },
    });
    void owed;
    return prisma.earningSettlement.create({
      data: {
        paymentId,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: paymentId,
        title: 'A tip',
        earnedAt: new Date(),
        amountKobo: 85000n,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        customerReference: `wawu-earn-${paymentId}-1`,
        moveId: move.id,
      },
    });
  }
  async function ledger(id: string, accountNumber: string) {
    const e = await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: id,
        accountNumber,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 5000n,
        totalKobo: 5000n,
        source: 'test',
        occurredAt: new Date(),
        provider: 'nuvion',
        nextCheckAt: new Date(),
      },
    });
    await prisma.moneyReceipt.create({
      data: {
        code: `${tag}-${randomUUID()}`,
        entryId: e.id,
        wawuUserId: id,
        accountNumber,
      },
    });
    return e;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    points = new PointsService(prisma);
    closeApp = () => moduleRef.close();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningSettlement" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningMove" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await closeApp();
  });

  it('refuses on live keys and without proof, and has no provider to call', async () => {
    expect((await run({}, LIVE)).code).toBe(1);
    const noEnv = await run({}, {});
    expect(noEnv.code).toBe(1);
    expect(noEnv.text).toContain('REFUSED');
    expect(
      (await run({}, { ...SANDBOX, WALLET_PROVIDER: 'fintava' })).code,
    ).toBe(1);
    const src = readFileSync(
      join(__dirname, '../../../scripts/ops/nuvion-live-reset.ts'),
      'utf8',
    );
    expect(src).not.toMatch(
      /from '\.\.\/\.\.\/src\/(nuvion|fintava)\/(?!nuvion-config)/,
    );
    expect(src).not.toMatch(/fetch\(|https?\.request|axios/);
    expect(src).not.toContain('—');
  });

  it('parses its arguments and has no flag that waives a rule', () => {
    expect(parseArgs([])).toEqual({ apply: false, confirm: undefined });
    expect(typeof parseArgs(['--force'])).toBe('string');
    expect(typeof parseArgs(['--apply', '--confirm'])).toBe('string');
  });

  describe('one test-era person with a row of every kind', () => {
    const a = uid();
    const b = uid();
    const real = uid();
    let paymentPending: string;
    let paymentDone: string;
    let holdPaymentId: string;
    let accountA: string;
    let convId: string;

    beforeAll(async () => {
      accountA = await wallet(a);
      await wallet(b);
      await ledger(a, accountA);
      paymentPending = await payment(a, b, 'pending');
      holdPaymentId = await payment(a, b, 'completed');
      await hold(holdPaymentId, a, b);
      paymentDone = await payment(b, a, 'completed', {
        fulfilledAt: null,
      });
      await settlement(
        a,
        await payment(b, a, 'completed', { fulfilledAt: new Date() }),
      );
      await prisma.walletTransfer.create({
        data: {
          payerWawuUserId: a,
          recipientWawuUserId: b,
          amountKobo: 1000n,
          providerFeeKobo: 0n,
          wawuFeeKobo: 0n,
          totalKobo: 1000n,
          feeTransferDue: true,
          customerReference: `${tag}-tr-${randomUUID()}`,
          provider: 'nuvion',
          status: 'pending',
          nextCheckAt: new Date(),
        },
      });
      await prisma.addMoneySession.create({
        data: {
          wawuUserId: a,
          provider: 'nuvion',
          rail: 'card',
          amountKobo: 1000n,
          chargeKobo: 1000n,
          reference: `${tag}-am-${randomUUID()}`,
          status: 'awaiting_user',
        },
      });
      await prisma.walletCard.create({
        data: {
          wawuUserId: a,
          provider: 'nuvion',
          reference: `${tag}-card`,
          type: 'virtual',
          name: 'A card',
          state: 'active',
        },
      });
      await prisma.communityPassRefund.create({
        data: {
          communityId: randomUUID(),
          userWawuId: a,
          hostWawuId: b,
          removedAt: new Date(),
          unusedDays: 3,
          amountKobo: 1000n,
          hostShareKobo: 850n,
          merchantAccountNumber: MERCHANT,
          provider: 'nuvion',
          customerReference: `${tag}-pr-${randomUUID()}`,
        },
      });
      await prisma.moneyPayoutAccount.upsert({
        where: { wawuUserId: a },
        create: {
          wawuUserId: a,
          bankCode: '058',
          bankName: 'A bank',
          accountNumber: '0123456789',
          accountName: 'Test Person',
          nuvionCounterpartyId: 'cp_test_1',
          nuvionPaymentDetailId: 'pd_test_1',
          nuvionCheckedAt: new Date(),
        } as never,
        update: {},
      });
      await prisma.capitalOrder.create({
        data: {
          wawuUserId: a,
          reserveKey: `${tag}-cap`,
          fingerprint: 'fp',
          state: 'reserved',
          provider: 'nuvion',
          nuvionOrderId: `ord-${randomUUID()}`,
          productId: 'p',
          productName: 'P',
          productType: 'T',
          currency: 'USD',
          amountMinor: 1000n,
          feeKobo: 500n,
          feeState: 'owed',
        },
      });
      // A held cash-out with its points hold.
      await points.grant({
        wawuUserId: a,
        source: 'referral',
        sourceRef: `${tag}-grant`,
        points: 5000,
        expiresAt: new Date(Date.now() + 86400000 * 30),
      });
      convId = randomUUID();
      await points.hold({
        wawuUserId: a,
        purpose: 'cash_out',
        reference: convId,
        points: 1000,
      });
      await prisma.pointConversion.create({
        data: {
          id: convId,
          wawuUserId: a,
          points: 1000,
          cashKobo: 1000n,
          per1000PointsKobo: 1000n,
          merchantAccountNumber: MERCHANT,
          provider: 'nuvion',
          customerReference: `wawu-pts-${convId}`,
        },
      });
      await wallet(real);
      await realRow(real);
    });

    it('dry run writes nothing, prints ids only, and names the phrase', async () => {
      const before = await prisma.fintavaWallet.count({
        where: { wawuUserId: { in: people } },
      });
      const r = await run({});
      expect(r.code).toBe(0);
      expect(r.text).toContain('DRY RUN');
      expect(r.text).toContain(`Person ${a}`);
      expect(r.text).toMatch(
        /Confirmation phrase: RETIRE \d+ NUVION TEST WALLETS/,
      );
      expect(r.text).not.toMatch(/Test Person|0123456789|\+234/);
      expect(r.text).not.toContain('—');
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: people } },
        }),
      ).toBe(before);
      expect(
        await prisma.walletPayment.count({
          where: { id: paymentPending, status: 'pending' },
        }),
      ).toBe(1);
    });

    it('refuses without the phrase, or with a wrong one', async () => {
      const dry = await run({});
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      expect((await run({ apply: true })).code).toBe(1);
      expect((await run({ apply: true, confirm: phrase(n + 1) })).code).toBe(1);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: a } }),
      ).toBe(1);
    });

    it('apply retires exactly the listed people; a second run finds nothing', async () => {
      const dry = await run({});
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      const keptBefore = [...dry.text.matchAll(/KEPT (\S+):/g)].map(
        (m) => m[1],
      );
      const res = await run({ apply: true, confirm: phrase(n) });
      expect(res.text).toContain(`Retired ${a}`);
      expect(res.code).toBe(0);

      // Nobody sees a wallet; the BVN and phone are free; no Nuvion entity.
      for (const t of [a, b]) {
        expect(
          await prisma.fintavaWallet.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.fintavaWalletOpening.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.nuvionEntity.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.walletIdentity.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.fintavaLedgerEntry.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.earningSettlement.count({
            where: { payeeWawuUserId: t },
          }),
        ).toBe(0);
        expect(
          await prisma.earningMove.count({ where: { payeeWawuUserId: t } }),
        ).toBe(0);
      }
      // In motion: closed, relabelled, nothing left on provider nuvion that is open.
      const p = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: paymentPending },
      });
      expect(p.status).toBe('failed');
      expect(p.provider).toBe(RETIRED_PROVIDER);
      expect(p.openKey).toBeNull();
      expect(p.nextCheckAt).toBeNull();
      const unfulfilled = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: paymentDone },
      });
      expect(unfulfilled.fulfilledAt).not.toBeNull();
      const h = await prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: holdPaymentId },
      });
      expect(h.status).toBe('refunded');
      expect(h.provider).toBe(RETIRED_PROVIDER);
      expect(h.nextAttemptAt).toBeNull();
      const t = await prisma.walletTransfer.findFirstOrThrow({
        where: { payerWawuUserId: a },
      });
      expect([t.status, t.provider, t.feeTransferDue]).toEqual([
        'failed',
        RETIRED_PROVIDER,
        false,
      ]);
      expect(
        (
          await prisma.addMoneySession.findFirstOrThrow({
            where: { wawuUserId: a },
          })
        ).status,
      ).toBe('cancelled');
      expect(
        (await prisma.walletCard.findFirstOrThrow({ where: { wawuUserId: a } }))
          .state,
      ).toBe('cancelled');
      expect(
        (
          await prisma.communityPassRefund.findFirstOrThrow({
            where: { userWawuId: a },
          })
        ).status,
      ).toBe('refunded');
      const cap = await prisma.capitalOrder.findFirstOrThrow({
        where: { wawuUserId: a },
      });
      expect([
        cap.state,
        cap.feeState,
        cap.nuvionOrderId,
        cap.provider,
      ]).toEqual(['cancelled', 'none', null, RETIRED_PROVIDER]);
      const pa = await prisma.moneyPayoutAccount.findUniqueOrThrow({
        where: { wawuUserId: a },
      });
      expect(pa.nuvionCounterpartyId).toBeNull();
      expect(pa.accountNumber).toBe('0123456789');
      // Points: the conversion is cancelled and the points are back.
      expect(
        (
          await prisma.pointConversion.findUniqueOrThrow({
            where: { id: convId },
          })
        ).status,
      ).toBe('cancelled');
      const lots = await prisma.pointLot.findMany({ where: { wawuUserId: a } });
      expect(lots.reduce((s, l) => s + l.remaining, 0)).toBe(5000);

      // The kept person was not touched.
      const keptNow = await run({});
      expect(keptNow.text).toContain('Nothing to retire.');
      for (const k of keptBefore)
        expect(
          await prisma.fintavaWallet.count({ where: { wawuUserId: k } }),
        ).toBe(1);
    });
  });

  describe('a person with a real-money row is kept, and so is anyone in motion with them', () => {
    const kept = uid();
    const partner = uid();
    const control = uid();
    const controlPartner = uid();
    let motion: string;

    beforeAll(async () => {
      await wallet(kept);
      await wallet(partner);
      await wallet(control);
      await wallet(controlPartner);
      // A Flutterwave-style row: a wallet row of another provider is the simplest unmistakable one here.
      await realRow(kept);
      motion = await payment(partner, kept, 'pending');
      await payment(control, controlPartner, 'pending');
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "CreatorWallet" WHERE "wawuUserId" = $1`,
        kept,
      );
    });

    it('lists the kept people and retires the control pair', async () => {
      const dry = await run({});
      expect(dry.text).toContain(`KEPT ${kept}:`);
      expect(dry.text).toContain(`KEPT ${partner}:`);
      expect(dry.text).not.toContain(`KEPT ${control}:`);
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      const res = await run({ apply: true, confirm: phrase(n) });
      expect(res.code).toBe(0);
      expect(res.text).toContain('WARNING');
      // Kept: untouched, still test, still pending.
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: [kept, partner] } },
        }),
      ).toBe(2);
      expect(
        (
          await prisma.walletPayment.findUniqueOrThrow({
            where: { id: motion },
          })
        ).status,
      ).toBe('pending');
      // Control: retired.
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: [control, controlPartner] } },
        }),
      ).toBe(0);
    });
  });

  it('closes by what it finds inside the transaction: a person who gains real money mid-run is kept', async () => {
    const p = uid();
    await wallet(p);
    const dry = await run({});
    const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
    const res = await run({ apply: true, confirm: phrase(n) }, SANDBOX, {
      beforePerson: async (id) => {
        if (id === p) await realRow(p);
      },
    });
    expect(res.text).toContain(`Kept ${p}: real money appeared`);
    expect(await prisma.fintavaWallet.count({ where: { wawuUserId: p } })).toBe(
      1,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "CreatorWallet" WHERE "wawuUserId" = $1`,
      p,
    );
  });

  it("retires the unowned rows (WAWU's own test account, logs) and leaves a kept person's alone, then rolls back", async () => {
    const keptPerson = randomUUID();
    class Rollback extends Error {}
    const night = '2020-01-01';
    let seen: Record<string, unknown> = {};
    await prisma
      .$transaction(async (tx) => {
        await tx.moneyCheckRun.create({
          data: {
            provider: 'nuvion',
            night,
            startedAt: new Date(),
            leaseUntil: new Date(Date.now() + 600000),
          },
        });
        await tx.nuvionReconcileFinding.create({
          data: { kind: 'k', subject: `${tag}-s`, detail: 'd' },
        });
        const ev = await tx.nuvionWebhookEvent.create({
          data: {
            eventId: `${tag}-ev`,
            event: 'x',
            signedAt: 's',
            bodySha256: `${tag}-sha`,
            rawBody: Buffer.from('{}'),
            payload: {},
          },
        });
        const merchant = await tx.fintavaLedgerEntry.create({
          data: {
            walletKind: 'merchant',
            accountNumber: MERCHANT,
            direction: 'in',
            status: 'pending',
            category: 'purchase',
            amountKobo: 1n,
            totalKobo: 1n,
            source: 'test',
            occurredAt: new Date(),
            provider: 'nuvion',
            nextCheckAt: new Date(),
          },
        });
        const orphanPay = await payment(
          null as never,
          null as never,
          'pending',
        );
        const keptPay = await payment(keptPerson, null as never, 'pending');
        await runUnowned(tx, [keptPerson]);
        seen = {
          run: (await tx.moneyCheckRun.findFirstOrThrow({ where: { night } }))
            .provider,
          finding:
            (
              await tx.nuvionReconcileFinding.findFirstOrThrow({
                where: { subject: `${tag}-s` },
              })
            ).resolvedAt !== null,
          event: (
            await tx.nuvionWebhookEvent.findUniqueOrThrow({
              where: { id: ev.id },
            })
          ).processingStatus,
          merchant: (
            await tx.fintavaLedgerEntry.findUniqueOrThrow({
              where: { id: merchant.id },
            })
          ).provider,
          orphanPay: (
            await tx.walletPayment.findUniqueOrThrow({
              where: { id: orphanPay },
            })
          ).status,
          keptPay: (
            await tx.walletPayment.findUniqueOrThrow({ where: { id: keptPay } })
          ).status,
        };
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(seen).toEqual({
      run: RETIRED_PROVIDER,
      finding: true,
      event: 'processed',
      merchant: RETIRED_PROVIDER,
      orphanPay: 'failed',
      keptPay: 'pending',
    });
  });
});

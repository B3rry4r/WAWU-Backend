import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  PAY_PIN,
  type PayHarness,
  type PayPerson,
  STAND_IN_FEE_KOBO,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { TipWalletModule } from '../tip-wallet.module';
import type {
  TipWalletQuoteView,
  TipWalletView,
} from '../tip-wallet-view.type';

/**
 * HOME-14 on the wallet provider seam with NUVION stood in: a tip paid from
 * the wallet with the PIN, the creator's 85% landing in their wallet by
 * itself (R-11), and the attacks a money path has to survive. After each, the
 * ledger agrees with the stand-in. No Nuvion, Fintava or wawuafrica.com host
 * is called.
 */

jest.setTimeout(180_000);

const TIP = 200_000; // ₦2,000
const SHARE = 170_000; // 85% (R-5)
const FEE = STAND_IN_FEE_KOBO;

describe('Tip a creator from the wallet (HOME-14), Nuvion stood in', () => {
  let h: PayHarness;
  const creators: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('h14', {
      modules: [TipWalletModule],
      cleanup: async (prisma, users) => {
        await prisma.notification.deleteMany({
          where: { userWawuId: { in: users } },
        });
        await prisma.purchase.deleteMany({
          where: {
            OR: [
              { buyerWawuId: { in: users } },
              { creatorWawuId: { in: users } },
            ],
          },
        });
        await prisma.userProfile.deleteMany({
          where: { wawuUserId: { in: creators } },
        });
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  /** A creator with a profile (and a wallet holding `kobo`). */
  async function creator(kobo = 0): Promise<PayPerson> {
    const c = await h.person(kobo);
    await h.prisma.userProfile.create({
      data: {
        wawuUserId: c.id,
        accountType: 'creator',
        handle: `c${c.id.slice(0, 8)}`,
      },
    });
    creators.push(c.id);
    return c;
  }

  async function quoted(
    p: PayPerson,
    c: PayPerson,
    amountKobo = TIP,
  ): Promise<TipWalletQuoteView> {
    const res = await h.get(
      p,
      `/tips/wallet/quote?creatorWawuId=${c.id}&amountKobo=${amountKobo}`,
    );
    expect(res.status).toBe(200);
    return body<TipWalletQuoteView>(res).data!;
  }
  const request = (
    c: PayPerson,
    q: TipWalletQuoteView,
    extra: Record<string, unknown> = {},
  ) => ({
    creatorWawuId: c.id,
    amountKobo: q.amountKobo,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
    ...extra,
  });
  const purchases = (c: PayPerson) =>
    h.prisma.purchase.findMany({ where: { creatorWawuId: c.id } });
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;

  it('H26 to H28: ₦2,000 costs ₦2,000 plus the charge once; the creator gets 85% and WAWU keeps 15%', async () => {
    const payer = await h.person(5_000_000);
    const c = await creator();
    const q = await quoted(payer, c);
    expect(q.payment).toMatchObject({
      kind: 'tip',
      priceKobo: TIP,
      totalKobo: TIP + FEE,
      fee: { providerFeeKobo: FEE, wawuFeeKobo: 0 },
      willBeHeld: false,
    });
    expect(q.creator.wawuUserId).toBe(c.id);

    const operationalBefore = h.nuvion.operational.availableKobo;
    const res = await h.post(
      payer,
      '/tips/wallet',
      request(c, q, { note: 'For the shoot' }),
    );
    expect(res.status).toBe(201);
    const tip = body<TipWalletView>(res).data!;
    expect(tip).toMatchObject({
      status: 'paid',
      amountKobo: TIP,
      note: 'For the shoot',
      payment: { kind: 'tip', status: 'completed', delivered: true },
    });
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(h.sendsFrom(payer)[0]).toMatchObject({
      amountKobo: BigInt(TIP),
      feeKobo: BigInt(FEE),
      toAccountId: h.nuvion.operational.accountId,
    });
    expect(balance(payer)).toBe(5_000_000n - BigInt(TIP + FEE));

    // The web's own tip row, so the creator's earnings and the admin streams read it.
    const rows = await purchases(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'tip',
      amount: 2000,
      status: 'completed',
      buyerWawuId: payer.id,
      note: 'For the shoot',
      flutterwaveTxRef: `wallet:${tip.id}`,
    });
    expect(Number(rows[0].commissionRate)).toBe(0.15);

    // The creator's 85% lands by itself.
    await until(async () => {
      await h.pass();
      return balance(c) === BigInt(SHARE);
    }, "the creator's 85% to land");
    expect(balance(c)).toBe(BigInt(SHARE));
    // WAWU keeps 15%, and pays the provider's charge on the move out of that.
    expect(h.nuvion.operational.availableKobo - operationalBefore).toBe(
      BigInt(TIP - SHARE - FEE),
    );
    await h.expectLedgerEqualsStandIn([payer, c]);
    expect(h.fintavaHits).toEqual([]);
  });

  it('the same request twice debits once and answers the first result again', async () => {
    const payer = await h.person(5_000_000);
    const c = await creator();
    const q = await quoted(payer, c);
    const key = randomUUID();
    const first = await h.post(payer, '/tips/wallet', request(c, q), { key });
    expect(first.status).toBe(201);
    const second = await h.post(payer, '/tips/wallet', request(c, q), {
      key,
      pin: '0000',
    });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(await purchases(c)).toHaveLength(1);
    expect(balance(payer)).toBe(5_000_000n - BigInt(TIP + FEE));
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('twice in parallel, with one key or two, takes the money once', async () => {
    const payer = await h.person(5_000_000);
    const c = await creator();
    const q = await quoted(payer, c);

    // One key, sent twice at once.
    const key = randomUUID();
    const both = await Promise.all([
      h.post(payer, '/tips/wallet', request(c, q), { key }),
      h.post(payer, '/tips/wallet', request(c, q), { key }),
    ]);
    const statuses = both.map((r) => r.status).sort();
    expect(statuses[0]).toBeLessThan(500);
    expect(both.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(await purchases(c)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([payer]);

    // Two keys at once while the provider has not finished the first: the
    // second is refused as a payment already in progress.
    const payer2 = await h.person(5_000_000);
    const q2 = await quoted(payer2, c);
    h.nuvion.mode = 'pending';
    const two = await Promise.all([
      h.post(payer2, '/tips/wallet', request(c, q2)),
      h.post(payer2, '/tips/wallet', request(c, q2)),
    ]);
    expect(h.sendsFrom(payer2)).toHaveLength(1);
    const codes = two.map(
      (r) => (r.body as { reason?: { code?: string } }).reason?.code,
    );
    expect(two.filter((r) => r.status === 201)).toHaveLength(1);
    expect(codes.filter((c2) => c2 === 'payment_in_progress')).toHaveLength(1);
    h.nuvion.settle(
      h.sendsFrom(payer2)[0].request.unique_reference,
      'successful',
    );
    await until(async () => {
      await h.pass();
      return (await purchases(c)).length === 2;
    }, 'the second payer tip to be recorded');
    await h.expectLedgerEqualsStandIn([payer, payer2]);
  });

  it('a wrong PIN moves nothing and records nothing', async () => {
    const payer = await h.person(5_000_000);
    const c = await creator();
    const q = await quoted(payer, c);
    const res = await h.post(payer, '/tips/wallet', request(c, q), {
      pin: '1111',
    });
    expect(res.status).toBe(403);
    expect((res.body as { reason?: { code?: string } }).reason?.code).toBe(
      'pin_incorrect',
    );
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect(await purchases(c)).toHaveLength(0);
    expect(balance(payer)).toBe(5_000_000n);
    // The right PIN afterwards still works, once.
    const ok = await h.post(payer, '/tips/wallet', request(c, q), {
      pin: PAY_PIN,
    });
    expect(ok.status).toBe(201);
    expect(h.sendsFrom(payer)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a short balance is refused with the shortfall and moves nothing', async () => {
    const payer = await h.person(150_000);
    const c = await creator();
    const q = await quoted(payer, c);
    expect(q.payment.shortfallKobo).toBe(TIP + FEE - 150_000);
    const res = await h.post(payer, '/tips/wallet', request(c, q));
    expect(res.status).toBe(402);
    expect((res.body as { reason?: { code?: string } }).reason?.code).toBe(
      'insufficient_funds',
    );
    expect(h.sendsFrom(payer)).toHaveLength(0);
    expect(await purchases(c)).toHaveLength(0);
    expect(balance(payer)).toBe(150_000n);
    await h.expectLedgerEqualsStandIn([payer]);
  });

  it('a lost provider answer, then a retry, takes the money once', async () => {
    const payer = await h.person(5_000_000);
    const c = await creator();
    const q = await quoted(payer, c);
    const key = randomUUID();
    // Nuvion takes the transfer and the answer never arrives.
    h.nuvion.mode = 'timeout';
    const first = await h.post(payer, '/tips/wallet', request(c, q), { key });
    expect(first.status).toBe(201);
    expect(body<TipWalletView>(first).data!.status).toBe('pending');
    expect(await purchases(c)).toHaveLength(0);

    // The app retries with the same key: the first answer, nothing sent again.
    h.nuvion.mode = 'successful';
    const retry = await h.post(payer, '/tips/wallet', request(c, q), {
      key,
      pin: '0000',
    });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(h.sendsFrom(payer)).toHaveLength(1);

    // The provider's record settles it; the sweep delivers once.
    h.nuvion.settle(
      h.sendsFrom(payer)[0].request.unique_reference,
      'successful',
    );
    await until(async () => {
      await h.pass();
      return (await purchases(c)).length === 1;
    }, 'the tip to be recorded');
    await h.pass();
    expect(h.sendsFrom(payer)).toHaveLength(1);
    expect(await purchases(c)).toHaveLength(1);
    const paid = body<TipWalletView>(
      await h.get(payer, `/tips/wallet/${body<TipWalletView>(first).data!.id}`),
    ).data!;
    expect(paid.status).toBe('paid');
    expect(balance(payer)).toBe(5_000_000n - BigInt(TIP + FEE));
    await h.expectLedgerEqualsStandIn([payer, c]);
  });

  it('a tip that cannot be delivered is paid back whole: the price and the charge return, and no earning is made', async () => {
    const payer = await h.person(5_000_000);
    const c = await creator();
    const q = await quoted(payer, c);
    h.nuvion.mode = 'pending';
    const res = await h.post(payer, '/tips/wallet', request(c, q));
    const pending = body<TipWalletView>(res).data!;
    expect(pending.status).toBe('pending');
    // The creator's account goes away before the debit is confirmed.
    await h.prisma.userProfile.delete({ where: { wawuUserId: c.id } });
    h.nuvion.settle(
      h.sendsFrom(payer)[0].request.unique_reference,
      'successful',
    );
    h.nuvion.mode = 'successful';
    await until(async () => {
      await h.pass();
      const hold = await h.prisma.walletHold.findUnique({
        where: { paymentId: pending.id },
      });
      return hold?.status === 'refunded';
    }, 'the tip to be paid back');
    await h.pass();

    expect(await purchases(c)).toHaveLength(0);
    expect(
      await h.prisma.earningSettlement.count({
        where: { paymentId: pending.id },
      }),
    ).toBe(0);
    // Every naira came back, the payment's charge included: the payer did
    // not cause it (lead ruling 17 Oct 2026). WAWU bears the refund's own charge.
    expect(balance(payer)).toBe(5_000_000n);
    expect(balance(c)).toBe(0n);
    const read = body<TipWalletView>(
      await h.get(payer, `/tips/wallet/${pending.id}`),
    ).data!;
    expect(read.status).toBe('refunded');
    await h.expectLedgerEqualsStandIn([payer, c]);
  });

  it('refuses a tip to oneself, a stranger, a blocked account and an amount that is not whole naira', async () => {
    const payer = await h.person(5_000_000);
    const stranger = await h.person(0);
    const self = await h.get(
      payer,
      `/tips/wallet/quote?creatorWawuId=${payer.id}&amountKobo=${TIP}`,
    );
    expect(self.status).toBe(409);
    const gone = await h.get(
      payer,
      `/tips/wallet/quote?creatorWawuId=${stranger.id}&amountKobo=${TIP}`,
    );
    expect(gone.status).toBe(404);
    const c = await creator();
    for (const bad of [0, 99, 150, TIP + 1, 1_000_000_100]) {
      const res = await h.get(
        payer,
        `/tips/wallet/quote?creatorWawuId=${c.id}&amountKobo=${bad}`,
      );
      expect([400, 422]).toContain(res.status);
    }
    await h.prisma.blockedAccount.create({
      data: { userWawuId: c.id, blockedWawuId: payer.id },
    });
    const blocked = await h.get(
      payer,
      `/tips/wallet/quote?creatorWawuId=${c.id}&amountKobo=${TIP}`,
    );
    expect(blocked.status).toBe(409);
    await h.prisma.blockedAccount.deleteMany({
      where: { userWawuId: c.id },
    });
  });
});

import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  bootCreditApp,
  type CreditHarness,
  creditApi,
} from '../../../../test/credits/credit-wallet-harness';
import { body } from '../../../../test/payments/poll-helpers';
import {
  liveFee,
  type Person,
} from '../../../../test/plans/tier-purchase-harness';
import { CreditPack } from '../../../../generated/prisma/enums';
import type { CreditsState } from '../../../common/types';
import type { TransactionPage } from '../../../money/money-view.type';
import { PayableRegistry } from '../../../money/payments/payable-registry';
import { CreditSpendService } from '../../../credit-spend/credit-spend.service';
import { PACK_TABLE } from '../../credit-packs';
import type {
  CreditPackListView,
  CreditWalletPurchaseView,
  CreditWalletQuoteView,
} from '../credit-wallet-view.type';

/**
 * INBOX-16 over HTTP: buy WAWU Credits from the wallet, on the real
 * MoneyModule and CreditWalletModule, a real database, real RS256 tokens and
 * the real Fintava client over a socket to the Fintava double
 * (docs/fintava/fees.md rates). No provider host is called.
 */

jest.setTimeout(120_000);

const reasonOf = (res: Response) => body<unknown>(res).reason!;
const RICH = 50_000_000;
/** The pack the capability checks name: 120 credits for ₦1,000. */
const POPULAR = {
  pack: 'popular',
  credits: 120,
  priceKobo: 100_000,
  badge: 'popular',
};

describe('Buy WAWU Credits from the wallet (INBOX-16)', () => {
  let h: CreditHarness;
  let call: ReturnType<typeof creditApi>;

  beforeAll(async () => {
    h = await bootCreditApp('i16');
    call = creditApi(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
  });

  async function quoted(
    p: Person,
    pack: string,
  ): Promise<CreditWalletQuoteView> {
    const res = await call.quote(p, pack);
    expect(res.status).toBe(200);
    return body<CreditWalletQuoteView>(res).data!;
  }
  const bodyFor = (
    pack: string,
    q: CreditWalletQuoteView,
    over: object = {},
  ) => ({
    pack,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
    ...over,
  });
  /** Quote, then pay with the PIN: what the app does. */
  async function purchase(
    p: Person,
    pack: string,
    opts: { key?: string; pin?: string | null } = {},
  ) {
    const q = await quoted(p, pack);
    const res = await call.buy(p, bodyFor(pack, q), opts);
    return { q, res, view: body<CreditWalletPurchaseView>(res).data! };
  }
  const sendsFrom = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);
  const countOf = async (p: Person) =>
    body<CreditsState>(await call.credits(p)).data!.creditBalance;
  const purchasesOf = (p: Person) =>
    h.prisma.creditPurchase.findMany({ where: { userWawuId: p.id } });
  const lotsOf = (p: Person) =>
    h.prisma.creditLot.findMany({ where: { userWawuId: p.id } });

  // ---------------------------------------------------------------------------
  // The packs
  // ---------------------------------------------------------------------------

  it('serves the packs from the server table, cheapest first, to a person with no wallet; credits are a count', async () => {
    const p = await h.walletless();
    const res = await call.packs(p);
    expect(res.status).toBe(200);
    const { packs } = body<CreditPackListView>(res).data!;
    expect(packs).toEqual([
      { pack: 'starter', credits: 50, priceKobo: 50_000, badge: null },
      { pack: 'popular', credits: 120, priceKobo: 100_000, badge: 'popular' },
      { pack: 'pro', credits: 300, priceKobo: 200_000, badge: 'best_value' },
    ]);
    // Every pack of the enum is on sale, and nothing else.
    expect(packs.map((x) => x.pack).sort()).toEqual(
      Object.values(CreditPack).sort(),
    );
    for (const x of packs)
      expect(x.priceKobo).toBe(PACK_TABLE[x.pack].amount * 100);
  });

  // ---------------------------------------------------------------------------
  // Check 1: 120 credits for ₦1,000 take ₦1,023.25 once and give 120 credits
  // ---------------------------------------------------------------------------

  it('check 1: the quote shows ₦1,000 + ₦23.25 = ₦1,023.25, the PIN buys 120 credits with one debit of ₦1,023.25, and the credits show as a count', async () => {
    const p = await h.buyer(RICH);
    const before = h.wallets.kobo.get(p.accountNumber)!;
    expect(await countOf(p)).toBe(0);

    const q = await quoted(p, 'popular');
    expect(q).toMatchObject(POPULAR);
    expect(q.payment).toMatchObject({
      kind: 'credit_pack',
      targetId: 'popular',
      title: '120 WAWU Credits',
      payee: null,
      priceKobo: 100_000,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 0, totalFeeKobo: 2325 },
      totalKobo: 102_325,
      balanceKobo: before,
      shortfallKobo: 0,
      willBeHeld: false,
    });

    const res = await call.buy(p, bodyFor('popular', q));
    expect(res.status).toBe(201);
    const view = body<CreditWalletPurchaseView>(res).data!;
    expect(view).toMatchObject({
      ...POPULAR,
      method: 'wallet',
      status: 'paid',
      statusMessage: null,
      creditBalance: 120,
    });
    expect(view.paidAt).not.toBeNull();
    expect(view.payment).toMatchObject({
      kind: 'credit_pack',
      status: 'completed',
      delivered: true,
      priceKobo: 100_000,
      totalKobo: 102_325,
    });

    // One debit: the pack's price, with the provider's charge (R-10) on top.
    expect(sendsFrom(p)).toHaveLength(1);
    expect(sendsFrom(p)[0]).toMatchObject({
      amountKobo: 100_000,
      feeKobo: liveFee(100_000),
    });
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(before - 102_325);
    // The price went to WAWU's own account, and none of it is owed to a payee.
    expect(h.wallets.kobo.get(sendsFrom(p)[0].to)).toBeGreaterThanOrEqual(
      100_000,
    );
    const payment = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(payment).toMatchObject({
      kind: 'credit_pack',
      targetId: 'popular',
      payeeWawuUserId: null,
      payeeShareKobo: 0n,
      wawuShareKobo: 100_000n,
    });
    expect(payment.fulfilledAt).not.toBeNull();

    // GET /credits: 120, a count.
    expect(await countOf(p)).toBe(120);
    const state = body<CreditsState>(await call.credits(p)).data!;
    expect(JSON.stringify(state)).not.toMatch(/kobo|naira|₦/i);

    // One purchase row and one cost-basis lot, both tied to this payment.
    const rows = await purchasesOf(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pack: 'popular',
      creditsGranted: 120,
      amount: 1000,
      status: 'completed',
      walletPaymentId: view.id,
      flutterwaveTxRef: `wallet:${view.id}`,
    });
    const lots = await lotsOf(p);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      creditPurchaseId: rows[0].id,
      creditsGranted: 120,
      creditsRemaining: 120,
      grossKobo: 100_000,
      allocatedKobo: 0,
    });
  });

  it('check 1: the credits add to what the person already has (48 + 120 = 168), they do not replace it', async () => {
    const p = await h.buyer(RICH);
    await h.prisma.creditsState.create({
      data: { userWawuId: p.id, creditBalance: 48 },
    });
    const { view } = await purchase(p, 'popular');
    expect(view).toMatchObject({ status: 'paid', creditBalance: 168 });
    expect(await countOf(p)).toBe(168);
  });

  it('check 1: every pack gives its own count for its own price, and two purchases of one pack in a row are two purchases', async () => {
    const p = await h.buyer(RICH);
    const a = await purchase(p, 'starter');
    const b = await purchase(p, 'pro');
    const c = await purchase(p, 'starter');
    expect(a.q.payment.totalKobo).toBe(50_000 + liveFee(50_000));
    expect(b.q.payment.totalKobo).toBe(200_000 + liveFee(200_000));
    for (const x of [a, b, c]) expect(x.view.status).toBe('paid');
    expect(await countOf(p)).toBe(50 + 300 + 50);
    expect(sendsFrom(p).map((s) => s.amountKobo)).toEqual([
      50_000, 200_000, 50_000,
    ]);
    expect(await purchasesOf(p)).toHaveLength(3);
    expect(await lotsOf(p)).toHaveLength(3);
  });

  it('check 1: the purchase is in the wallet history as "Credits", and the ledger row is the transfer Fintava took', async () => {
    const p = await h.buyer(RICH);
    const { view } = await purchase(p, 'popular');
    const history = body<TransactionPage>(await call.history(p)).data!;
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      category: 'purchase',
      amountKobo: 100_000,
      totalKobo: 102_325,
      link: { kind: 'credit_pack', targetId: 'popular' },
    });
    // The ledger and Fintava agree (MONEY-16): the buyer's row is out, settled,
    // for the same amount and the same charge as the transfer the double took,
    // and WAWU's own account has the matching row in.
    const send = sendsFrom(p)[0];
    const ledger = await h.prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: view.payment.reference },
    });
    expect(ledger).toHaveLength(2);
    const mine = ledger.find((l) => l.accountNumber === p.accountNumber)!;
    const wawus = ledger.find((l) => l.accountNumber === send.to)!;
    expect(mine).toMatchObject({
      direction: 'out',
      status: 'completed',
      category: 'purchase',
      wawuUserId: p.id,
      linkKind: 'credit_pack',
      linkTargetId: 'popular',
      linkTitle: '120 WAWU Credits',
    });
    expect(Number(mine.amountKobo)).toBe(send.amountKobo);
    expect(Number(mine.feeKobo)).toBe(send.feeKobo);
    expect(Number(mine.totalKobo)).toBe(send.amountKobo + send.feeKobo);
    expect(wawus).toMatchObject({
      direction: 'in',
      status: 'completed',
      walletKind: 'merchant',
    });
    expect(Number(wawus.amountKobo)).toBe(send.amountKobo);
    expect(send.reference).toBe(view.payment.reference);
  });

  it('the lot a wallet purchase opens is spent like any other: the host gets 85% of what the credits cost and WAWU 15% (R-5), the lot is drawn down, and the count falls', async () => {
    const p = await h.buyer(RICH);
    const host = await h.buyer(0);
    await purchase(p, 'popular');
    const community = await h.prisma.community.create({
      data: {
        name: 'Credit spend check',
        description: 'INBOX-16',
        hostWawuId: host.id,
        kind: 'open',
      },
    });
    const spend = await h.app.get(CreditSpendService).record({
      userWawuId: p.id,
      communityId: community.id,
      creatorWawuId: host.id,
      creditsSpent: 120,
    });
    const earning = await h.prisma.creditSpendEarning.findUniqueOrThrow({
      where: { creditSpendId: spend.id },
    });
    expect(earning).toMatchObject({
      creditsSpent: 120,
      creditsFunded: 120,
      grossKobo: 100_000,
      hostShareKobo: 85_000,
      platformShareKobo: 15_000,
    });
    expect((await lotsOf(p))[0]).toMatchObject({
      creditsRemaining: 0,
      allocatedKobo: 100_000,
    });
  });

  // ---------------------------------------------------------------------------
  // Check 2: the same request twice charges once (V8)
  // ---------------------------------------------------------------------------

  it('check 2: the same request twice debits once and credits once; the second answer is the first, replayed, and no PIN is used', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'popular');
    const key = randomUUID();
    const first = await call.buy(p, bodyFor('popular', q), { key });
    expect(first.status).toBe(201);
    const second = await call.buy(p, bodyFor('popular', q), {
      key,
      pin: '0000',
    });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await countOf(p)).toBe(120);
    expect(await purchasesOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
    // The wrong PIN on a replay costs no try.
    const pin = await h.prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(pin.failedTries).toBe(0);
    // The same key with another body is not a replay.
    const reused = await call.buy(p, bodyFor('popular', q, { pack: 'pro' }), {
      key,
    });
    expect(reused.status).toBe(409);
    expect(reasonOf(reused).code).toBe('idempotency_key_reused');
    expect(await countOf(p)).toBe(120);
  });

  it('check 2: four taps at once with one key debit once and credit once', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'popular');
    const key = randomUUID();
    const taps = await Promise.all(
      [1, 2, 3, 4].map(() => call.buy(p, bodyFor('popular', q), { key })),
    );
    const ok = taps.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of taps.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(reasonOf(r).code).toBe('idempotency_in_progress');
    }
    expect(
      new Set(ok.map((r) => body<CreditWalletPurchaseView>(r).data!.id)).size,
    ).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await countOf(p)).toBe(120);
    expect(await purchasesOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
  });

  it('check 2: three taps at once under different keys take one payment; the others are told it is going through', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'popular');
    const taps = await Promise.all(
      [1, 2, 3].map(() =>
        call.buy(p, bodyFor('popular', q), { key: randomUUID() }),
      ),
    );
    expect(taps.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of taps.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(reasonOf(r).code).toBe('payment_in_progress');
    }
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await countOf(p)).toBe(120);
    expect(await lotsOf(p)).toHaveLength(1);
  });

  it('check 2: a confirmation delivered twice, or five at once, credits once', async () => {
    const p = await h.buyer(RICH);
    const { view } = await purchase(p, 'popular');
    expect(view.status).toBe('paid');
    const row = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.id },
    });
    const registry = h.app.get(PayableRegistry);
    const handler = registry.get('credit_pack')!;
    const payment = {
      paymentId: row.id,
      payerWawuUserId: p.id,
      kind: 'credit_pack' as const,
      targetId: 'popular',
      priceKobo: 100_000,
      payeeWawuUserId: null,
      note: null,
      holdId: null,
    };
    await Promise.all([1, 2, 3, 4, 5].map(() => handler.onCompleted!(payment)));
    expect(await countOf(p)).toBe(120);
    expect(await purchasesOf(p)).toHaveLength(1);
    expect(await lotsOf(p)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Refusals: nothing is taken and nothing is credited
  // ---------------------------------------------------------------------------

  it('refuses a person without enough money (402 with the shortfall), takes nothing and credits nothing', async () => {
    const p = await h.buyer(100_000);
    const q = await quoted(p, 'popular');
    expect(q.payment).toMatchObject({
      balanceKobo: 100_000,
      shortfallKobo: 2325,
    });
    const res = await call.buy(p, bodyFor('popular', q));
    expect(res.status).toBe(402);
    expect(reasonOf(res).code).toBe('insufficient_funds');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(100_000);
    expect(await countOf(p)).toBe(0);
    expect(await purchasesOf(p)).toHaveLength(0);
  });

  it('a person without a wallet gets wallet_not_open on the quote and the purchase, and no key is kept; the packs still open', async () => {
    const p = await h.walletless();
    const quote = await call.quote(p, 'popular');
    expect(quote.status).toBe(409);
    expect(reasonOf(quote).code).toBe('wallet_not_open');
    const key = randomUUID();
    const res = await call.buy(
      p,
      { pack: 'popular', expectedTotalKobo: 100, quoteToken: 'x' },
      { key, pin: null },
    );
    expect(res.status).toBe(409);
    expect(reasonOf(res).code).toBe('wallet_not_open');
    expect(
      await h.prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect((await call.packs(p)).status).toBe(200);
  });

  it("a wrong PIN, a missing PIN, key or quote, a stale total and another pack's quote are refused before anything is taken", async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'popular');
    const wrongPin = await call.buy(p, bodyFor('popular', q), { pin: '1111' });
    expect(wrongPin.status).toBe(403);
    expect(reasonOf(wrongPin)).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });
    const noPin = await call.buy(p, bodyFor('popular', q), { pin: null });
    expect(noPin.status).toBe(403);
    expect(reasonOf(noPin).code).toBe('pin_required');
    const noKey = await call.buy(p, bodyFor('popular', q), { key: '' });
    expect(noKey.status).toBe(400);
    expect(reasonOf(noKey).code).toBe('idempotency_key_required');
    const stale = await call.buy(
      p,
      bodyFor('popular', q, { expectedTotalKobo: q.payment.totalKobo + 1 }),
    );
    expect(stale.status).toBe(409);
    expect(reasonOf(stale).code).toBe('quote_changed');
    const wrongToken = await call.buy(
      p,
      bodyFor('popular', q, { quoteToken: 'abc.def' }),
    );
    expect(wrongToken.status).toBe(409);
    expect(reasonOf(wrongToken).code).toBe('quote_changed');
    // A quote for another pack is not this pack's.
    const other = await quoted(p, 'pro');
    const swapped = await call.buy(p, bodyFor('popular', other));
    expect(swapped.status).toBe(409);
    expect(reasonOf(swapped).code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await countOf(p)).toBe(0);
    expect(
      await h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  it('a pack that does not exist is refused on the quote and the purchase, and the client never sets a price', async () => {
    const p = await h.buyer(RICH);
    const quote = await call.quote(p, 'mega');
    expect(quote.status).toBe(400);
    const q = await quoted(p, 'popular');
    const bad = await call.buy(p, bodyFor('mega', q));
    expect(bad.status).toBe(400);
    const priced = await call.buy(
      p,
      bodyFor('popular', q, { priceKobo: 1, credits: 9999 }),
    );
    expect(priced.status).toBe(400);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(await countOf(p)).toBe(0);
  });

  it('without a token every route is 401', async () => {
    const res = await call.packs({ auth: '' } as Person);
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Reading one purchase
  // ---------------------------------------------------------------------------

  it('the buyer reads their purchase by id; another person and an unknown id get the same 404', async () => {
    const p = await h.buyer(RICH);
    const other = await h.buyer(RICH);
    const { view } = await purchase(p, 'popular');
    const mine = await call.read(p, view.id);
    expect(mine.status).toBe(200);
    expect(body<CreditWalletPurchaseView>(mine).data).toMatchObject({
      id: view.id,
      status: 'paid',
      credits: 120,
      creditBalance: 120,
    });
    const theirs = await call.read(other, view.id);
    const nobody = await call.read(p, randomUUID());
    expect(theirs.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(theirs.body).toEqual(nobody.body);
    expect(reasonOf(theirs).code).toBe('not_found');
  });
});

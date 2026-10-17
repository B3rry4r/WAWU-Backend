import { randomUUID } from 'node:crypto';
import {
  bootCreditApp,
  type CreditHarness,
  creditApi,
} from '../../../../test/credits/credit-wallet-harness';
import { body } from '../../../../test/payments/poll-helpers';
import type { Person } from '../../../../test/plans/tier-purchase-harness';
import type { CreditsState } from '../../../common/types';
import {
  FINISHING_MESSAGE,
  PAYMENT_FAILED_REASON,
  STILL_CONFIRMING_MESSAGE,
} from '../../../money/payments/wallet-payment.service';
import type {
  CreditWalletPurchaseView,
  CreditWalletQuoteView,
} from '../credit-wallet-view.type';

/**
 * INBOX-16 where the payment does not finish in the request: the provider's
 * answer is lost (pending), the provider refuses, the credits cannot be
 * written once (the payment is paid and not yet delivered), and the daily
 * limit. In each, credits are added once or not at all, never twice and never
 * half. The Fintava double and a real database; no provider is called.
 */

jest.setTimeout(120_000);

const RICH = 50_000_000;
/** One popular pack in a day (₦1,000), and not a kobo more. */
const ONE_POPULAR_A_DAY = 100_000;
const INT4_MAX = 2_147_483_647;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason?: { code?: string } & Record<string, unknown> })
    .reason!;

describe('Buy WAWU Credits from the wallet: payments that do not finish in the request (INBOX-16)', () => {
  let h: CreditHarness;
  let call: ReturnType<typeof creditApi>;

  beforeAll(async () => {
    h = await bootCreditApp('i16s', {
      env: { WAWU_LIMIT_PURCHASE_DAILY_KOBO: String(ONE_POPULAR_A_DAY) },
    });
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
  const bodyFor = (pack: string, q: CreditWalletQuoteView) => ({
    pack,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const sendsFrom = (p: Person) =>
    h.wallets.sends.filter((s) => s.from === p.accountNumber);
  const countOf = async (p: Person) =>
    body<CreditsState>(await call.credits(p)).data!.creditBalance;
  const purchasesOf = (p: Person) =>
    h.prisma.creditPurchase.count({ where: { userWawuId: p.id } });
  const lotsOf = (p: Person) =>
    h.prisma.creditLot.count({ where: { userWawuId: p.id } });
  const readView = async (p: Person, id: string) =>
    body<CreditWalletPurchaseView>(await call.read(p, id)).data!;

  /** A starter pack (₦500), fits under the day's limit once. */
  async function lostAnswer(p: Person, pack = 'starter') {
    const q = await quoted(p, pack);
    h.wallets.mode = 'timeout';
    const res = await call.buy(p, bodyFor(pack, q));
    h.wallets.mode = 'live';
    return { q, res, view: body<CreditWalletPurchaseView>(res).data! };
  }

  it('a lost provider answer is pending and adds nothing; the sweep settles it and the credits land once, however often the sweep runs', async () => {
    const p = await h.buyer(RICH);
    const { res, view } = await lostAnswer(p);
    expect(res.status).toBe(201);
    expect(view).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      creditBalance: null,
      paidAt: null,
    });
    expect(await countOf(p)).toBe(0);
    expect(await purchasesOf(p)).toBe(0);
    expect(await lotsOf(p)).toBe(0);
    expect(await readView(p, view.id)).toMatchObject({ status: 'pending' });

    await h.sweepLater();
    expect(await readView(p, view.id)).toMatchObject({
      status: 'paid',
      credits: 50,
      creditBalance: 50,
      statusMessage: null,
    });
    await h.sweepLater();
    await h.sweepLater(70 * 60_000);
    expect(await countOf(p)).toBe(50);
    expect(await purchasesOf(p)).toBe(1);
    expect(await lotsOf(p)).toBe(1);
    // The one debit is the one Fintava took before the answer was lost.
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('the same key sent again while pending answers the first answer and sends nothing new', async () => {
    const p = await h.buyer(RICH);
    const q = await quoted(p, 'starter');
    h.wallets.mode = 'timeout';
    const key = randomUUID();
    const first = await call.buy(p, bodyFor('starter', q), { key });
    h.wallets.mode = 'live';
    expect(body<CreditWalletPurchaseView>(first).data!.status).toBe('pending');
    const again = await call.buy(p, bodyFor('starter', q), { key });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    // A new key for the same pack while the first is open is not a second debit.
    const other = await call.buy(p, bodyFor('starter', q), {
      key: randomUUID(),
    });
    expect(other.status).toBe(409);
    expect(reasonOf(other).code).toBe('payment_in_progress');
    await h.sweepLater();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await countOf(p)).toBe(50);
  });

  it('a payment the provider says failed adds no credits, says why, and the person can pay again', async () => {
    const p = await h.buyer(RICH);
    const { view } = await lostAnswer(p);
    h.wallets.failures.add(view.payment.reference);
    await h.sweepLater();
    const failed = await readView(p, view.id);
    expect(failed).toMatchObject({
      status: 'failed',
      statusMessage: PAYMENT_FAILED_REASON,
      creditBalance: null,
    });
    expect(await countOf(p)).toBe(0);
    expect(await purchasesOf(p)).toBe(0);
    expect(await lotsOf(p)).toBe(0);
    // Paying again is a new payment and works.
    const q = await quoted(p, 'starter');
    const res = await call.buy(p, bodyFor('starter', q));
    expect(res.status).toBe(201);
    expect(body<CreditWalletPurchaseView>(res).data!.status).toBe('paid');
    expect(await countOf(p)).toBe(50);
  });

  it('credits that cannot be written leave the payment paid and not delivered, nothing half-written; the sweep delivers them once when they can', async () => {
    const p = await h.buyer(RICH);
    // The balance is a 32-bit count: adding 50 to this one fails inside the
    // write, after the purchase row has gone in.
    await h.prisma.creditsState.create({
      data: { userWawuId: p.id, creditBalance: INT4_MAX - 10 },
    });
    const q = await quoted(p, 'starter');
    const res = await call.buy(p, bodyFor('starter', q));
    expect(res.status).toBe(201);
    const view = body<CreditWalletPurchaseView>(res).data!;
    expect(view).toMatchObject({
      status: 'pending',
      creditBalance: null,
      statusMessage: FINISHING_MESSAGE,
      payment: { status: 'completed', delivered: false },
    });
    // One debit, and nothing of the purchase written: the row, the lot and the
    // balance went together or not at all.
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await purchasesOf(p)).toBe(0);
    expect(await lotsOf(p)).toBe(0);
    expect(await countOf(p)).toBe(INT4_MAX - 10);

    await h.prisma.creditsState.update({
      where: { userWawuId: p.id },
      data: { creditBalance: 7 },
    });
    await h.sweepLater(70 * 60_000);
    await h.sweepLater(70 * 60_000);
    expect(await readView(p, view.id)).toMatchObject({
      status: 'paid',
      creditBalance: 57,
      payment: { delivered: true },
    });
    expect(await countOf(p)).toBe(57);
    expect(await purchasesOf(p)).toBe(1);
    expect(await lotsOf(p)).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('the daily purchase limit (WALLET-23) applies: the quote says so, the purchase is refused with nothing taken, and one pack within the limit is fine', async () => {
    const p = await h.buyer(RICH);
    const first = await quoted(p, 'popular');
    expect(first.payment).toMatchObject({
      withinDailyLimit: true,
      remainingTodayKobo: ONE_POPULAR_A_DAY,
    });
    const paid = await call.buy(p, bodyFor('popular', first));
    expect(paid.status).toBe(201);
    expect(await countOf(p)).toBe(120);

    const next = await quoted(p, 'starter');
    expect(next.payment.withinDailyLimit).toBe(false);
    const refused = await call.buy(p, bodyFor('starter', next));
    expect(refused.status).toBe(403);
    expect(reasonOf(refused)).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(await countOf(p)).toBe(120);
    expect(await purchasesOf(p)).toBe(1);
  });
});

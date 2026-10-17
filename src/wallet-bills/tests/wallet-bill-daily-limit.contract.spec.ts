import {
  api,
  type BillHarness,
  bootBillApp,
  type Person,
} from '../../../test/bills/wallet-bill-harness';
import { body } from '../../../test/payments/poll-helpers';
import type {
  WalletBillQuoteView,
  WalletBillView,
} from '../wallet-bill-view.type';

/**
 * FIX-40 through the whole bill flow: a bill that failed and was refunded does
 * not use up a one-bill daily limit; a bill that was delivered does. Fintava's
 * double and a real database; nothing reaches a provider.
 */

const AMOUNT = 1_000_000;
// The most one bill takes into WAWU's account: the amount and the biller's charge.
const ONE_BILL = AMOUNT + 10_000;
const START = 10_000_000;
const METER = '04123456789';
const IKEJA = 'Ikeja_Electric_Bill_Payment';
const code = (res: { body: unknown }) =>
  (res.body as { reason?: { code?: string } }).reason?.code ?? null;

jest.setTimeout(120_000);

describe('FIX-40: the daily bill limit and a refunded bill', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootBillApp('fix40', {
      WAWU_LIMIT_BILL_DAILY_KOBO: String(ONE_BILL),
    });
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const mk = async (p: Person) =>
    body<WalletBillQuoteView>(
      await r
        .create(p, {
          category: 'electricity',
          code: IKEJA,
          accountNumber: METER,
          amountKobo: AMOUNT,
        })
        .expect(201),
    ).data!;
  const pb = (q: WalletBillQuoteView) => ({
    billId: q.bill.id,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });

  it('a failed and refunded bill leaves the limit free; a delivered bill uses it up', async () => {
    const p = await h.buyer(START);
    // Bill 1: the biller refuses, the money goes back.
    h.book.mode = 'refuse';
    const failed = await mk(p);
    const paid = await r.pay(p, pb(failed)).expect(201);
    expect(body<WalletBillView>(paid).data!.status).toBe('failed');
    const hold = await h.prisma.walletHold.findFirstOrThrow({
      where: { targetId: failed.bill.id },
    });
    expect(hold.status).toBe('refunded');

    // Bill 2: the quote says it fits, and it is paid and delivered.
    h.book.mode = 'ok';
    const next = await mk(p);
    expect(next.payment.withinDailyLimit).toBe(true);
    const done = await r.pay(p, pb(next));
    expect(done.status).toBe(201);
    expect(body<WalletBillView>(done).data!.status).toBe('delivered');

    // Bill 3: bill 2 used the day up.
    const third = await mk(p);
    expect(third.payment.withinDailyLimit).toBe(false);
    const refused = await r.pay(p, pb(third));
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('limit_reached');
  });
});

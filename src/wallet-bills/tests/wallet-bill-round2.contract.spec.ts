import { randomUUID } from 'node:crypto';
import {
  api,
  type BillHarness,
  bootBillApp,
  type Person,
  purchaseRow,
  TOKEN,
} from '../../../test/bills/wallet-bill-harness';
import { body } from '../../../test/payments/poll-helpers';
import type {
  WalletBillQuoteView,
  WalletBillView,
} from '../wallet-bill-view.type';
import { WalletBillService } from '../wallet-bill.service';

/**
 * BILLS-04 round 2 (the verifier's findings, 16 Oct 2026): a Fintava history
 * record settles at most one bill; a failed bill's words; a success that
 * arrives after the refund; WAWU's bill fee on the books.
 */

const AMOUNT = 1_000_000;
const START = 5_000_000;
const METER = '04123456789';
const IKEJA = 'Ikeja_Electric_Bill_Payment';

const electricity = () => ({
  category: 'electricity',
  code: IKEJA,
  accountNumber: METER,
  amountKobo: AMOUNT,
});
const payBody = (q: WalletBillQuoteView) => ({
  billId: q.bill.id,
  expectedTotalKobo: q.payment.totalKobo,
  quoteToken: q.payment.quoteToken,
});

describe('BILLS-04 round 2: a history record settles one bill', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await bootBillApp('bills04r2');
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.book.mode = 'ok';
    h.book.purchases.length = 0;
    h.book.history.length = 0;
  });

  const make = async (p: Person) =>
    body<WalletBillQuoteView>(await r.create(p, electricity()).expect(201))
      .data!;
  const row = (id: string) =>
    h.prisma.walletBill.findUniqueOrThrow({ where: { id } });
  const holdOf = async (billId: string) =>
    h.prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: (await row(billId)).paymentId! },
    });

  /** Pays bill A and lets it deliver. */
  async function deliveredFirst(p: Person) {
    const a = await make(p);
    await r.pay(p, payBody(a)).expect(201);
    expect((await row(a.bill.id)).status).toBe('delivered');
    return row(a.bill.id);
  }

  it('the second bill, its purchase lost, never takes the first bill record; its own record settles it', async () => {
    const p = await h.buyer(START * 3);
    await deliveredFirst(p);
    // The first bill's record, 90 seconds old, as the merchant history lists it.
    h.book.history.push(
      purchaseRow({
        id: randomUUID(),
        amount: '10000.00',
        meternumber: METER,
        metertoken: TOKEN,
        createdAt: new Date(Date.now() - 90_000).toISOString(),
      }),
    );
    const b = await make(p);
    h.book.mode = 'gateway';
    const res = await r.pay(p, payBody(b)).expect(201);
    expect(body<WalletBillView>(res).data!.status).toBe('processing');
    await h.sweepLater(2 * 60_000);
    await h.sweepLater(10 * 60_000);
    const after = await row(b.bill.id);
    expect(after.status).toBe('buying');
    expect(after.token).toBeNull();
    expect((await holdOf(b.bill.id)).status).toBe('held');
    expect(h.book.purchases).toHaveLength(1);

    h.book.history.push(
      purchaseRow({
        id: randomUUID(),
        amount: '10000.00',
        meternumber: METER,
        metertoken: 'SECOND-TOKEN',
      }),
    );
    await h.sweepLater(30 * 60_000);
    expect(await row(b.bill.id)).toMatchObject({
      status: 'delivered',
      token: 'SECOND-TOKEN',
    });
    expect((await holdOf(b.bill.id)).status).toBe('released');
  });

  it('a record already stored on another bill (its id, or its reference) settles nothing', async () => {
    const p = await h.buyer(START * 3);
    const a = await deliveredFirst(p);
    const b = await make(p);
    h.book.mode = 'gateway';
    await r.pay(p, payBody(b)).expect(201);
    h.book.history.push(
      purchaseRow({
        id: a.fintavaTransactionId,
        reference: 'unrelated',
        amount: '10000.00',
        meternumber: METER,
      }),
    );
    await h.sweepLater(5 * 60_000);
    expect((await row(b.bill.id)).status).toBe('buying');
    h.book.history.length = 0;
    h.book.history.push(
      purchaseRow({
        id: randomUUID(),
        reference: a.fintavaReference,
        amount: '10000.00',
        meternumber: METER,
      }),
    );
    await h.sweepLater(10 * 60_000);
    expect((await row(b.bill.id)).status).toBe('buying');
    expect((await holdOf(b.bill.id)).status).toBe('held');
  });

  it('a record made before the previous bill was delivered is not this bill', async () => {
    const p = await h.buyer(START * 3);
    const a = await deliveredFirst(p);
    const b = await make(p);
    h.book.mode = 'gateway';
    await r.pay(p, payBody(b)).expect(201);
    // Inside the clock skew of this purchase, but before A was delivered.
    h.book.history.push(
      purchaseRow({
        id: randomUUID(),
        amount: '10000.00',
        meternumber: METER,
        createdAt: new Date(a.deliveredAt!.getTime() - 1_500).toISOString(),
      }),
    );
    await h.sweepLater(5 * 60_000);
    expect((await row(b.bill.id)).status).toBe('buying');
  });

  it('the database keeps one Fintava record on one bill', async () => {
    const p = await h.buyer(START * 3);
    const a = await deliveredFirst(p);
    const b = await make(p);
    await expect(
      h.prisma.walletBill.update({
        where: { id: b.bill.id },
        data: { fintavaTransactionId: a.fintavaTransactionId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      h.prisma.walletBill.update({
        where: { id: b.bill.id },
        data: { fintavaReference: a.fintavaReference },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('BILLS-04 round 2: after the biller fails, and after the refund', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await bootBillApp('bills04r2b');
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.book.mode = 'ok';
    h.book.purchases.length = 0;
    h.book.history.length = 0;
  });

  async function failedBill(p: Person, meter = METER) {
    const q = body<WalletBillQuoteView>(
      await r.create(p, { ...electricity(), accountNumber: meter }).expect(201),
    ).data!;
    h.book.mode = 'refuse';
    await r.pay(p, payBody(q)).expect(201);
    h.book.mode = 'ok';
    return q;
  }

  it('says the money was returned once the refund has completed', async () => {
    const p = await h.buyer(START);
    const q = await failedBill(p);
    const done = body<WalletBillView>(
      await r.read(p, q.bill.id).expect(200),
    ).data!;
    expect(done.status).toBe('failed');
    expect(done.returned?.returned).toBe(true);
    expect(done.failureReason).toMatch(/was returned to your wallet/i);
  });

  it('does not say a failed bill has already been paid when it is paid again', async () => {
    const p = await h.buyer(START);
    const q = await failedBill(p);
    const again = await r.pay(p, payBody(q)).expect(409);
    const text = JSON.stringify(again.body);
    expect(text).toContain('target_not_payable');
    expect(text).not.toMatch(/already been paid/i);
    expect(text).toMatch(/did not go through/i);
    expect(text).not.toContain('—');
  });

  it('a success that arrives after the refund is recorded for review, once, and the bill stays failed', async () => {
    const p = await h.buyer(START);
    const q = await failedBill(p, '04999000111');
    const bill = await h.prisma.walletBill.findUniqueOrThrow({
      where: { id: q.bill.id },
    });
    const before = h.wallets.kobo.get(p.accountNumber);
    h.book.history.push(
      purchaseRow({
        id: randomUUID(),
        amount: '10000.00',
        meternumber: '04999000111',
        metertoken: TOKEN,
      }),
    );
    const svc = h.app.get(WalletBillService);
    await svc.scanLateSuccesses(new Date(Date.now() + 5 * 60_000));
    await svc.scanLateSuccesses(new Date(Date.now() + 10 * 60_000));
    const pay = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: bill.paymentId! },
    });
    expect(pay.discrepancy).toMatch(/delivered after .*refunded/i);
    expect(
      h.logger.lines.filter(
        (l) => l.includes(`bill ${bill.id}`) && /after .*refund/i.test(l),
      ),
    ).toHaveLength(1);
    expect(
      (await h.prisma.walletBill.findUniqueOrThrow({ where: { id: bill.id } }))
        .status,
    ).toBe('failed');
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(before);
  });

  it('says the money is on its way back while the refund has not completed', async () => {
    const p = await h.buyer(START);
    const q = body<WalletBillQuoteView>(
      await r
        .create(p, { ...electricity(), accountNumber: '04888000222' })
        .expect(201),
    ).data!;
    // The biller refuses, and the refund transfer's answer is lost: the refund
    // is a move of its own and has not completed.
    h.double.on('POST', '/billing/electricity', () => {
      h.wallets.mode = 'timeout';
      return {
        status: 400,
        body: { statusCode: 400, message: 'Unable to find customers' },
      };
    });
    await r.pay(p, payBody(q)).expect(201);
    h.wallets.mode = 'live';
    const waiting = body<WalletBillView>(
      await r.read(p, q.bill.id).expect(200),
    ).data!;
    expect(waiting.status).toBe('failed');
    expect(waiting.returned?.returned).toBe(false);
    expect(waiting.failureReason).toMatch(/on its way back/i);
    expect(waiting.failureReason).not.toMatch(/was returned/i);
  });
});

describe('BILLS-04 round 2: WAWU bill fee on the books (R-10)', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;
  beforeAll(async () => {
    h = await bootBillApp('bills04r2c', {
      WAWU_FEE_BILL_KOBO: '5000',
      FINTAVA_FEE_ELECTRICITY_KOBO: '12000',
    });
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('records WAWU fee on the payment and on the buyer ledger row; the total is unchanged', async () => {
    const p = await h.buyer(START);
    const q = body<WalletBillQuoteView>(
      await r.create(p, electricity()).expect(201),
    ).data!;
    const res = await r.pay(p, payBody(q)).expect(201);
    const paymentId = body<WalletBillView>(res).data!.paymentId!;
    const pay = await h.prisma.walletPayment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(pay.wawuFeeKobo).toBe(5000n);
    expect(pay.totalKobo).toBe(BigInt(q.payment.totalKobo));
    const rows = await h.prisma.fintavaLedgerEntry.findMany({
      where: { paymentId },
    });
    const user = rows.find(
      (x) => x.walletKind === 'user' && x.direction === 'out',
    )!;
    expect(user.wawuFeeKobo).toBe(5000n);
    expect(user.totalKobo).toBe(BigInt(q.payment.totalKobo));
    // Fintava's charges stay Fintava's: the purchase row carries the bill charge only.
    const purchase = rows.find(
      (x) => x.walletKind === 'merchant' && x.category === 'bill',
    )!;
    expect(purchase.providerFeeKobo).toBe(12000n);
    expect(purchase.wawuFeeKobo).toBe(0n);
  });
});

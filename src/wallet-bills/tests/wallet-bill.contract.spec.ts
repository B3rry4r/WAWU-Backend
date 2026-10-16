import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MERCHANT_ACCOUNT } from '../../../test/fintava/fintava-double';
import {
  api,
  type BillHarness,
  bootBillApp,
  type Person,
  purchaseRow,
  TOKEN,
  UNITS,
} from '../../../test/bills/wallet-bill-harness';
import { body } from '../../../test/payments/poll-helpers';
import { PayableRegistry } from '../../money/payments/payable-registry';
import type {
  WalletBillQuoteView,
  WalletBillView,
} from '../wallet-bill-view.type';

/**
 * BILLS-04 over HTTP: the real modules and a real database, Fintava's real
 * client over a socket to the local double (no provider is called). Fintava's
 * bill purchase answers were never seen in the sandbox (question 17), so the
 * double's success bodies are labelled guesses; its refusals are the
 * sandbox's own words.
 *
 * The figures: a ₦10,000 electricity bill is ₦10,000 + Fintava's ₦100 bill
 * charge + WAWU's ₦0, moved into WAWU's account in one transfer, and Fintava's
 * ₦15.75 balance-transfer charge on that (R-31), ₦10,115.75 in all.
 */

const AMOUNT = 1_000_000;
const BILL_CHARGE = 10_000;
const INTO_WAWU = AMOUNT + BILL_CHARGE;
const TRANSFER_FEE = 1_575;
const TOTAL = INTO_WAWU + TRANSFER_FEE;
const START = 5_000_000;
const METER = '04123456789';
const IKEJA = 'Ikeja_Electric_Bill_Payment';

describe('BILLS-04 pay a bill from the wallet', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootBillApp('bills04');
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.book.mode = 'ok';
    h.book.meter = 'found';
    h.book.delayMs = 0;
    h.book.purchases.length = 0;
    h.book.history.length = 0;
    h.double.seen.length = 0;
  });

  const electricity = (over: Record<string, unknown> = {}) => ({
    category: 'electricity',
    code: IKEJA,
    accountNumber: METER,
    amountKobo: AMOUNT,
    ...over,
  });

  async function start(
    p: Person,
    send: Record<string, unknown> = electricity(),
  ): Promise<WalletBillQuoteView> {
    const res = await r.create(p, send).expect(201);
    return body<WalletBillQuoteView>(res).data!;
  }

  const payBody = (q: WalletBillQuoteView) => ({
    billId: q.bill.id,
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });

  const balance = (p: Person) => h.wallets.kobo.get(p.accountNumber);

  describe('S5: the quote', () => {
    it('prices a bill from the server: the bill charge, WAWU fee and transfer charge, and the total the button shows', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      expect(q.bill).toMatchObject({
        category: 'electricity',
        billerCode: IKEJA,
        planType: 'prepaid',
        accountNumber: METER,
        accountName: 'Chidinma Okoro',
        amountKobo: AMOUNT,
        billChargeKobo: BILL_CHARGE,
        serviceFeeKobo: 0,
        status: 'awaiting_payment',
        paymentId: null,
        token: null,
      });
      expect(q.bill.title).toContain('Ikeja');
      expect(q.bill.reference).toMatch(/^WAW-BIL-[A-HJ-NP-Z2-9]{8}$/);
      expect(q.parts).toEqual([
        { code: 'bill_charge', source: 'provider', amountKobo: BILL_CHARGE },
        { code: 'wawu_fee', source: 'wawu', amountKobo: 0 },
        {
          code: 'balance_transfer',
          source: 'provider',
          amountKobo: TRANSFER_FEE,
        },
      ]);
      expect(q.payment).toMatchObject({
        kind: 'bill',
        targetId: q.bill.id,
        priceKobo: INTO_WAWU,
        totalKobo: TOTAL,
        balanceKobo: START,
        shortfallKobo: 0,
        willBeHeld: true,
        payee: null,
      });
      // The pay sheet's total is the same as the fee quote's for a bill.
      const fee = await request(h.app.getHttpServer())
        .get(
          `/api/hub/money/fees/quote?kind=bill&billCategory=electricity&amountKobo=${AMOUNT}`,
        )
        .set('Authorization', p.auth)
        .expect(200);
      expect(body<{ totalKobo: number }>(fee).data!.totalKobo).toBe(TOTAL);
      expect(h.double.seen.some((x) => x.path === '/billing/electricity')).toBe(
        false,
      );
      expect(balance(p)).toBe(START);
    });

    it('shows the shortfall including every charge when the wallet cannot cover it (S11)', async () => {
      const p = await h.buyer(620_000);
      const q = await start(p);
      expect(q.payment.shortfallKobo).toBe(TOTAL - 620_000);
      const res = await r.pay(p, payBody(q)).expect(402);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'insufficient_funds',
        shortfallKobo: TOTAL - 620_000,
      });
      expect(h.book.purchases).toHaveLength(0);
      expect(balance(p)).toBe(620_000);
    });

    it('refuses a bill below the company minimum before anything is quoted or debited', async () => {
      const p = await h.buyer(START);
      const res = await r
        .create(p, electricity({ amountKobo: 10_000 }))
        .expect(400);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'amount_out_of_range',
        minimumKobo: 50_000,
        maximumKobo: 50_000_000,
      });
      expect(
        await h.prisma.walletBill.count({ where: { wawuUserId: p.id } }),
      ).toBe(0);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: p.id },
        }),
      ).toBe(0);
      expect(balance(p)).toBe(START);
      expect(
        h.double.seen.some((x) => x.path === '/transaction/wallet-to-wallet'),
      ).toBe(false);
    });

    it('refuses a meter Fintava does not know (S10) before any quote', async () => {
      const p = await h.buyer(START);
      h.book.meter = 'unknown';
      const res = await r.create(p, electricity()).expect(422);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'meter_not_found',
      });
      expect(
        await h.prisma.walletBill.count({ where: { wawuUserId: p.id } }),
      ).toBe(0);
    });

    it('is 409 wallet_not_open for a person with no wallet, and 404 for a bill that is not theirs', async () => {
      const none = h.walletless();
      const res = await r.create(none, electricity()).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'wallet_not_open',
      });
      const owner = await h.buyer(START);
      const other = await h.buyer(START);
      const q = await start(owner);
      await r.read(other, q.bill.id).expect(404);
      await r.quote(other, q.bill.id).expect(404);
      const stolen = await r.pay(other, payBody(q)).expect(404);
      expect(body<unknown>(stolen).reason).toMatchObject({
        code: 'target_not_found',
      });
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: other.id },
        }),
      ).toBe(0);
    });
  });

  describe('S7: paid and delivered', () => {
    it('pays an electricity bill with the PIN and answers the token and units; the hold is released and the wallets agree', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      const res = await r.pay(p, payBody(q)).expect(201);
      const bill = body<WalletBillView>(res).data!;
      expect(bill).toMatchObject({
        id: q.bill.id,
        status: 'delivered',
        token: TOKEN,
        units: UNITS,
        totalKobo: TOTAL,
        transferFeeKobo: TRANSFER_FEE,
        amountKobo: AMOUNT,
        reference: q.bill.reference,
        failureReason: null,
        returned: null,
      });
      expect(bill.paymentId).toEqual(expect.any(String));
      expect(bill.deliveredAt).toEqual(expect.any(String));

      // One purchase, for the bill's own amount, to the meter's company.
      expect(h.book.purchases).toHaveLength(1);
      expect(h.book.purchases[0]).toMatchObject({
        path: '/billing/electricity',
        body: {
          meternumber: METER,
          disco: IKEJA,
          planType: 'prepaid',
          amount: AMOUNT / 100,
        },
      });

      // The money: the buyer paid the total once; WAWU's account took the
      // price and paid the biller; nothing else moved.
      expect(balance(p)).toBe(START - TOTAL);
      const sends = h.wallets.sends.filter((s) => s.from === p.accountNumber);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        to: MERCHANT_ACCOUNT,
        amountKobo: INTO_WAWU,
        feeKobo: TRANSFER_FEE,
      });

      const payment = await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: bill.paymentId! },
      });
      expect(payment).toMatchObject({
        kind: 'bill',
        targetId: q.bill.id,
        status: 'completed',
        payeeWawuUserId: null,
      });
      expect(payment.fulfilledAt).not.toBeNull();
      expect(Number(payment.priceKobo)).toBe(INTO_WAWU);
      const hold = await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: payment.id },
      });
      expect(hold).toMatchObject({
        status: 'released',
        action: 'release',
        releaseCondition: 'bill_delivered',
      });
      // The ledger and the wallets agree: the buyer's row is the transfer.
      const ledger = await h.prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: payment.customerReference },
      });
      expect(ledger.length).toBeGreaterThanOrEqual(1);
      expect(ledger.every((l) => l.status === 'completed')).toBe(true);
      // The purchase out of WAWU's account is in the ledger too, for MONEY-16.
      const purchase = await h.prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: `wawu-bill-${q.bill.id}` },
      });
      expect(purchase).toHaveLength(1);
      expect(purchase[0]).toMatchObject({
        category: 'bill',
        direction: 'out',
        status: 'completed',
        linkKind: 'bill',
        linkTargetId: q.bill.id,
      });
      expect(Number(purchase[0].amountKobo)).toBe(AMOUNT);
      expect(Number(purchase[0].feeKobo)).toBe(BILL_CHARGE);

      // The receipt reads the same.
      const again = body<WalletBillView>(
        await r.read(p, q.bill.id).expect(200),
      ).data!;
      expect(again).toMatchObject({
        status: 'delivered',
        token: TOKEN,
        units: UNITS,
      });
    });

    it('charges once for the same request twice: the key replays the first answer and nothing is bought again', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      const key = randomUUID();
      const first = await r.pay(p, payBody(q), { key }).expect(201);
      const second = await r.pay(p, payBody(q), { key, pin: null }).expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(body<WalletBillView>(second).data).toEqual(
        body<WalletBillView>(first).data,
      );
      expect(h.book.purchases).toHaveLength(1);
      expect(balance(p)).toBe(START - TOTAL);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: p.id },
        }),
      ).toBe(1);
    });

    it('does not take a paid bill again under another key', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      await r.pay(p, payBody(q)).expect(201);
      const res = await r.pay(p, payBody(q)).expect(409);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'target_not_payable',
      });
      expect(h.book.purchases).toHaveLength(1);
      expect(balance(p)).toBe(START - TOTAL);
    });

    it('refuses a wrong PIN and moves nothing', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      await r.pay(p, payBody(q), { pin: '1111' }).expect((res) => {
        expect([401, 403, 422]).toContain(res.status);
      });
      expect(h.book.purchases).toHaveLength(0);
      expect(balance(p)).toBe(START);
    });

    it('buys data at the bundle price Fintava lists, and cable at the plan price', async () => {
      const p = await h.buyer(START);
      const data = await start(p, {
        category: 'data',
        code: 'MTN',
        accountNumber: '08031234567',
        productCode: '30',
      });
      expect(data.bill).toMatchObject({
        title: 'MTN',
        productLabel: 'MTN 1.5GB Monthly',
        amountKobo: 100_000,
        billChargeKobo: 0,
      });
      const paidData = body<WalletBillView>(
        await r.pay(p, payBody(data)).expect(201),
      ).data!;
      expect(paidData.status).toBe('delivered');
      expect(h.book.purchases[0]).toMatchObject({
        path: '/billing/data-bundle',
        body: {
          vtu_network: 'MTN',
          data_code: '30',
          vtu_number: '08031234567',
        },
      });

      const cable = await start(p, {
        category: 'cable',
        code: 'DSTV',
        accountNumber: '7012345678',
        productCode: 'COMPACT',
      });
      expect(cable.bill).toMatchObject({
        amountKobo: 1_570_000,
        billChargeKobo: 10_000,
      });
      const paidCable = body<WalletBillView>(
        await r.pay(p, payBody(cable)).expect(201),
      ).data!;
      expect(paidCable.status).toBe('delivered');
      expect(h.book.purchases[1]).toMatchObject({
        path: '/billing/cable-subscription',
        body: {
          smartcard_number: '7012345678',
          tv_network: 'DSTV',
          service_code: 'COMPACT',
        },
      });
    });

    it('buys airtime in whole naira of at least ₦100, and refuses less before any debit', async () => {
      const p = await h.buyer(START);
      const air = (amountKobo: number) => ({
        category: 'airtime',
        code: 'MTN',
        accountNumber: '2348031234567',
        amountKobo,
      });
      const low = await r.create(p, air(5_000)).expect(400);
      expect(body<unknown>(low).reason).toMatchObject({
        code: 'amount_out_of_range',
        minimumKobo: 10_000,
      });
      await r.create(p, air(15_050)).expect(400);
      const q = await start(p, air(50_000));
      expect(q.bill.accountNumber).toBe('08031234567');
      const paid = body<WalletBillView>(
        await r.pay(p, payBody(q)).expect(201),
      ).data!;
      expect(paid.status).toBe('delivered');
      expect(h.book.purchases[0]).toMatchObject({
        path: '/billing/airtime',
        body: {
          vtu_network: 'MTN',
          vtu_amount: 500,
          vtu_number: '08031234567',
        },
      });
    });
  });

  describe('S12: the biller fails', () => {
    it('returns the money to the wallet by itself when Fintava refuses the purchase', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      h.book.mode = 'refuse';
      const res = await r.pay(p, payBody(q)).expect(201);
      const bill = body<WalletBillView>(res).data!;
      expect(bill.status).toBe('failed');
      expect(bill.token).toBeNull();
      expect(bill.failureReason).toEqual(expect.any(String));
      expect(bill.returned).toEqual({
        holdStatus: 'refunded',
        returned: true,
        returnedKobo: INTO_WAWU,
      });
      expect(h.book.purchases).toHaveLength(0);
      // The price came back; Fintava's charge on the first transfer did not (R-10).
      expect(balance(p)).toBe(START - TRANSFER_FEE);
      const payment = await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: bill.paymentId! },
      });
      const hold = await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: payment.id },
      });
      expect(hold).toMatchObject({ status: 'refunded', action: 'refund' });
      // The same answer on a read, and the bill cannot be paid again.
      const again = body<WalletBillView>(
        await r.read(p, q.bill.id).expect(200),
      ).data!;
      expect(again.status).toBe('failed');
      await r.pay(p, payBody(q)).expect(409);
    });

    it('returns the money when a cable service answers "not currently available"', async () => {
      const p = await h.buyer(START);
      const q = await start(p, {
        category: 'cable',
        code: 'DSTV',
        accountNumber: '7012345678',
        productCode: 'COMPACT',
      });
      h.book.mode = 'unavailable';
      const bill = body<WalletBillView>(
        await r.pay(p, payBody(q)).expect(201),
      ).data!;
      expect(bill.status).toBe('failed');
      expect(bill.returned?.returned).toBe(true);
      expect(balance(p)).toBe(START - 1575);
    });
  });

  describe('two deliveries at the same moment', () => {
    it('buys once: only the one that claims the purchase calls Fintava', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      h.book.delayMs = 400;
      const handler = h.app
        .get(PayableRegistry, { strict: false })
        .get('bill')!;
      // The payment's id and hold are not real here: what is asked is who buys.
      const paymentId = randomUUID();
      // Paid and not yet claimed, as when two servers pick the delivery up.
      await h.prisma.walletBill.update({
        where: { id: q.bill.id },
        data: { status: 'buying', paymentId, paidAt: new Date() },
      });
      const again = () =>
        handler.onCompleted!({
          paymentId,
          payerWawuUserId: p.id,
          kind: 'bill',
          targetId: q.bill.id,
          priceKobo: INTO_WAWU,
          payeeWawuUserId: null,
          note: null,
          holdId: null,
        });
      await Promise.allSettled([again(), again()]);
      expect(h.book.purchases).toHaveLength(1);
    });
  });

  describe('a purchase whose answer was lost', () => {
    it('is never bought again; one clear record in Fintava history settles it as delivered', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      h.book.mode = 'lost';
      const res = await r.pay(p, payBody(q)).expect(201);
      expect(body<WalletBillView>(res).data!.status).toBe('processing');
      expect(h.book.purchases).toHaveLength(1);
      const paymentId = body<WalletBillView>(res).data!.paymentId!;
      const payment = await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(payment.status).toBe('completed');
      expect(payment.fulfilledAt).toBeNull();
      // Nobody is refunded and nothing is sent again while the outcome is unknown.
      await h.sweepLater(2 * 60_000);
      await h.sweepLater(10 * 60_000);
      expect(h.book.purchases).toHaveLength(1);
      expect(
        (
          await h.prisma.walletBill.findUniqueOrThrow({
            where: { id: q.bill.id },
          })
        ).status,
      ).toBe('buying');
      expect(
        (await h.prisma.walletHold.findUniqueOrThrow({ where: { paymentId } }))
          .status,
      ).toBe('held');

      h.book.history.push(
        purchaseRow({
          amount: '10000.00',
          meternumber: METER,
          metertoken: TOKEN,
        }),
      );
      await h.sweepLater(30 * 60_000);
      const done = body<WalletBillView>(
        await r.read(p, q.bill.id).expect(200),
      ).data!;
      expect(done).toMatchObject({ status: 'delivered', token: TOKEN });
      expect(h.book.purchases).toHaveLength(1);
      expect(
        (await h.prisma.walletHold.findUniqueOrThrow({ where: { paymentId } }))
          .status,
      ).toBe('released');
      expect(balance(p)).toBe(START - TOTAL);
    });

    it('is not bought again when the delivery runs again, even twice at the same moment', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      h.book.mode = 'lost';
      const res = await r.pay(p, payBody(q)).expect(201);
      expect(body<WalletBillView>(res).data!.status).toBe('processing');
      expect(h.book.purchases).toHaveLength(1);
      const paymentId = body<WalletBillView>(res).data!.paymentId!;
      const hold = await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId },
      });
      const handler = h.app
        .get(PayableRegistry, { strict: false })
        .get('bill')!;
      // Fintava would deliver if it were asked again: it must not be.
      h.book.mode = 'ok';
      const again = () =>
        handler.onCompleted!({
          paymentId,
          payerWawuUserId: p.id,
          kind: 'bill',
          targetId: q.bill.id,
          priceKobo: INTO_WAWU,
          payeeWawuUserId: null,
          note: null,
          holdId: hold.id,
        });
      const settled = await Promise.allSettled([again(), again()]);
      expect(settled.map((x) => x.status)).toEqual(['rejected', 'rejected']);
      expect(h.book.purchases).toHaveLength(1);
      expect(
        (
          await h.prisma.walletBill.findUniqueOrThrow({
            where: { id: q.bill.id },
          })
        ).status,
      ).toBe('buying');
    });

    it('is refunded when Fintava history shows the purchase failed', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      h.book.mode = 'lost';
      const res = await r.pay(p, payBody(q)).expect(201);
      expect(body<WalletBillView>(res).data!.status).toBe('processing');
      h.book.history.push(
        purchaseRow({
          amount: '10000.00',
          meternumber: METER,
          status: 'FAILURE',
        }),
      );
      await h.sweepLater(10 * 60_000);
      const done = body<WalletBillView>(
        await r.read(p, q.bill.id).expect(200),
      ).data!;
      expect(done.status).toBe('failed');
      expect(done.returned?.returned).toBe(true);
      expect(balance(p)).toBe(START - TRANSFER_FEE);
    });

    it('stays undecided when two records could be this purchase', async () => {
      const p = await h.buyer(START);
      const q = await start(p);
      h.book.mode = 'lost';
      await r.pay(p, payBody(q)).expect(201);
      h.book.history.push(
        purchaseRow({ amount: '10000.00', meternumber: METER }),
        purchaseRow({
          id: randomUUID(),
          amount: '10000.00',
          meternumber: METER,
        }),
      );
      await h.sweepLater(10 * 60_000);
      expect(
        (
          await h.prisma.walletBill.findUniqueOrThrow({
            where: { id: q.bill.id },
          })
        ).status,
      ).toBe('buying');
    });
  });
});

describe('BILLS-04 bills count against the bill limit', () => {
  let h: BillHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootBillApp('bills04lim', {
      WAWU_LIMIT_BILL_DAILY_KOBO: '1500000',
    });
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('stops a second bill past the bill daily limit before anything moves', async () => {
    const p = await h.buyer(10_000_000);
    const make = async () =>
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
    const first = await make();
    expect(first.payment.withinDailyLimit).toBe(true);
    await r
      .pay(p, {
        billId: first.bill.id,
        expectedTotalKobo: first.payment.totalKobo,
        quoteToken: first.payment.quoteToken,
      })
      .expect(201);
    const second = await make();
    expect(second.payment.withinDailyLimit).toBe(false);
    const res = await r
      .pay(p, {
        billId: second.bill.id,
        expectedTotalKobo: second.payment.totalKobo,
        quoteToken: second.payment.quoteToken,
      })
      .expect(403);
    expect(body<unknown>(res).reason).toMatchObject({ code: 'limit_reached' });
    expect(h.book.purchases).toHaveLength(1);
    expect(h.wallets.kobo.get(p.accountNumber)).toBe(10_000_000 - TOTAL);
  });
});

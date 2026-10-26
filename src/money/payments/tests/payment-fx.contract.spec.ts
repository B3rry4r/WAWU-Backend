import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../../test/payments/nuvion-seam-standin';
import {
  bootPfxApp,
  FakeFx,
  type FakeAccount,
  mintToken,
  type PfxApp,
  registerPfxItems,
} from '../../../../test/payments/pay-fx-harness';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WalletHoldService } from '../../holds/wallet-hold.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import { IDEMPOTENT_REPLAYED_HEADER } from '../idempotency';
import { PayableRegistry } from '../payable-registry';
import { WalletPaymentService } from '../wallet-payment.service';

/**
 * PAY-FX (R-91): a buyer whose money is in another currency pays a naira
 * price. The Hub's real MoneyModule over a real database, `WALLET_PROVIDER`
 * given the Nuvion seam stand-in for the naira side and, for the foreign
 * accounts, an in-memory provider that behaves the way Nuvion's dev did on
 * 26 Oct 2026 (docs/nuvion/DEV-RESULTS.md, "PAY-FX"): a quote for an exact
 * naira amount is rounded UP to whole cents, the naira that lands is the
 * quote's `amount_to` exactly, a used quote is refused, a transfer with
 * another amount than the quote is refused, and the reverse quote costs
 * more naira (the spread and the rounding).
 */

const PIN = '5937';
const BASE = '/api/hub/money/payments';
const PRICE = 30_000;
jest.setTimeout(60_000);

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason & { paymentQuote?: PaymentQuoteView };
};
const body = <T>(res: Response) => res.body as Envelope<T>;

describe('Pay a naira price from another currency (PAY-FX, R-91)', () => {
  let booted: PfxApp;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let holds: WalletHoldService;
  const nuvion = new NuvionSeamStandIn();
  let fx: FakeFx;
  const delivered: Array<{
    paymentId: string;
    kind: string;
    targetId: string;
  }> = [];
  const owned = new Set<string>();
  const users: string[] = [];
  let seq = 0;
  let clock = Date.now();

  type Person = {
    id: string;
    auth: string;
    usd: FakeAccount;
    naira?: NuvionAccount;
  };

  /** A person with an open USD account holding `cents`; with `naira` kobo too if given (a Nigerian who added dollars). */
  async function buyer(cents: bigint, naira?: bigint): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    seq += 1;
    const entityId = `01PFXENT${String(seq).padStart(18, '0')}`;
    const usd = fx.open(entityId, 'USD', cents);
    let account: NuvionAccount | undefined;
    if (naira !== undefined) {
      const accountNumber = `82${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
      account = nuvion.openAccount(naira, accountNumber);
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: account.entityId,
          walletId: account.accountId,
          accountNumber,
          provider: 'nuvion',
        },
      });
    } else {
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: id,
          state: 'open',
          bvnHash: `hash-${id}`,
          bvnVerifiedAt: new Date(),
          phone: `+1${String(Date.now()).slice(-7)}${String(100 + seq)}`,
          provider: 'nuvion',
          worldCountry: 'US',
          worldFirstCurrency: 'USD',
          worldAccountOpenedAt: new Date(),
        },
      });
      await prisma.nuvionEntity.create({
        data: { wawuUserId: id, entityId, status: 'approved' },
      });
    }
    await prisma.fxAccount.create({
      data: {
        wawuUserId: id,
        provider: 'nuvion',
        currency: 'USD',
        chain: '',
        providerCustomerId: account?.entityId ?? entityId,
        providerAccountId: usd.accountId,
        ban: usd.ban,
        status: 'open',
      },
    });
    const auth = `Bearer ${mintToken(id)}`;
    const set = await request(app.getHttpServer())
      .post('/api/hub/money/pin')
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return { id, auth, usd, naira: account };
  }

  const quote = (p: Person, kind: string, targetId: string, extra = '') =>
    request(app.getHttpServer())
      .get(`${BASE}/quote?kind=${kind}&targetId=${targetId}${extra}`)
      .set('Authorization', p.auth);

  const send = (p: Person, payload: object, key: string = randomUUID()) =>
    request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send(payload);

  const payBody = (q: PaymentQuoteView, currency?: string) => ({
    kind: q.kind,
    targetId: q.targetId,
    expectedTotalKobo: q.totalKobo,
    quoteToken: q.quoteToken,
    ...(currency ? { sourceCurrency: currency } : {}),
  });

  async function usdQuote(p: Person, kind = 'content_unlock') {
    const res = await quote(
      p,
      kind,
      `n-${randomUUID()}`,
      '&sourceCurrency=USD',
    );
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  }
  const rowOf = (paymentId: string) =>
    prisma.walletPayment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { fx: true },
    });
  const sweep = () => {
    clock += 2 * 60_000;
    return payments.sweep(new Date(clock));
  };

  beforeAll(async () => {
    fx = new FakeFx(nuvion.operational.nuvionBan);
    const provider = new Proxy(nuvion, {
      get(target, key) {
        if (key === 'fx') return fx;
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === 'function'
          ? (v as (...a: unknown[]) => unknown).bind(target)
          : v;
      },
    });
    booted = await bootPfxApp(provider);
    app = booted.app as INestApplication<App>;
    const m = booted.moduleRef;
    prisma = m.get(PrismaService);
    payments = m.get(WalletPaymentService);
    holds = m.get(WalletHoldService);
    registerPfxItems(m.get(PayableRegistry), PRICE, delivered, owned);
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { id: true, customerReference: true },
      });
      const ids = rows.map((r) => r.id);
      await prisma.walletPaymentFx.deleteMany({
        where: { paymentId: { in: ids } },
      });
      await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { paymentId: { in: ids } },
      });
      await prisma.walletPayment.deleteMany({ where: { id: { in: ids } } });
      await prisma.moneyIdempotencyKey
        .deleteMany({ where: { wawuUserId: { in: users } } })
        .catch(() => undefined);
      await prisma.fxQuote.deleteMany({ where: { wawuUserId: { in: users } } });
      await prisma.fxAccount.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin
        .deleteMany({ where: { wawuUserId: { in: users } } })
        .catch(() => undefined);
    }
    await booted?.app.close();
    booted?.restoreEnv();
  });

  it('quotes a naira price against the dollar account: the price stays naira, the firm amount is in cents, no naira fee', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    expect(q.priceKobo).toBe(PRICE);
    expect(q.totalKobo).toBe(PRICE);
    expect(q.fee).toEqual({
      providerFeeKobo: 0,
      wawuFeeKobo: 0,
      totalFeeKobo: 0,
    });
    // 30,000 kobo at 1315.44 is 22.8 cents, rounded up: 23 (dev, 26 Oct).
    expect(q.source).toMatchObject({
      currency: 'USD',
      decimals: 2,
      amountMinor: 23,
      providerFeeMinor: 0,
      wawuFeeMinor: 0,
      totalMinor: 23,
      availableMinor: 500,
      shortfallMinor: 0,
    });
    expect(q.quoteToken.startsWith('fx.')).toBe(true);
    expect(Date.parse(q.source!.expiresAt)).toBeGreaterThan(Date.now());
    // Asking moved nothing.
    expect(p.usd.available).toBe(500n);
  });

  it('a dollar buyer with no naira account pays: the naira lands in WAWU, the payee is credited as today, the card shows what it took', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    const merchantBefore = fx.merchantKobo;
    const res = await send(p, payBody(q, 'USD'));
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    expect(view.delivered).toBe(true);
    expect(view.totalKobo).toBe(PRICE);
    expect(view.fee.totalFeeKobo).toBe(0);
    expect(view.source).toMatchObject({
      currency: 'USD',
      amountMinor: 23,
      totalMinor: 23,
      refundedMinor: null,
    });
    // The account paid 23 cents; WAWU's naira account received exactly the price.
    expect(p.usd.available).toBe(477n);
    expect(fx.merchantKobo - merchantBefore).toBe(BigInt(PRICE));
    const row = await rowOf(view.id);
    expect(row.sourceCurrency).toBe('USD');
    expect(row.fx?.sourceAmountMinor).toBe(23n);
    expect(row.fx?.providerTransferId).toBeTruthy();
    // The split is the same 85/15 of the naira price.
    expect(row.payeeShareKobo).toBe(25_500n);
    expect(row.wawuShareKobo).toBe(4_500n);
    expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(1);
    // WAWU's side is a naira row; there is no naira debit for the buyer.
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: view.reference },
    });
    expect(
      rows.map((r) => `${r.walletKind}:${r.direction}:${r.status}`),
    ).toEqual(['merchant:in:completed']);
    expect(rows[0].amountKobo).toBe(BigInt(PRICE));
  });

  it('the same Idempotency-Key answers the first payment again and moves nothing twice', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    const key = randomUUID();
    const first = await send(p, payBody(q, 'USD'), key);
    const again = await send(p, payBody(q, 'USD'), key);
    expect(again.status).toBe(201);
    expect(again.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(body<PaymentView>(again).data!.id).toBe(
      body<PaymentView>(first).data!.id,
    );
    expect(p.usd.available).toBe(477n);
  });

  it('a quote that has been used, or has run out, is quote_changed with a fresh firm quote', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    const used = await send(p, payBody(q, 'USD'));
    expect(used.status).toBe(201);
    // The same quote again, for another item: spent.
    const q2 = await usdQuote(p);
    await prisma.fxQuote.updateMany({
      where: { wawuUserId: p.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await send(p, payBody(q2, 'USD'));
    expect(late.status).toBe(409);
    expect(body(late).reason?.code).toBe('quote_changed');
    expect(body(late).reason?.paymentQuote?.source?.currency).toBe('USD');
    expect(p.usd.available).toBe(477n);
  });

  it('refuses when the account holds less than the firm amount: nothing moves, no payment is kept', async () => {
    const p = await buyer(10n);
    const q = await usdQuote(p);
    expect(q.source!.shortfallMinor).toBe(13);
    const res = await send(p, payBody(q, 'USD'));
    expect(res.status).toBe(402);
    expect(body(res).reason?.code).toBe('insufficient_funds');
    expect(p.usd.available).toBe(10n);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  it('a transfer the provider has not finished leaves the payment pending, and the sweep completes it once the provider says', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    fx.mode = 'pending';
    const res = await send(p, payBody(q, 'USD'));
    fx.mode = 'completed';
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('pending');
    expect(view.statusMessage).toContain("Don't pay again");
    expect(p.usd.available).toBe(500n);
    fx.finish(view.reference, 'completed');
    await sweep();
    const row = await rowOf(view.id);
    expect(row.status).toBe('completed');
    expect(p.usd.available).toBe(477n);
    expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(1);
  });

  it('a lost answer is pending until the provider says, and is never sent twice', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    const made = fx.transfers.length;
    fx.mode = 'lost';
    const res = await send(p, payBody(q, 'USD'));
    fx.mode = 'completed';
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('pending');
    // The provider has no record yet: that is no proof that nothing moved,
    // so the payment stays pending and nothing is sent again.
    await sweep();
    expect((await rowOf(view.id)).status).toBe('pending');
    expect(fx.transfers.length).toBe(made);
    expect(p.usd.available).toBe(500n);
  });

  it('a transfer the provider failed is a failed payment: nothing delivered, the item is free again', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p);
    fx.mode = 'failed';
    const res = await send(p, payBody(q, 'USD'));
    fx.mode = 'completed';
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('failed');
    expect(view.delivered).toBe(false);
    expect(p.usd.available).toBe(500n);
    expect((await rowOf(view.id)).openKey).toBeNull();
  });

  it('a held ticket paid in dollars is refunded to the dollar account: the same amount, in dollars', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p, 'event_ticket');
    const res = await send(p, payBody(q, 'USD'));
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    expect(view.hold?.status).toBe('held');
    expect(p.usd.available).toBe(477n);
    const merchantBefore = fx.merchantKobo;
    const out = await holds.refund({ paymentId: view.id }, 'event called off', {
      returnCharge: true,
    });
    expect(out.state).toBe('settled');
    // Back to the cent, to the account it came from.
    expect(p.usd.available).toBe(500n);
    // 23 cents back cost WAWU 31,040 kobo (dev: 23 / 0.000741, rounded up) for the 30,000 it took in.
    expect(merchantBefore - fx.merchantKobo).toBe(31_040n);
    const row = await rowOf(view.id);
    expect(row.fx?.refundMinor).toBe(23n);
    expect(row.fx?.refundCostKobo).toBe(31_040n);
    expect(row.fx?.refundedAt).not.toBeNull();
    const hold = await prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: view.id },
    });
    expect(hold.status).toBe('refunded');
    const read = await request(app.getHttpServer())
      .get(`${BASE}/${view.id}`)
      .set('Authorization', p.auth);
    expect(body<PaymentView>(read).data!.source?.refundedMinor).toBe(23);
    // The same refund asked again moves nothing.
    await holds.refund({ paymentId: view.id }, 'again');
    expect(p.usd.available).toBe(500n);
  });

  it('a Nigerian who holds dollars too pays from dollars; their naira wallet is untouched, and a naira payment is unchanged', async () => {
    const p = await buyer(500n, 400_000n);
    const q = await usdQuote(p);
    const res = await send(p, payBody(q, 'USD'));
    expect(body<PaymentView>(res).data!.status).toBe('completed');
    expect(p.naira!.availableKobo).toBe(400_000n);
    expect(p.usd.available).toBe(477n);

    // Now the naira way, as before: no sourceCurrency, the fee quote's total.
    const nq = await quote(p, 'content_unlock', `n-${randomUUID()}`);
    expect(nq.status).toBe(200);
    const nview = body<PaymentQuoteView>(nq).data!;
    expect(nview.source).toBeUndefined();
    const before = p.naira!.availableKobo;
    nuvion.feeKobo = () => BigInt(nview.fee.providerFeeKobo);
    nuvion.mode = 'successful';
    const npay = await send(p, payBody(nview));
    expect(npay.status).toBe(201);
    const nv = body<PaymentView>(npay).data!;
    expect(nv.status).toBe('completed');
    expect(nv.source).toBeUndefined();
    expect(p.naira!.availableKobo).toBeLessThan(before);
    const nrow = await rowOf(nv.id);
    expect(nrow.sourceCurrency).toBeNull();
    expect(nrow.fx).toBeNull();
  });

  it('the account that pays can ride on a header every paying route reads (X-Pay-Source-Currency)', async () => {
    const p = await buyer(500n);
    const q = await request(app.getHttpServer())
      .get(`${BASE}/quote?kind=content_unlock&targetId=n-${randomUUID()}`)
      .set('Authorization', p.auth)
      .set('X-Pay-Source-Currency', 'USD');
    expect(q.status).toBe(200);
    const view = body<PaymentQuoteView>(q).data!;
    expect(view.source?.currency).toBe('USD');
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('X-Pay-Source-Currency', 'USD')
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({
        kind: view.kind,
        targetId: view.targetId,
        expectedTotalKobo: view.totalKobo,
        quoteToken: view.quoteToken,
      });
    expect(res.status).toBe(201);
    expect(body<PaymentView>(res).data!.source?.currency).toBe('USD');
    expect(p.usd.available).toBe(477n);
    // The header does not leak to the next request: without it, the naira way.
    const next = await quote(p, 'content_unlock', `n-${randomUUID()}`);
    expect(next.status).toBe(409);
  });

  it('a person with no naira account who asks for the naira way is told so, as before', async () => {
    const p = await buyer(500n);
    const res = await quote(p, 'content_unlock', `n-${randomUUID()}`);
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('wallet_not_open');
  });

  it('refuses a currency the person has no account in', async () => {
    const p = await buyer(500n);
    const res = await quote(
      p,
      'content_unlock',
      `n-${randomUUID()}`,
      '&sourceCurrency=GBP',
    );
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('fx_account_not_open');
  });

  it('the sweep rounds the clock forward without error when nothing is pending', async () => {
    const r = await sweep();
    expect(r.checked).toBeGreaterThanOrEqual(0);
  });
});

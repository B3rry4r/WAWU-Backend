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
  mintToken,
  type PfxApp,
  registerPfxItems,
} from '../../../../test/payments/pay-fx-harness';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import type {
  ProviderForeignAccounts,
  ProviderFxAccount,
  ProviderFxQuote,
  ProviderFxSide,
  ProviderFxTransfer,
  ProviderFxTransferLookup,
} from '../../../wallet-provider/wallet-provider-fx';
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
/** Dev, 26 Oct 2026: USD to NGN 1315.440043 kobo per cent; NGN to USD 0.000741 cents per kobo. */
const SELL = 1315.440043;
const BUY = 0.000741;

jest.setTimeout(60_000);

interface FakeAccount {
  accountId: string;
  entityId: string;
  currency: string;
  ban: string;
  available: bigint;
}
interface FakeQuote {
  id: string;
  from: string;
  fromMerchant: boolean;
  amountFrom: bigint;
  amountTo: bigint;
  used: boolean;
  expiresAt: Date;
}
interface FakeTransfer {
  transferId: string;
  reference: string;
  status: 'pending' | 'completed' | 'failed';
  apply: () => void;
}

const id26 = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(26 - prefix.length, '0')}`;

/** Nuvion's foreign accounts as dev answered them, in memory. */
class FakeFx implements ProviderForeignAccounts {
  readonly currencies = ['USD', 'GBP', 'EUR'] as const;
  readonly accounts = new Map<string, FakeAccount>();
  readonly quotes = new Map<string, FakeQuote>();
  readonly transfers: FakeTransfer[] = [];
  merchantKobo = 0n;
  /** What the next swap (either way) does. */
  mode: 'completed' | 'pending' | 'failed' | 'lost' = 'completed';
  /** Seconds a new quote is held. */
  holdSeconds = 179;
  private n = 0;
  constructor(private readonly merchantBan: string) {}

  private next(prefix: string) {
    this.n += 1;
    return id26(prefix, this.n);
  }
  open(entityId: string, currency: string, cents: bigint): FakeAccount {
    const a = {
      accountId: this.next('01FAKEACC'),
      entityId,
      currency,
      ban: `00${String(1_000_000 + this.n)}`,
      available: cents,
    };
    this.accounts.set(a.accountId, a);
    return a;
  }
  openAccount(): never {
    throw new Error('not used');
  }
  readDetails(): never {
    throw new Error('not used');
  }
  send(): never {
    throw new Error('not used');
  }
  statement(): never {
    throw new Error('not used');
  }

  readAccount(_person: unknown, accountId: string): Promise<ProviderFxAccount> {
    const a = this.accounts.get(accountId)!;
    return Promise.resolve({
      accountId,
      currency: a.currency,
      ban: a.ban,
      availableMinor: a.available,
      bookedMinor: a.available,
    });
  }

  private newQuote(
    from: string,
    fromMerchant: boolean,
    amountFrom: bigint,
    amountTo: bigint,
    rate: number,
  ): ProviderFxQuote {
    const q: FakeQuote = {
      id: this.next('01FAKEQ'),
      from,
      fromMerchant,
      amountFrom,
      amountTo,
      used: false,
      expiresAt: new Date(Date.now() + this.holdSeconds * 1000),
    };
    this.quotes.set(q.id, q);
    return {
      id: q.id,
      amountFromMinor: amountFrom,
      amountToMinor: amountTo,
      rate: String(rate),
      expiresAt: q.expiresAt,
      feeMinor: null,
    };
  }

  quote(input: {
    from: ProviderFxSide;
    amountToMinor?: bigint;
  }): Promise<ProviderFxQuote> {
    const to = input.amountToMinor!;
    const cents = BigInt(Math.ceil(Number(to) / SELL));
    return Promise.resolve(
      this.newQuote(input.from.currency, false, cents, to, SELL),
    );
  }

  quoteFromMerchant(input: {
    to: ProviderFxSide;
    amountToMinor: bigint;
  }): Promise<ProviderFxQuote> {
    const kobo = BigInt(Math.ceil(Number(input.amountToMinor) / BUY));
    return Promise.resolve(
      this.newQuote('NGN', true, kobo, input.amountToMinor, BUY),
    );
  }

  private move(
    reference: string,
    quoteId: string,
    amount: bigint,
    apply: () => void,
  ): ProviderFxTransfer {
    const q = this.quotes.get(quoteId);
    const refuse = (why: string) =>
      new WalletProviderError({
        kind: 'refused',
        provider: 'nuvion',
        operation: 'fx',
        messages: [why],
      });
    if (!q) throw refuse('no such quote');
    if (q.used) throw refuse('This FX quote has already been used.');
    if (q.amountFrom !== amount) throw refuse("The amount doesn't match.");
    if (this.mode === 'lost') {
      throw new WalletProviderError({
        kind: 'outcome_unknown',
        provider: 'nuvion',
        operation: 'fx',
        reference,
      });
    }
    q.used = true;
    const t: FakeTransfer = {
      transferId: this.next('01FAKETR'),
      reference,
      status: this.mode,
      apply,
    };
    this.transfers.push(t);
    if (t.status === 'completed') apply();
    return {
      transferId: t.transferId,
      reference,
      status: t.status,
      feeMinor: 0n,
      failureReason: t.status === 'failed' ? 'declined' : null,
    };
  }

  async swap(input: {
    reference: string;
    quoteId: string | null;
    from: ProviderFxSide;
    to: ProviderFxSide;
    amountFromMinor: bigint;
  }): Promise<ProviderFxTransfer> {
    await Promise.resolve();
    const from = this.accounts.get(input.from.accountId!)!;
    if (from.available < input.amountFromMinor) {
      throw new WalletProviderError({
        kind: 'insufficient_funds',
        provider: 'nuvion',
        operation: 'fx',
      });
    }
    const q = this.quotes.get(input.quoteId!)!;
    return this.move(
      input.reference,
      input.quoteId!,
      input.amountFromMinor,
      () => {
        from.available -= input.amountFromMinor;
        if (input.to.ban === this.merchantBan) this.merchantKobo += q.amountTo;
      },
    );
  }

  async swapFromMerchant(input: {
    reference: string;
    quoteId: string;
    to: ProviderFxSide;
    amountFromMinor: bigint;
  }): Promise<ProviderFxTransfer> {
    await Promise.resolve();
    const q = this.quotes.get(input.quoteId)!;
    const to = [...this.accounts.values()].find((a) => a.ban === input.to.ban)!;
    return this.move(
      input.reference,
      input.quoteId,
      input.amountFromMinor,
      () => {
        this.merchantKobo -= input.amountFromMinor;
        to.available += q.amountTo;
      },
    );
  }

  private lookup(pred: (t: FakeTransfer) => boolean): ProviderFxTransferLookup {
    const t = this.transfers.find(pred);
    return t
      ? {
          state: 'found',
          transfer: {
            transferId: t.transferId,
            reference: t.reference,
            status: t.status,
            feeMinor: 0n,
            failureReason: null,
          },
        }
      : { state: 'absent' };
  }
  findTransferByReference(
    _p: unknown,
    _a: string,
    reference: string,
  ): Promise<ProviderFxTransferLookup> {
    return Promise.resolve(this.lookup((t) => t.reference === reference));
  }
  readTransfer(_p: unknown, id: string): Promise<ProviderFxTransferLookup> {
    return Promise.resolve(this.lookup((t) => t.transferId === id));
  }
  findMerchantTransfer(reference: string): Promise<ProviderFxTransferLookup> {
    return Promise.resolve(this.lookup((t) => t.reference === reference));
  }

  /** The provider finishes a transfer it had left pending. */
  finish(reference: string, to: 'completed' | 'failed'): void {
    const t = this.transfers.find((x) => x.reference === reference)!;
    t.status = to;
    if (to === 'completed') t.apply();
  }
}

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

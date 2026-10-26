import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import {
  bootPfxApp,
  FakeFx,
  mintToken,
  type PfxApp,
  registerPfxItems,
} from '../../../../test/payments/pay-fx-harness';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WalletHoldService } from '../../holds/wallet-hold.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import { PayableRegistry } from '../payable-registry';

/**
 * PAY-FX, WAWU's conversion fee above 0 (R-10; Default (lead), owner may
 * override): `PAYMENT_FX_FEE_USD_MINOR=5` and a collector account. The quote
 * shows the fee and the total, the payment charges the conversion and the fee
 * (the fee as its own same-currency move to the collector, collected once),
 * an account that holds the conversion but not the fee is refused, and a
 * refund the payer did not cause returns both.
 */

const PIN = '5937';
const BASE = '/api/hub/money/payments';
const PRICE = 30_000;
const COLLECTOR = 'COLLECT0USD01';

jest.setTimeout(60_000);

type Envelope<T> = {
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response) => res.body as Envelope<T>;

describe('Paying from another currency with a WAWU conversion fee (PAY-FX)', () => {
  let booted: PfxApp;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let holds: WalletHoldService;
  const nuvion = new NuvionSeamStandIn();
  let fx: FakeFx;
  const delivered: Array<{
    paymentId: string;
    kind: string;
    targetId: string;
  }> = [];
  const users: string[] = [];
  let seq = 0;

  async function buyer(cents: bigint) {
    const id = randomUUID();
    users.push(id);
    seq += 1;
    const entityId = `01PFXFEE${String(seq).padStart(18, '0')}`;
    const usd = fx.open(entityId, 'USD', cents);
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: 'open',
        bvnHash: `hash-${id}`,
        bvnVerifiedAt: new Date(),
        phone: `+1${String(Date.now()).slice(-7)}${String(200 + seq)}`,
        provider: 'nuvion',
        worldCountry: 'US',
        worldFirstCurrency: 'USD',
        worldAccountOpenedAt: new Date(),
      },
    });
    await prisma.nuvionEntity.create({
      data: { wawuUserId: id, entityId, status: 'approved' },
    });
    await prisma.fxAccount.create({
      data: {
        wawuUserId: id,
        provider: 'nuvion',
        currency: 'USD',
        chain: '',
        providerCustomerId: entityId,
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
    return { id, auth, usd };
  }

  const usdQuote = async (auth: string, kind = 'content_unlock') => {
    const res = await request(app.getHttpServer())
      .get(
        `${BASE}/quote?kind=${kind}&targetId=n-${randomUUID()}&sourceCurrency=USD`,
      )
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  };
  const pay = (auth: string, q: PaymentQuoteView) =>
    request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
        sourceCurrency: 'USD',
      });

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
    booted = await bootPfxApp(provider, {
      PAYMENT_FX_FEE_USD_MINOR: '5',
      FX_FEE_COLLECTOR_USD_BAN: COLLECTOR,
    });
    app = booted.app as INestApplication<App>;
    prisma = booted.moduleRef.get(PrismaService);
    holds = booted.moduleRef.get(WalletHoldService);
    registerPfxItems(
      booted.moduleRef.get(PayableRegistry),
      PRICE,
      delivered,
      new Set(),
    );
  });

  afterAll(async () => {
    if (prisma) {
      const ids = (
        await prisma.walletPayment.findMany({
          where: { payerWawuUserId: { in: users } },
          select: { id: true },
        })
      ).map((r) => r.id);
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
      await prisma.transactionPin
        .deleteMany({ where: { wawuUserId: { in: users } } })
        .catch(() => undefined);
    }
    await booted?.app.close();
    booted?.restoreEnv();
  });

  it('the quote shows the fee and a total that includes it, and the balance is judged against the total', async () => {
    const p = await buyer(25n);
    const q = await usdQuote(p.auth);
    expect(q.source).toMatchObject({
      amountMinor: 23,
      wawuFeeMinor: 5,
      providerFeeMinor: 0,
      totalMinor: 28,
      availableMinor: 25,
      shortfallMinor: 3,
    });
    // 23 would do, 28 does not: the fee counts.
    const res = await pay(p.auth, q);
    expect(res.status).toBe(402);
    expect(body(res).reason?.code).toBe('insufficient_funds');
    expect(p.usd.available).toBe(25n);
  });

  it('charges the conversion and the fee, collects the fee once, and shows both on the payment', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p.auth);
    const merchantBefore = fx.merchantKobo;
    const collectedBefore = fx.collected.get(COLLECTOR) ?? 0n;
    const res = await pay(p.auth, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    expect(view.source).toMatchObject({
      amountMinor: 23,
      wawuFeeMinor: 5,
      totalMinor: 28,
    });
    expect(p.usd.available).toBe(472n);
    expect(fx.merchantKobo - merchantBefore).toBe(BigInt(PRICE));
    expect((fx.collected.get(COLLECTOR) ?? 0n) - collectedBefore).toBe(5n);
    const fxRow = await prisma.walletPaymentFx.findUniqueOrThrow({
      where: { paymentId: view.id },
    });
    expect(fxRow.feeLeg).toBe('done');
    expect(fxRow.wawuFeeMinor).toBe(5n);
  });

  it('a refund the payer did not cause returns the conversion and the fee', async () => {
    const p = await buyer(500n);
    const q = await usdQuote(p.auth, 'event_ticket');
    const view = body<PaymentView>(await pay(p.auth, q)).data!;
    expect(p.usd.available).toBe(472n);
    await holds.refund({ paymentId: view.id }, 'called off', {
      returnCharge: true,
    });
    expect(p.usd.available).toBe(500n);
    const fxRow = await prisma.walletPaymentFx.findUniqueOrThrow({
      where: { paymentId: view.id },
    });
    expect(fxRow.refundMinor).toBe(28n);
  });
});

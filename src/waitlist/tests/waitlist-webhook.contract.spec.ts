// The spec reads response bodies.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PaymentWebhookModule } from '../../payment-webhook/payment-webhook.module';
import { PlansConfig } from '../../plans/plans-config';
import { newReference, WaitlistService } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  ScriptedFlutterwave,
  OFFER_ID,
  openOffer,
} from './waitlist-harness';

/**
 * JOIN-01, the payer who never came back: Flutterwave's own notice
 * (`POST /webhooks/flutterwave`, charge.completed) reaches the registration
 * through the webhook router and is settled by the SAME checks the browser's
 * verify applies. The mechanism chosen for the "never came back" case is this
 * webhook, with the scheduled by-reference re-check as the net under it
 * (waitlist.contract.spec.ts, "payers who never came back"). Flutterwave is
 * stood in; the signed deliveries are made by the spec.
 */

const SECRET_HASH = 'join01-webhook-secret-hash';
const MARK = 'join01-hook-spec';

describe('Flutterwave webhook settles an event registration (JOIN-01)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let waitlist: WaitlistService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  let fetchSpy: jest.SpyInstance;
  const saved = process.env.FLUTTERWAVE_SECRET_HASH;
  let n = 0;
  let tx = 7_000_000;
  const unknownRefs: string[] = [];

  const deliver = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/hub/webhooks/flutterwave')
      .set('verif-hash', SECRET_HASH)
      .send(body as object);
  const charge = (reference: string, id: string, status = 'successful') => ({
    event: 'charge.completed',
    data: {
      id: Number(id),
      tx_ref: reference,
      status,
      amount: 2000,
      currency: 'NGN',
    },
  });
  const rowOf = (reference: string) =>
    prisma.waitlistRegistration.findUniqueOrThrow({ where: { reference } });

  async function registered() {
    n += 1;
    const res = await waitlist.register({
      offerId: OFFER_ID,
      fullName: `Hook Person ${n} ${MARK}`,
      phone: `+23481${String(20_000_000 + n).slice(-8)}`,
      email: `${MARK}-${n}@test.wawu.dev`,
      consent: true,
    });
    return res.reference;
  }
  const script = (
    reference: string,
    over: Partial<{
      status: 'successful' | 'failed';
      amount: number;
      currency: string;
      txRef: string;
    }> = {},
  ) => {
    tx += 1;
    fake.payments.set(String(tx), {
      status: 'successful',
      amount: config.eventOffers[0].priceKobo / 100,
      currency: 'NGN',
      txRef: reference,
      ...over,
    });
    return String(tx);
  };

  beforeAll(async () => {
    process.env.FLUTTERWAVE_SECRET_HASH = SECRET_HASH;
    config = configWith((raw) => {
      raw.event_offers = [openOffer()];
    });
    app = await bootWaitlist(config, fake, [
      WawuAuthModule,
      PaymentWebhookModule,
    ]);
    prisma = app.get(PrismaService);
    waitlist = app.get(WaitlistService);
    fetchSpy = jest.spyOn(global, 'fetch');
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
  }, 60_000);

  beforeEach(() => {
    fake.reset();
    fetchSpy.mockClear();
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    const rows = await prisma.waitlistRegistration.findMany({
      where: { fullName: { contains: MARK } },
      select: { reference: true },
    });
    await prisma.paymentWebhookReceipt.deleteMany({
      where: {
        OR: [
          { txRef: { in: rows.map((r) => r.reference) } },
          // The reference no registration has, delivered once by the spec.
          { txRef: { in: unknownRefs } },
        ],
      },
    });
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    fetchSpy.mockRestore();
    await app.close();
    if (saved === undefined) delete process.env.FLUTTERWAVE_SECRET_HASH;
    else process.env.FLUTTERWAVE_SECRET_HASH = saved;
  });

  it('a signed charge.completed for a registration whose payer never came back marks it paid, once', async () => {
    const ref = await registered();
    const id = script(ref);
    const res = await deliver(charge(ref, id)).expect(200);
    expect(res.body.data).toMatchObject({
      outcome: 'settled',
      flow: 'event-registration',
    });
    expect(await rowOf(ref)).toMatchObject({
      status: 'paid',
      flutterwaveTxId: id,
      paidKobo: config.eventOffers[0].priceKobo,
      claimedByWawuId: null,
    });
    // Flutterwave redelivers: nothing more happens, nothing is asked again.
    const calls = fake.verifyCalls.length;
    const again = await deliver(charge(ref, id)).expect(200);
    expect(again.body.data.outcome).toBe('duplicate');
    expect(fake.verifyCalls).toHaveLength(calls);
    // The browser comes back later with the same id: the same result.
    const view = await waitlist.verify({ reference: ref, transactionId: id });
    expect(view.status).toBe('paid');
  });

  it('asks Flutterwave itself and ignores what the payload says: a delivery claiming success for a payment Flutterwave reports as too small settles nothing', async () => {
    const ref = await registered();
    const id = script(ref, { amount: 1 });
    const res = await deliver(charge(ref, id)).expect(200);
    expect(res.body.data.outcome).toBe('rejected');
    expect(await rowOf(ref)).toMatchObject({
      status: 'pending',
      flutterwaveTxId: null,
    });
    expect(fake.verifyCalls.at(-1)).toEqual({ transactionId: id, txRef: ref });
  });

  it('a delivery for a payment that did not succeed settles nothing', async () => {
    const ref = await registered();
    const id = script(ref, { status: 'failed' });
    const res = await deliver(charge(ref, id, 'failed')).expect(200);
    expect(res.body.data.outcome).toBe('rejected');
    expect((await rowOf(ref)).status).toBe('pending');
  });

  it('a delivery for another reference or in dollars settles nothing, and an unknown reference is unmatched', async () => {
    const a = await registered();
    const b = await registered();
    const wrongRef = script(a, { txRef: b });
    expect(
      (await deliver(charge(a, wrongRef)).expect(200)).body.data.outcome,
    ).toBe('rejected');
    const dollars = script(b, { currency: 'USD' });
    expect(
      (await deliver(charge(b, dollars)).expect(200)).body.data.outcome,
    ).toBe('rejected');
    expect(await rowOf(a)).toMatchObject({ status: 'pending' });
    expect(await rowOf(b)).toMatchObject({ status: 'pending' });
    const unknown = newReference();
    unknownRefs.push(unknown);
    const res = await deliver(charge(unknown, script(unknown))).expect(200);
    expect(res.body.data.outcome).toBe('unmatched');
  });

  it('an unsigned or wrongly signed delivery is refused and settles nothing', async () => {
    const ref = await registered();
    const id = script(ref);
    await request(app.getHttpServer())
      .post('/api/hub/webhooks/flutterwave')
      .send(charge(ref, id))
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/hub/webhooks/flutterwave')
      .set('verif-hash', 'wrong')
      .send(charge(ref, id))
      .expect(401);
    expect((await rowOf(ref)).status).toBe('pending');
    expect(fake.verifyCalls).toHaveLength(0);
  });
});

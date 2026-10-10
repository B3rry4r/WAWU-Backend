// The spec reads response bodies and edits an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig } from '../../plans/plans-config';
import { WaitlistSweepService } from '../waitlist-sweep.service';
import {
  bootWaitlist,
  configWith,
  DAY,
  ScriptedFlutterwave,
  OFFER_ID,
  openOffer,
} from './waitlist-harness';

/**
 * JOIN-01 over HTTP: the four public routes of the event registration link on
 * the real WaitlistModule and a real database. Flutterwave is stood in at its
 * two seams (ScriptedFlutterwave); a fetch spy fails the run if anything reaches a
 * network host. Every figure compared with is read from the config, never
 * written here (the price can be changed by the owner).
 */

const MARK = 'join01-spec';
const PHONE_FORMS = [
  '08031234567',
  '8031234567',
  '2348031234567',
  '+2348031234567',
  '0803 123 4567',
  '+234 (803) 123-4567',
];
const E164 = '+2348031234567';

type Envelope<T> = { statusCode: number; message: string; data: T };
const data = <T = any>(res: Response): T => (res.body as Envelope<T>).data;
const reason = (res: Response) => res.body.reason;

describe('Event registration link (JOIN-01) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: PlansConfig;
  let sweep: WaitlistSweepService;
  const fake = new ScriptedFlutterwave();
  let fetchSpy: jest.SpyInstance;
  let n = 0;
  const http = () => request(app.getHttpServer());

  /** A distinct person every call, so no spec reads another's rows. */
  const person = (over: Record<string, unknown> = {}) => {
    n += 1;
    const tail = String(10_000_000 + n).slice(-8);
    return {
      offerId: OFFER_ID,
      fullName: `Tester ${n} ${MARK}`,
      phone: `+23480${tail}`,
      email: `${MARK}-${n}@test.wawu.dev`,
      consent: true,
      ...over,
    };
  };
  const register = (body: object) =>
    http().post('/api/hub/waitlist/registrations').send(body);
  const verify = (reference: string, transactionId: string) =>
    http()
      .post('/api/hub/waitlist/registrations/verify')
      .send({ reference, transactionId });
  const rowOf = (reference: string) =>
    prisma.waitlistRegistration.findUniqueOrThrow({ where: { reference } });

  let txSeq = 5_000_000;
  /** The payment Flutterwave would report for this reference, scripted under a fresh id. */
  const pay = (
    reference: string,
    over: Partial<{
      status: 'successful' | 'failed';
      amount: number;
      currency: string;
      txRef: string;
    }> = {},
  ) => {
    txSeq += 1;
    const id = String(txSeq);
    fake.payments.set(id, {
      status: 'successful',
      amount: config.eventOffers[0].priceKobo / 100,
      currency: 'NGN',
      txRef: reference,
      ...over,
    });
    return id;
  };

  /** Registers a new person and returns their start answer. */
  async function started(over: Record<string, unknown> = {}) {
    const body = person(over);
    const res = await register(body).expect(200);
    return { ...data(res), body };
  }

  const cleanUp = () =>
    prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });

  beforeAll(async () => {
    config = configWith((raw) => {
      raw.event_offers = [openOffer()];
    });
    app = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    sweep = app.get(WaitlistSweepService);
    fetchSpy = jest.spyOn(global, 'fetch');
    await cleanUp();
  }, 60_000);

  beforeEach(() => {
    fake.reset();
    fetchSpy.mockClear();
  });

  afterEach(() => {
    // Nothing under test may reach a network host (no Flutterwave, no AI).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    await cleanUp();
    fetchSpy.mockRestore();
    await app.close();
  });

  describe('GET /waitlist/offers/current', () => {
    it('answers the open offer from the config file: id, name, price in kobo, tier name, products, days, closing time', async () => {
      const res = await http()
        .get('/api/hub/waitlist/offers/current')
        .expect(200);
      const offer = config.eventOffers[0];
      const tier = config.tiers.find((t) => t.id === offer.tier)!;
      expect(data(res)).toEqual({
        id: offer.id,
        name: offer.name,
        priceKobo: offer.priceKobo,
        tierName: tier.name,
        products: tier.products,
        days: offer.tierDays,
        closesAt: offer.openUntil.toISOString(),
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers 404 no_open_offer when no offer is open: closed, not yet open, or none in the file', async () => {
      const now = Date.now();
      const shapes: [string, (raw: any) => void][] = [
        [
          'closed',
          (raw) =>
            (raw.event_offers = [
              openOffer({
                open_from: new Date(now - 9 * DAY).toISOString(),
                open_until: new Date(now - DAY).toISOString(),
              }),
            ]),
        ],
        [
          'not yet open',
          (raw) =>
            (raw.event_offers = [
              openOffer({
                open_from: new Date(now + DAY).toISOString(),
                open_until: new Date(now + 9 * DAY).toISOString(),
              }),
            ]),
        ],
        ['none', (raw) => (raw.event_offers = [])],
      ];
      for (const [label, edit] of shapes) {
        const other = await bootWaitlist(configWith(edit), fake);
        try {
          const res = await request(other.getHttpServer())
            .get('/api/hub/waitlist/offers/current')
            .expect(404);
          expect({ label, code: reason(res).code }).toEqual({
            label,
            code: 'no_open_offer',
          });
          expect(res.body.data).toBeNull();
        } finally {
          await other.close();
        }
      }
    });

    it('with two open offers it answers the one that closes first', async () => {
      const now = Date.now();
      const other = await bootWaitlist(
        configWith((raw) => {
          raw.event_offers = [
            openOffer({
              id: 'later',
              open_until: new Date(now + 9 * DAY).toISOString(),
            }),
            openOffer({
              id: 'sooner',
              open_until: new Date(now + 2 * DAY).toISOString(),
            }),
          ];
        }),
        fake,
      );
      try {
        const res = await request(other.getHttpServer())
          .get('/api/hub/waitlist/offers/current')
          .expect(200);
        expect(data(res).id).toBe('sooner');
      } finally {
        await other.close();
      }
    });
  });

  describe('POST /waitlist/registrations', () => {
    it('registers a new person: a random reference of at least 128 bits and a checkout whose amount and currency come from the config file', async () => {
      const s = await started();
      expect(s.reference).toMatch(/^wawu-join-[0-9a-f]{36}$/);
      expect(
        (s.reference.length - 'wawu-join-'.length) * 4,
      ).toBeGreaterThanOrEqual(128);
      const offer = config.eventOffers[0];
      expect(s.amountKobo).toBe(offer.priceKobo);
      expect(s.offerId).toBe(offer.id);
      expect(s.flutterwaveConfig).toEqual({
        publicKey: fake.publicKey,
        txRef: s.reference,
        amount: offer.priceKobo / 100,
        currency: 'NGN',
        customerName: s.body.fullName,
        customerEmail: s.body.email,
        customerPhone: s.body.phone,
      });
      const row = await rowOf(s.reference);
      expect(row).toMatchObject({
        status: 'pending',
        offerId: offer.id,
        amountKobo: offer.priceKobo,
        currency: 'NGN',
        flutterwaveTxId: null,
        paidKobo: null,
        paidAt: null,
        claimedByWawuId: null,
        claimedAt: null,
      });
      expect(row.consentAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('changing price_kobo and restarting changes the amount, with no code change', async () => {
      const dearer = configWith((raw) => {
        raw.event_offers = [openOffer({ price_kobo: 350_000 })];
      });
      const other = await bootWaitlist(dearer, fake);
      try {
        const res = await request(other.getHttpServer())
          .post('/api/hub/waitlist/registrations')
          .send(person())
          .expect(200);
        expect(data(res).amountKobo).toBe(350_000);
        expect(data(res).flutterwaveConfig.amount).toBe(3500);
        expect(
          (
            await request(other.getHttpServer())
              .get('/api/hub/waitlist/offers/current')
              .expect(200)
          ).body.data.priceKobo,
        ).toBe(350_000);
      } finally {
        await other.close();
      }
      // The first app, on the unchanged file, still asks the shipped figure.
      expect((await started()).amountKobo).toBe(
        config.eventOffers[0].priceKobo,
      );
    });

    it.each(PHONE_FORMS)(
      'stores the Nigerian number %s as +234 E.164',
      async (phone) => {
        const s = await started({
          phone,
          email: `${MARK}-form-${n}@test.wawu.dev`,
        });
        expect(s.flutterwaveConfig.customerPhone).toBe(E164);
        expect((await rowOf(s.reference)).phone).toBe(E164);
        await cleanUp();
      },
    );

    it('keeps a number from elsewhere in E.164 and refuses one that is no phone number', async () => {
      for (const [raw, stored] of [
        ['+44 7700 900123', '+447700900123'],
        ['0044 7700 900123', '+447700900123'],
        ['+1 (415) 555-0132', '+14155550132'],
      ]) {
        const s = await started({ phone: raw });
        expect((await rowOf(s.reference)).phone).toBe(stored);
      }
      for (const bad of [
        '12345',
        '07712345', // too short and not Nigerian
        '07700900123', // a UK local number has no country code: not accepted
        '+234 123 456',
        '+2340803123456',
        'call me',
        '+0123456789012',
      ]) {
        const res = await register(person({ phone: bad })).expect(400);
        expect({ bad, code: reason(res).code }).toEqual({
          bad,
          code: 'phone_invalid',
        });
      }
      await cleanUp();
    });

    it('lower-cases the email, and refuses one that is not an email', async () => {
      const s = await started({ email: `${MARK}-Mixed.Case@Test.WAWU.dev ` });
      expect((await rowOf(s.reference)).email).toBe(
        `${MARK}-mixed.case@test.wawu.dev`,
      );
      for (const bad of ['plain', 'a@b', 'a b@c.de', '@x.com', 'a@@x.com']) {
        const res = await register(person({ email: bad })).expect(400);
        expect({ bad, code: reason(res).code }).toEqual({
          bad,
          code: 'email_invalid',
        });
      }
    });

    it('takes optional state and what they make, trimmed, and refuses text over 60 characters', async () => {
      const s = await started({
        state: '  Lagos ',
        makes: ' Fashion   and  tailoring ',
      });
      const row = await rowOf(s.reference);
      expect([row.state, row.makes]).toEqual([
        'Lagos',
        'Fashion and tailoring',
      ]);
      const plain = await started();
      expect([
        (await rowOf(plain.reference)).state,
        (await rowOf(plain.reference)).makes,
      ]).toEqual([null, null]);
      await register(person({ state: 'x'.repeat(61) })).expect(400);
      await register(person({ makes: 'y'.repeat(61) })).expect(400);
    });

    it('requires the consent and a full name', async () => {
      for (const consent of [false, undefined]) {
        const res = await register(person({ consent })).expect(400);
        if (consent === false)
          expect(reason(res).code).toBe('consent_required');
      }
      const res = await register(person({ fullName: '  a ' })).expect(400);
      expect(reason(res).code).toBe('name_invalid');
    });

    it('refuses a body with a field it does not know and one with the wrong kind of value', async () => {
      await register({ ...person(), claimedByWawuId: 'x' }).expect(400);
      await register({ ...person(), phone: 8031234567 }).expect(400);
      await register({}).expect(400);
    });

    it("reuses this person's own unpaid row instead of piling up duplicates, and refreshes what they typed", async () => {
      const first = await started({ state: 'Lagos' });
      const again = await register({
        ...first.body,
        fullName: `Corrected Name ${MARK}`,
        state: 'Abuja',
      }).expect(200);
      expect(data(again).reference).toBe(first.reference);
      const rows = await prisma.waitlistRegistration.findMany({
        where: { phone: first.body.phone, offerId: OFFER_ID },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fullName: `Corrected Name ${MARK}`,
        state: 'Abuja',
        status: 'pending',
      });
      // Same phone, another email: another person, another row.
      const other = await register({
        ...first.body,
        email: `${MARK}-other-${n}@test.wawu.dev`,
      }).expect(200);
      expect(data(other).reference).not.toBe(first.reference);
    });

    it('refuses with 409 offer_closed when the offer has closed or has not opened, and writes nothing', async () => {
      const now = Date.now();
      for (const [label, window] of [
        [
          'closed',
          {
            open_from: new Date(now - 9 * DAY).toISOString(),
            open_until: new Date(now - 1000).toISOString(),
          },
        ],
        [
          'not yet open',
          {
            open_from: new Date(now + DAY).toISOString(),
            open_until: new Date(now + 9 * DAY).toISOString(),
          },
        ],
      ] as const) {
        const other = await bootWaitlist(
          configWith((raw) => (raw.event_offers = [openOffer(window)])),
          fake,
        );
        try {
          const body = person();
          const res = await request(other.getHttpServer())
            .post('/api/hub/waitlist/registrations')
            .send(body)
            .expect(409);
          expect({ label, code: reason(res).code }).toEqual({
            label,
            code: 'offer_closed',
          });
          expect(
            await prisma.waitlistRegistration.count({
              where: { email: body.email },
            }),
          ).toBe(0);
        } finally {
          await other.close();
        }
      }
      expect(fake.initCalls).toHaveLength(0);
    });

    it('answers 404 no_open_offer for an offer id the file does not have, and writes nothing', async () => {
      const body = person({ offerId: 'no-such-offer' });
      const res = await register(body).expect(404);
      expect(reason(res).code).toBe('no_open_offer');
      expect(
        await prisma.waitlistRegistration.count({
          where: { email: body.email },
        }),
      ).toBe(0);
    });

    it('answers 503 payments_unavailable, and writes nothing, when there is no checkout public key', async () => {
      fake.publicKey = '';
      try {
        const body = person();
        const res = await register(body).expect(503);
        expect(reason(res).code).toBe('payments_unavailable');
        expect(
          await prisma.waitlistRegistration.count({
            where: { email: body.email },
          }),
        ).toBe(0);
      } finally {
        fake.publicKey = 'FLWPUBK_TEST-join01-spec-X';
      }
    });
  });

  describe('POST /waitlist/registrations/verify', () => {
    it('a correct payment marks the registration paid; verifying twice answers the same and asks Flutterwave once', async () => {
      const s = await started({ fullName: `Ada Obi ${MARK}` });
      const tx = pay(s.reference);
      const first = await verify(s.reference, tx).expect(200);
      expect(data(first)).toEqual({
        reference: s.reference,
        status: 'paid',
        firstName: s.body.fullName.split(' ')[0],
      });
      const row = await rowOf(s.reference);
      expect(row).toMatchObject({
        status: 'paid',
        flutterwaveTxId: tx,
        paidKobo: config.eventOffers[0].priceKobo,
        claimedByWawuId: null,
        claimedAt: null,
      });
      expect(row.paidAt).toBeInstanceOf(Date);
      const second = await verify(s.reference, tx).expect(200);
      expect(data(second)).toEqual(data(first));
      // Another transaction id on an already paid registration answers the same too.
      const third = await verify(s.reference, '999999999').expect(200);
      expect(data(third)).toEqual(data(first));
      expect(fake.verifyCalls).toHaveLength(1);
      expect(fake.verifyCalls[0]).toEqual({
        transactionId: tx,
        txRef: s.reference,
      });
      expect((await rowOf(s.reference)).paidAt).toEqual(row.paidAt);
    });

    it('a payment for less than the fee is refused 422 payment_mismatch and the row stays pending', async () => {
      const s = await started();
      const fee = config.eventOffers[0].priceKobo / 100;
      for (const amount of [fee - 0.01, fee - 1, 1, 0]) {
        const res = await verify(
          s.reference,
          pay(s.reference, { amount }),
        ).expect(422);
        expect({ amount, code: reason(res).code }).toEqual({
          amount,
          code: 'payment_mismatch',
        });
      }
      expect(await rowOf(s.reference)).toMatchObject({
        status: 'pending',
        flutterwaveTxId: null,
        paidKobo: null,
        paidAt: null,
      });
    });

    it('a payment in another currency, with another tx_ref, or for an amount that is not whole kobo is refused and the row stays pending', async () => {
      const s = await started();
      const other = await started();
      const fee = config.eventOffers[0].priceKobo / 100;
      for (const over of [
        { currency: 'USD' },
        { currency: 'GHS' },
        { currency: '' },
        { txRef: other.reference },
        { txRef: 'someone-elses-reference' },
        { txRef: '' },
        { amount: fee + 0.001 },
        { amount: Number.NaN },
        { amount: -fee },
      ]) {
        const res = await verify(s.reference, pay(s.reference, over)).expect(
          422,
        );
        expect({ over, code: reason(res).code }).toEqual({
          over,
          code: 'payment_mismatch',
        });
      }
      expect(await rowOf(s.reference)).toMatchObject({
        status: 'pending',
        flutterwaveTxId: null,
      });
      expect(await rowOf(other.reference)).toMatchObject({
        status: 'pending',
        flutterwaveTxId: null,
      });
    });

    it('a payment Flutterwave does not say succeeded is 409 payment_not_confirmed and the row stays pending, so the check can be tried again', async () => {
      const s = await started();
      const tx = pay(s.reference, { status: 'failed' });
      const res = await verify(s.reference, tx).expect(409);
      expect(reason(res).code).toBe('payment_not_confirmed');
      expect((await rowOf(s.reference)).status).toBe('pending');
      // The same id, now succeeded: the retry settles it.
      fake.payments.set(tx, {
        status: 'successful',
        amount: config.eventOffers[0].priceKobo / 100,
        currency: 'NGN',
        txRef: s.reference,
      });
      await verify(s.reference, tx).expect(200);
      expect((await rowOf(s.reference)).status).toBe('paid');
    });

    it('a transaction Flutterwave cannot be asked about is 503 payment_check_unavailable and changes nothing', async () => {
      const s = await started();
      const res = await verify(s.reference, '424242424242').expect(503);
      expect(reason(res).code).toBe('payment_check_unavailable');
      expect(await rowOf(s.reference)).toMatchObject({
        status: 'pending',
        flutterwaveTxId: null,
      });
    });

    it('a correct payment after refused ones still settles', async () => {
      const s = await started();
      await verify(s.reference, pay(s.reference, { amount: 1 })).expect(422);
      await verify(s.reference, pay(s.reference, { currency: 'USD' })).expect(
        422,
      );
      await verify(s.reference, pay(s.reference)).expect(200);
      expect((await rowOf(s.reference)).status).toBe('paid');
    });

    it('a payment above the fee is accepted and the amount Flutterwave confirmed is recorded', async () => {
      const s = await started();
      const fee = config.eventOffers[0].priceKobo / 100;
      await verify(s.reference, pay(s.reference, { amount: fee + 500 })).expect(
        200,
      );
      expect(await rowOf(s.reference)).toMatchObject({
        status: 'paid',
        paidKobo: (fee + 500) * 100,
        amountKobo: fee * 100,
      });
    });

    it('a transaction id that already paid one registration is refused on another: 409 transaction_already_used, and the other stays pending', async () => {
      const a = await started();
      const b = await started();
      const tx = pay(a.reference);
      await verify(a.reference, tx).expect(200);
      // Flutterwave (stood in) even claims the same transaction is B's: the id is still spent.
      fake.payments.set(tx, {
        status: 'successful',
        amount: config.eventOffers[0].priceKobo / 100,
        currency: 'NGN',
        txRef: b.reference,
      });
      const res = await verify(b.reference, tx).expect(409);
      expect(reason(res).code).toBe('transaction_already_used');
      expect(await rowOf(b.reference)).toMatchObject({
        status: 'pending',
        flutterwaveTxId: null,
      });
      expect((await rowOf(a.reference)).flutterwaveTxId).toBe(tx);
    });

    it('an unknown or malformed reference is 404 not_found, the same answer for every miss', async () => {
      const bodies: string[] = [];
      for (const reference of [
        'wawu-join-' + '0'.repeat(36),
        'nonsense',
        'x'.repeat(99),
        '../etc/passwd',
      ]) {
        const res = await verify(reference, '12345').expect(404);
        expect(reason(res).code).toBe('not_found');
        bodies.push(JSON.stringify(res.body));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(fake.verifyCalls).toHaveLength(0);
    });

    it('refuses a transaction id that is not digits, and a missing field', async () => {
      const s = await started();
      for (const transactionId of [
        'abc',
        '12 34',
        '',
        '1'.repeat(21),
        '../1',
      ]) {
        await verify(s.reference, transactionId).expect(400);
      }
      await http()
        .post('/api/hub/waitlist/registrations/verify')
        .send({ reference: s.reference })
        .expect(400);
      expect(fake.verifyCalls).toHaveLength(0);
    });

    it('a payment made after the offer closed still counts (the person already paid)', async () => {
      const now = Date.now();
      const open = await bootWaitlist(
        configWith(
          (raw) =>
            (raw.event_offers = [
              openOffer({ open_until: new Date(now + 2000).toISOString() }),
            ]),
        ),
        fake,
      );
      try {
        const http2 = () => request(open.getHttpServer());
        const body = person();
        const start = data(
          await http2()
            .post('/api/hub/waitlist/registrations')
            .send(body)
            .expect(200),
        );
        await new Promise((r) => setTimeout(r, 2300));
        await http2()
          .post('/api/hub/waitlist/registrations')
          .send(person())
          .expect(409);
        await http2()
          .post('/api/hub/waitlist/registrations/verify')
          .send({
            reference: start.reference,
            transactionId: pay(start.reference),
          })
          .expect(200);
        expect((await rowOf(start.reference)).status).toBe('paid');
      } finally {
        await open.close();
      }
    });

    it('two simultaneous verifies of one registration settle it once and both answer paid', async () => {
      const s = await started();
      const tx = pay(s.reference);
      const [x, y, z] = await Promise.all([
        verify(s.reference, tx),
        verify(s.reference, tx),
        verify(s.reference, tx),
      ]);
      expect([x.status, y.status, z.status]).toEqual([200, 200, 200]);
      expect([data(x).status, data(y).status, data(z).status]).toEqual([
        'paid',
        'paid',
        'paid',
      ]);
      expect(
        await prisma.waitlistRegistration.count({
          where: { flutterwaveTxId: tx },
        }),
      ).toBe(1);
    });
  });

  describe('a phone or email that already paid', () => {
    it('is refused before any charge (409 already_registered) in every Nigerian phone form and any email letter case', async () => {
      const s = await started({
        phone: '08031234567',
        email: `${MARK}-Paid@Test.wawu.dev`,
      });
      await verify(s.reference, pay(s.reference)).expect(200);
      const before = await prisma.waitlistRegistration.count({
        where: { offerId: OFFER_ID },
      });
      fake.initCalls = [];
      for (const phone of PHONE_FORMS) {
        const res = await register(person({ phone })).expect(409);
        expect({ phone, code: reason(res).code }).toEqual({
          phone,
          code: 'already_registered',
        });
      }
      for (const email of [
        `${MARK}-paid@test.wawu.dev`,
        `${MARK}-PAID@TEST.WAWU.DEV`,
        ` ${MARK}-Paid@Test.wawu.dev`,
      ]) {
        const res = await register(person({ email })).expect(409);
        expect({ email, code: reason(res).code }).toEqual({
          email,
          code: 'already_registered',
        });
      }
      expect(
        await prisma.waitlistRegistration.count({
          where: { offerId: OFFER_ID },
        }),
      ).toBe(before);
      expect(fake.initCalls).toHaveLength(0);
      // The same person, same details, registering again is told too.
      await register({ ...s.body }).expect(409);
      await cleanUp();
    });

    it('two simultaneous paid verifies for the same phone leave one paid row; the second payment is kept as failed with its transaction id for a refund', async () => {
      const phone = '+2348039990001';
      const a = await started({ phone, email: `${MARK}-race-a@test.wawu.dev` });
      const b = await started({ phone, email: `${MARK}-race-b@test.wawu.dev` });
      const txA = pay(a.reference);
      const txB = pay(b.reference);
      const [ra, rb] = await Promise.all([
        verify(a.reference, txA),
        verify(b.reference, txB),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      const failed = ra.status === 409 ? ra : rb;
      expect(reason(failed).code).toBe('already_registered');
      const rows = await prisma.waitlistRegistration.findMany({
        where: { phone, offerId: OFFER_ID },
      });
      expect(rows.filter((r) => r.status === 'paid')).toHaveLength(1);
      const dup = rows.find((r) => r.status === 'failed')!;
      expect(dup).toMatchObject({ paidKobo: config.eventOffers[0].priceKobo });
      expect(dup.flutterwaveTxId).toBe(
        dup.reference === a.reference ? txA : txB,
      );
      // The failed row can be listed for a refund, and is never dropped by the unpaid purge.
      await prisma.waitlistRegistration.updateMany({
        where: { id: dup.id },
        data: { createdAt: new Date(Date.now() - 30 * DAY) },
      });
      await sweep.purgeUnpaid();
      expect(
        await prisma.waitlistRegistration.count({ where: { id: dup.id } }),
      ).toBe(1);
    });

    it('two simultaneous paid verifies for the same email leave one paid row', async () => {
      const email = `${MARK}-race-email@test.wawu.dev`;
      const a = await started({ email });
      const b = await started({ email });
      const [ra, rb] = await Promise.all([
        verify(a.reference, pay(a.reference)),
        verify(b.reference, pay(b.reference)),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      expect(
        await prisma.waitlistRegistration.count({
          where: { email, status: 'paid' },
        }),
      ).toBe(1);
    });

    it('the database itself refuses a second paid row for the same offer and phone, or offer and email', async () => {
      const a = await started();
      const b = await started();
      await verify(a.reference, pay(a.reference)).expect(200);
      const attempt = (data: object) =>
        prisma.waitlistRegistration.update({
          where: { reference: b.reference },
          data: {
            status: 'paid',
            flutterwaveTxId: `direct-${++txSeq}`,
            paidKobo: 1,
            paidAt: new Date(),
            ...data,
          },
        });
      await expect(attempt({ phone: a.body.phone })).rejects.toMatchObject({
        code: 'P2002',
      });
      await expect(attempt({ email: a.body.email })).rejects.toMatchObject({
        code: 'P2002',
      });
      expect((await rowOf(b.reference)).status).toBe('pending');
    });
  });

  describe('GET /waitlist/registrations/:reference', () => {
    it('shows the status and first name only, never a phone or an email', async () => {
      const s = await started({
        fullName: `Ngozi Okafor ${MARK}`,
        phone: '+2348037770001',
        email: `${MARK}-status@test.wawu.dev`,
      });
      const res = await http()
        .get(`/api/hub/waitlist/registrations/${s.reference}`)
        .expect(200);
      expect(data(res)).toEqual({
        reference: s.reference,
        status: 'pending',
        firstName: 'Ngozi',
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/8037770001|status@test|test\.wawu|@/);
      expect(res.headers['cache-control']).toBe('no-store');
      await verify(s.reference, pay(s.reference)).expect(200);
      const paid = await http()
        .get(`/api/hub/waitlist/registrations/${s.reference}`)
        .expect(200);
      expect(data(paid)).toEqual({
        reference: s.reference,
        status: 'paid',
        firstName: 'Ngozi',
      });
      expect(JSON.stringify(paid.body)).not.toMatch(/8037770001|@/);
    });

    it('an unknown reference is 404 with the same body as a malformed one, and says nothing about whether it exists', async () => {
      const a = await http()
        .get(`/api/hub/waitlist/registrations/wawu-join-${'a'.repeat(36)}`)
        .expect(404);
      const b = await http()
        .get('/api/hub/waitlist/registrations/not-a-reference')
        .expect(404);
      const c = await http()
        .get(`/api/hub/waitlist/registrations/${'z'.repeat(500)}`)
        .expect(404);
      expect(reason(a).code).toBe('not_found');
      expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
      expect(JSON.stringify(a.body)).toBe(JSON.stringify(c.body));
    });
  });

  describe('payers who never came back', () => {
    const aged = (reference: string, minutes: number) =>
      prisma.waitlistRegistration.update({
        where: { reference },
        data: { createdAt: new Date(Date.now() - minutes * 60_000) },
      });
    const lookup = (reference: string, over: Record<string, unknown> = {}) =>
      fake.byReference.set(reference, {
        id: String(++txSeq),
        status: 'successful',
        amount: config.eventOffers[0].priceKobo / 100,
        currency: 'NGN',
        txRef: reference,
        ...over,
      });

    it('finds a pending row whose payer never came back and marks it paid, with the same checks as a browser verify', async () => {
      const s = await started();
      await aged(s.reference, 12);
      lookup(s.reference);
      expect(await sweep.recheckPending()).toEqual(
        expect.objectContaining({ paid: 1 }),
      );
      const row = await rowOf(s.reference);
      expect(row).toMatchObject({
        status: 'paid',
        paidKobo: config.eventOffers[0].priceKobo,
        claimedByWawuId: null,
      });
      expect(row.flutterwaveTxId).toBe(fake.byReference.get(s.reference)!.id);
      // Idempotent: a second pass changes nothing and asks nothing more about it.
      fake.lookupCalls = [];
      await sweep.recheckPending();
      expect(fake.lookupCalls).not.toContain(s.reference);
      expect((await rowOf(s.reference)).paidAt).toEqual(row.paidAt);
    });

    it('marks nothing paid unless Flutterwave says it succeeded for the right amount, in naira, under this reference', async () => {
      const fee = config.eventOffers[0].priceKobo / 100;
      const cases: [string, Record<string, unknown>][] = [
        ['failed', { status: 'failed' }],
        ['too little', { amount: fee - 1 }],
        ['dollars', { currency: 'USD' }],
        ['another reference', { txRef: 'wawu-join-' + 'f'.repeat(36) }],
        ['no reference', { txRef: '' }],
      ];
      const refs: string[] = [];
      for (const [, over] of cases) {
        const s = await started();
        await aged(s.reference, 12);
        lookup(s.reference, over);
        refs.push(s.reference);
      }
      const nothing = await started();
      await aged(nothing.reference, 12);
      refs.push(nothing.reference);
      const result = await sweep.recheckPending();
      expect(result.paid).toBe(0);
      for (const ref of refs)
        expect(await rowOf(ref)).toMatchObject({
          status: 'pending',
          flutterwaveTxId: null,
        });
    });

    it('looks only at rows older than a few minutes and younger than 48 hours', async () => {
      const young = await started();
      const old = await started();
      const inWindow = await started();
      await aged(young.reference, 1);
      await aged(old.reference, 49 * 60);
      await aged(inWindow.reference, 60);
      for (const r of [young, old, inWindow]) lookup(r.reference);
      await sweep.recheckPending();
      expect((await rowOf(young.reference)).status).toBe('pending');
      expect((await rowOf(old.reference)).status).toBe('pending');
      expect((await rowOf(inWindow.reference)).status).toBe('paid');
      expect(fake.lookupCalls).not.toContain(young.reference);
      expect(fake.lookupCalls).not.toContain(old.reference);
    });

    it('one row Flutterwave cannot be asked about does not stop the others', async () => {
      const bad = await started();
      const good = await started();
      await aged(bad.reference, 30);
      await aged(good.reference, 20);
      fake.lookupFails.add(bad.reference);
      lookup(good.reference);
      await sweep.recheckPending();
      expect((await rowOf(bad.reference)).status).toBe('pending');
      expect((await rowOf(good.reference)).status).toBe('paid');
    });

    it('a reference whose transaction id already paid another registration is refused and stays pending', async () => {
      const a = await started();
      const b = await started();
      const tx = pay(a.reference);
      await verify(a.reference, tx).expect(200);
      await aged(b.reference, 30);
      fake.byReference.set(b.reference, {
        id: tx,
        status: 'successful',
        amount: config.eventOffers[0].priceKobo / 100,
        currency: 'NGN',
        txRef: b.reference,
      });
      await sweep.recheckPending();
      expect(await rowOf(b.reference)).toMatchObject({
        status: 'pending',
        flutterwaveTxId: null,
      });
    });
  });

  describe('unpaid rows are not kept', () => {
    it('deletes pending rows older than 7 days and keeps younger pending rows, paid rows and failed rows of any age', async () => {
      const oldPending = await started();
      const youngPending = await started();
      const oldPaid = await started();
      await verify(oldPaid.reference, pay(oldPaid.reference)).expect(200);
      await prisma.waitlistRegistration.update({
        where: { reference: oldPending.reference },
        data: { createdAt: new Date(Date.now() - 8 * DAY) },
      });
      await prisma.waitlistRegistration.update({
        where: { reference: youngPending.reference },
        data: { createdAt: new Date(Date.now() - 6 * DAY) },
      });
      await prisma.waitlistRegistration.update({
        where: { reference: oldPaid.reference },
        data: { createdAt: new Date(Date.now() - 40 * DAY) },
      });
      expect(await sweep.purgeUnpaid()).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.waitlistRegistration.count({
          where: { reference: oldPending.reference },
        }),
      ).toBe(0);
      expect(
        await prisma.waitlistRegistration.count({
          where: { reference: youngPending.reference },
        }),
      ).toBe(1);
      expect(
        await prisma.waitlistRegistration.count({
          where: { reference: oldPaid.reference },
        }),
      ).toBe(1);
    });
  });

  describe('the registration table', () => {
    it('refuses a reference shorter than 32 characters, an upper-case email, a paid row with no transaction and a half claim', async () => {
      const base = {
        offerId: OFFER_ID,
        fullName: `Direct ${MARK}`,
        phone: '+2348031110000',
        consentAt: new Date(),
        amountKobo: 1,
      };
      const make = (over: object) =>
        prisma.waitlistRegistration.create({
          data: {
            ...base,
            email: `${MARK}-direct@test.wawu.dev`,
            reference: `direct-${'r'.repeat(32)}-${++txSeq}`,
            ...over,
          },
        });
      await expect(make({ reference: 'short' })).rejects.toThrow();
      await expect(make({ email: 'UPPER@test.wawu.dev' })).rejects.toThrow();
      await expect(make({ status: 'paid' })).rejects.toThrow();
      await expect(make({ claimedByWawuId: 'someone' })).rejects.toThrow();
      await expect(make({ amountKobo: 0 })).rejects.toThrow();
      await expect(make({ currency: 'USD' })).rejects.toThrow();
      expect(
        await prisma.waitlistRegistration.count({
          where: { fullName: `Direct ${MARK}` },
        }),
      ).toBe(0);
    });
  });
});

// The spec reads response bodies and edits an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig } from '../../plans/plans-config';
import { WaitlistService } from '../waitlist.service';
import {
  RECHECK_AFTER_MS,
  RECHECK_PAGE,
  RECHECK_UNTIL_MS,
} from '../waitlist-config';
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

/** The two refusals a person reads when this phone or email already paid (R-48). */
const BEFORE_CHARGE_WORDS =
  'You are already registered for this event. You have not been charged again.';
const AFTER_CHARGE_WORDS =
  "You're already registered. This extra payment will be refunded. Email support@wawuafrica.com with your reference.";

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
        closesAt: offer.openUntil!.toISOString(),
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

    it('an offer with no open_until (absent or null) is open from open_from with no end: closesAt is null', async () => {
      const now = Date.now();
      for (const [label, over] of [
        ['absent', { open_until: undefined }],
        ['null', { open_until: null }],
      ] as const) {
        const other = await bootWaitlist(
          configWith((raw) => (raw.event_offers = [openOffer(over)])),
          fake,
        );
        try {
          const res = await request(other.getHttpServer())
            .get('/api/hub/waitlist/offers/current')
            .expect(200);
          expect({ label, offer: data(res) }).toEqual({
            label,
            offer: expect.objectContaining({ id: OFFER_ID, closesAt: null }),
          });
          // Open forever after open_from: still open a century from now, and
          // a registration then is taken (the service takes the moment).
          const service = other.get(WaitlistService);
          const later = new Date(now + 100 * 365 * DAY);
          expect(service.currentOffer(later).closesAt).toBeNull();
          const started = await service.register(person(), later);
          expect(started.reference).toMatch(/^wawu-join-[0-9a-f]{36}$/);
        } finally {
          await other.close();
        }
      }
    });

    it('an offer with no open_until is still not open before open_from', async () => {
      const now = Date.now();
      const other = await bootWaitlist(
        configWith(
          (raw) =>
            (raw.event_offers = [
              openOffer({
                open_from: new Date(now + DAY).toISOString(),
                open_until: undefined,
              }),
            ]),
        ),
        fake,
      );
      try {
        const res = await request(other.getHttpServer())
          .get('/api/hub/waitlist/offers/current')
          .expect(404);
        expect(reason(res).code).toBe('no_open_offer');
        await request(other.getHttpServer())
          .post('/api/hub/waitlist/registrations')
          .send(person())
          .expect(409);
      } finally {
        await other.close();
      }
    });

    it('with one offer that closes and one with no closing date, the one that closes is answered first, and the other once it has closed', async () => {
      const now = Date.now();
      const other = await bootWaitlist(
        configWith((raw) => {
          raw.event_offers = [
            openOffer({ id: 'forever', open_until: undefined }),
            openOffer({
              id: 'dated',
              open_until: new Date(now + 2 * DAY).toISOString(),
            }),
          ];
        }),
        fake,
      );
      try {
        const service = other.get(WaitlistService);
        expect(service.currentOffer(new Date(now)).id).toBe('dated');
        const after = service.currentOffer(new Date(now + 3 * DAY));
        expect([after.id, after.closesAt]).toEqual(['forever', null]);
      } finally {
        await other.close();
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

    it.each([
      ['a NUL byte', '\u0000'],
      ['a bell', '\u0007'],
      ['a tab', '\t'],
      ['a line feed', '\n'],
      ['a carriage return', '\r'],
      ['the last control character, U+001F', '\u001f'],
    ])(
      'refuses %s in the name, email, state or what they make as a 400 field error in plain words, never a 500, and writes nothing',
      async (_label, ch) => {
        const rowsBefore = await prisma.waitlistRegistration.count({
          where: { fullName: { contains: MARK } },
        });
        const wordsOf = (res: Response) => String(res.body.message);
        const name = person({ fullName: `Ada${ch} Okafor ${MARK}` });
        const nameRes = await register(name).expect(400);
        expect(reason(nameRes).code).toBe('name_invalid');
        expect(wordsOf(nameRes)).toMatch(/name/i);

        const mail = person();
        mail.email = `a${ch}b-${n}@test.wawu.dev`;
        const mailRes = await register(mail).expect(400);
        expect(reason(mailRes).code).toBe('email_invalid');
        // An email that ENDS with the character is refused too (it is not trimmed away).
        const mailEnd = person();
        mailEnd.email = `${MARK}-end-${n}@test.wawu.dev${ch}`;
        expect(reason(await register(mailEnd).expect(400)).code).toBe(
          'email_invalid',
        );

        const stateRes = await register(person({ state: `Lag${ch}os` })).expect(
          400,
        );
        expect(stateRes.body.reason).toBeUndefined();
        expect(wordsOf(stateRes)).toMatch(/state/i);
        const makesRes = await register(person({ makes: `sho${ch}es` })).expect(
          400,
        );
        expect(makesRes.body.reason).toBeUndefined();
        expect(wordsOf(makesRes)).toMatch(/make/i);

        for (const res of [nameRes, mailRes, stateRes, makesRes]) {
          expect(res.body.data).toBeNull();
          // Plain words: no control character is echoed back, and no stack or database word.
          expect(wordsOf(res)).not.toMatch(
            // eslint-disable-next-line no-control-regex
            /[\u0000-\u001f]|prisma|postgres|invalid byte/i,
          );
        }
        // Not one of the attempts wrote a row (every attempt carries the mark in its name).
        expect(
          await prisma.waitlistRegistration.count({
            where: { fullName: { contains: MARK } },
          }),
        ).toBe(rowsBefore);
        expect(fake.initCalls).toHaveLength(0);
      },
    );

    it('still takes ordinary spaces, accents, apostrophes and emoji in the name (nothing at or above U+0020 is refused)', async () => {
      const s = await started({
        fullName: `Chidi O'Neil-Adé 😀 ${MARK}`,
        state: 'Akwa Ibom',
        makes: 'Ankara & lace',
      });
      expect(await rowOf(s.reference)).toMatchObject({
        fullName: `Chidi O'Neil-Adé 😀 ${MARK}`,
        state: 'Akwa Ibom',
        makes: 'Ankara & lace',
      });
    });

    it('refuses a body with a field it does not know and one with the wrong kind of value', async () => {
      await register({ ...person(), claimedByWawuId: 'x' }).expect(400);
      await register({ ...person(), phone: 8031234567 }).expect(400);
      await register({}).expect(400);
    });

    it('every start is a new registration: the same details twice give two rows with two different references, and the first row is not touched', async () => {
      const first = await started({ state: 'Lagos' });
      const before = await rowOf(first.reference);
      const again = data(
        await register({
          ...first.body,
          fullName: `Corrected Name ${MARK}`,
          state: 'Abuja',
        }).expect(200),
      );
      expect(again.reference).not.toBe(first.reference);
      expect(again.reference).toMatch(/^wawu-join-[0-9a-f]{36}$/);
      // Each checkout carries its own reference as the Flutterwave tx_ref.
      expect(first.flutterwaveConfig.txRef).toBe(first.reference);
      expect(again.flutterwaveConfig.txRef).toBe(again.reference);
      const rows = await prisma.waitlistRegistration.findMany({
        where: { phone: first.body.phone, offerId: OFFER_ID },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => [r.reference, r.status])).toEqual([
        [first.reference, 'pending'],
        [again.reference, 'pending'],
      ]);
      expect(rows[1]).toMatchObject({
        fullName: `Corrected Name ${MARK}`,
        state: 'Abuja',
      });
      // Nothing the second start did touched the first row: not what was
      // typed, not the time it was made (a reused row kept its first
      // createdAt, which the re-check window and the purge both count from).
      expect(await rowOf(first.reference)).toEqual(before);
      expect(rows[0].createdAt.getTime()).toBeLessThan(
        rows[1].createdAt.getTime(),
      );
      // Same phone, another email: another person, as before.
      const other = await register({
        ...first.body,
        email: `${MARK}-other-${n}@test.wawu.dev`,
      }).expect(200);
      expect(data(other).reference).not.toBe(first.reference);
      expect(data(other).reference).not.toBe(again.reference);
    });

    it("a start after the price was changed asks today's fee on its own new row, and the earlier row keeps the fee it asked", async () => {
      const first = await started();
      expect(first.amountKobo).toBe(config.eventOffers[0].priceKobo);
      const dearer = configWith((raw) => {
        raw.event_offers = [openOffer({ price_kobo: 350_000 })];
      });
      const other = await bootWaitlist(dearer, fake);
      try {
        const again = data(
          await request(other.getHttpServer())
            .post('/api/hub/waitlist/registrations')
            .send(first.body)
            .expect(200),
        );
        // A new row asking the new figure everywhere; the first is as it was.
        expect(again.reference).not.toBe(first.reference);
        expect(again.amountKobo).toBe(350_000);
        expect(again.flutterwaveConfig.amount).toBe(3500);
        expect((await rowOf(again.reference)).amountKobo).toBe(350_000);
        expect((await rowOf(first.reference)).amountKobo).toBe(
          config.eventOffers[0].priceKobo,
        );
        // And that figure is what a payment on the new row must meet.
        const short = pay(again.reference, { amount: 2000 });
        const res = await request(other.getHttpServer())
          .post('/api/hub/waitlist/registrations/verify')
          .send({ reference: again.reference, transactionId: short })
          .expect(422);
        expect(reason(res).code).toBe('payment_mismatch');
      } finally {
        await other.close();
      }
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

    it('a reference that is not exactly what this server issues is the same 404 as an unknown one, whatever the odd character (a NUL byte was a 500)', async () => {
      const unknown = await verify(
        'wawu-join-' + '0'.repeat(36),
        '12345',
      ).expect(404);
      for (const reference of [
        'wawu-join-' + 'a'.repeat(36) + '\u0000',
        'wawu-join-' + 'a'.repeat(30) + '\u0000',
        '\u0000',
        'wawu-join-' + 'A'.repeat(36),
        'wawu-join-' + 'a'.repeat(35),
        'wawu-join-' + 'a'.repeat(37),
        'wawu-join-' + 'g'.repeat(36),
        'wawu-join-' + 'a'.repeat(36) + '\n',
        ' wawu-join-' + 'a'.repeat(36),
        'wawu-join-' + 'a'.repeat(34) + '\u001fa',
      ]) {
        const res = await verify(reference, '12345').expect(404);
        expect(JSON.stringify(res.body)).toBe(JSON.stringify(unknown.body));
      }
      expect(fake.verifyCalls).toHaveLength(0);
    });

    it('the paid row keeps the transaction id Flutterwave reports, not the one the browser sent', async () => {
      const s = await started();
      const sent = pay(s.reference);
      const reported = String(++txSeq);
      fake.payments.get(sent)!.id = reported;
      await verify(s.reference, sent).expect(200);
      const row = await rowOf(s.reference);
      expect(row.flutterwaveTxId).toBe(reported);
      expect(row.flutterwaveTxId).not.toBe(sent);
    });

    it('a verify that read the row while it was pending cannot overwrite the payment another verify settled first: the first transaction id and paid time stay', async () => {
      const s = await started();
      const first = pay(s.reference);
      const behind = pay(s.reference);
      let release!: () => void;
      fake.holds.set(
        behind,
        new Promise<void>((resolve) => (release = resolve)),
      );
      // This call reads the row (pending) and then waits inside Flutterwave's answer.
      const slow = verify(s.reference, behind).then((res) => res);
      for (let i = 0; i < 200; i++) {
        if (fake.verifyCalls.some((c) => c.transactionId === behind)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fake.verifyCalls.some((c) => c.transactionId === behind)).toBe(
        true,
      );
      // The other one settles the registration meanwhile.
      await verify(s.reference, first).expect(200);
      const settled = await rowOf(s.reference);
      expect(settled).toMatchObject({
        status: 'paid',
        flutterwaveTxId: first,
      });
      release();
      const late = await slow;
      expect(late.status).toBe(200);
      expect(data(late).status).toBe('paid');
      const after = await rowOf(s.reference);
      expect(after.flutterwaveTxId).toBe(first);
      expect(after.paidAt).toEqual(settled.paidAt);
      expect(after.paidKobo).toBe(settled.paidKobo);
      // The second id was not recorded anywhere.
      expect(
        await prisma.waitlistRegistration.count({
          where: { flutterwaveTxId: behind },
        }),
      ).toBe(0);
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

    it('says the right thing in each place: nothing was charged when it is refused at register, the extra payment will be refunded when it is refused at verify', async () => {
      const phone = '+2348039990002';
      const a = await started({
        phone,
        email: `${MARK}-words-a@test.wawu.dev`,
      });
      const b = await started({
        phone,
        email: `${MARK}-words-b@test.wawu.dev`,
      });
      await verify(a.reference, pay(a.reference)).expect(200);
      // The second person's payment goes through at Flutterwave and is refused here.
      const txB = pay(b.reference);
      const failed = await verify(b.reference, txB).expect(409);
      expect(reason(failed).code).toBe('already_registered');
      expect(reason(failed).message).toBe(AFTER_CHARGE_WORDS);
      expect(failed.body.message).toBe(AFTER_CHARGE_WORDS);
      // Asking again about that failed row says the same, and never "not been charged".
      const again = await verify(b.reference, txB).expect(409);
      expect(reason(again).message).toBe(AFTER_CHARGE_WORDS);
      expect(AFTER_CHARGE_WORDS).not.toMatch(/not been charged/);
      // Before any charge, at register, the sentence is the other one and stays.
      const early = await register(
        person({ phone, email: `${MARK}-words-c@test.wawu.dev` }),
      ).expect(409);
      expect(reason(early).code).toBe('already_registered');
      expect(reason(early).message).toBe(BEFORE_CHARGE_WORDS);
      expect(early.body.message).toBe(BEFORE_CHARGE_WORDS);
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

  describe('starting again with the same details (a new reference every time)', () => {
    const aged = (reference: string, minutes: number) =>
      prisma.waitlistRegistration.update({
        where: { reference },
        data: { createdAt: new Date(Date.now() - minutes * 60_000) },
      });
    const lookup = (reference: string) =>
      fake.byReference.set(reference, {
        id: String(++txSeq),
        status: 'successful',
        amount: config.eventOffers[0].priceKobo / 100,
        currency: 'NGN',
        txRef: reference,
      });

    it('a person who pays on two references is registered once: the first to settle is paid, the second is kept failed with its transaction id for a refund', async () => {
      const a = await started();
      const b = data(await register(a.body).expect(200));
      expect(b.reference).not.toBe(a.reference);
      const txA = pay(a.reference);
      const txB = pay(b.reference);
      await verify(a.reference, txA).expect(200);
      const second = await verify(b.reference, txB).expect(409);
      expect(reason(second).code).toBe('already_registered');
      expect(reason(second).message).toBe(AFTER_CHARGE_WORDS);
      expect(await rowOf(a.reference)).toMatchObject({
        status: 'paid',
        flutterwaveTxId: txA,
      });
      // Kept for the refund, with the money it holds, and never purged.
      expect(await rowOf(b.reference)).toMatchObject({
        status: 'failed',
        flutterwaveTxId: txB,
        paidKobo: config.eventOffers[0].priceKobo,
      });
      const status = await http()
        .get(`/api/hub/waitlist/registrations/${b.reference}`)
        .expect(200);
      expect(data(status).status).toBe('failed');
      // Exactly one paid row for the person, one failed.
      const rows = await prisma.waitlistRegistration.findMany({
        where: { phone: a.body.phone, offerId: OFFER_ID },
      });
      expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'paid']);
    });

    it('both payments reaching the re-check leave one paid row and one failed row, each found by its own reference', async () => {
      const a = await started();
      const b = data(await register(a.body).expect(200));
      await aged(a.reference, 20);
      await aged(b.reference, 10);
      lookup(a.reference);
      lookup(b.reference);
      expect(await sweep.recheckPending()).toEqual(
        expect.objectContaining({ paid: 1 }),
      );
      expect(fake.lookupCalls).toEqual(
        expect.arrayContaining([a.reference, b.reference]),
      );
      const rows = await prisma.waitlistRegistration.findMany({
        where: { phone: a.body.phone, offerId: OFFER_ID },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => [r.reference, r.status])).toEqual([
        [a.reference, 'paid'],
        [b.reference, 'failed'],
      ]);
      expect(rows[1].flutterwaveTxId).not.toBeNull();
      expect(rows[1].paidKobo).toBe(config.eventOffers[0].priceKobo);
    });

    it('a payment made on the first reference, never confirmed, is still found by that reference after the person started again', async () => {
      const a = await started();
      // The person paid, did not hear back, and started again.
      const b = data(await register(a.body).expect(200));
      await aged(a.reference, 20);
      await aged(b.reference, 10);
      lookup(a.reference);
      // Flutterwave has nothing under the second reference.
      expect(await sweep.recheckPending()).toEqual(
        expect.objectContaining({ paid: 1 }),
      );
      expect((await rowOf(a.reference)).status).toBe('paid');
      expect((await rowOf(b.reference)).status).toBe('pending');
      // They are registered, so a third start is refused before any charge.
      const early = await register(a.body).expect(409);
      expect(reason(early).code).toBe('already_registered');
    });

    it('20 starts by one person leave 20 pending rows with 20 references; the re-check looks up every one by its own reference and the purge removes the unpaid ones after 7 days', async () => {
      const body = person();
      const references: string[] = [];
      for (let i = 0; i < 20; i += 1)
        references.push(data(await register(body).expect(200)).reference);
      expect(new Set(references).size).toBe(20);
      const where = { phone: body.phone, offerId: OFFER_ID };
      expect(
        await prisma.waitlistRegistration.count({
          where: { ...where, status: 'pending' },
        }),
      ).toBe(20);
      for (const reference of references) await aged(reference, 12);
      // One of the twenty was paid at Flutterwave.
      lookup(references[6]);
      fake.lookupCalls = [];
      const run = await sweep.recheckPending();
      expect(run.paid).toBe(1);
      expect(
        fake.lookupCalls.filter((r) => references.includes(r)).sort(),
      ).toEqual([...references].sort());
      expect((await rowOf(references[6])).status).toBe('paid');
      expect(
        await prisma.waitlistRegistration.count({
          where: { ...where, status: 'pending' },
        }),
      ).toBe(19);
      // A week later the 19 unpaid rows are gone; the paid one is kept.
      await prisma.waitlistRegistration.updateMany({
        where: { ...where, status: 'pending' },
        data: { createdAt: new Date(Date.now() - 8 * DAY) },
      });
      expect(await sweep.purgeUnpaid()).toBeGreaterThanOrEqual(19);
      const left = await prisma.waitlistRegistration.findMany({ where });
      expect(left.map((r) => r.reference)).toEqual([references[6]]);
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

    const NEVER_ISSUED = [
      'wawu-join-' + 'a'.repeat(36) + '\u0000',
      'wawu-join-' + 'a'.repeat(30) + '\u0000',
      'wawu-join-' + 'A'.repeat(36),
      'wawu-join-' + 'a'.repeat(35),
      'wawu-join-' + 'a'.repeat(37),
      'wawu-join-' + 'g'.repeat(36),
      'wawu-join-' + 'a'.repeat(36) + '\n',
      ' wawu-join-' + 'a'.repeat(36),
      'wawu-join-' + 'a'.repeat(34) + '\u001fa',
      'wawu-join-',
      'nonsense',
    ];

    it('a reference this server never issues, a NUL byte included, is byte for byte the 404 an unknown reference gets (a NUL byte was a 500)', async () => {
      const unknown = await http()
        .get(`/api/hub/waitlist/registrations/wawu-join-${'0'.repeat(36)}`)
        .expect(404);
      for (const reference of NEVER_ISSUED) {
        const res = await http()
          .get(
            `/api/hub/waitlist/registrations/${encodeURIComponent(reference)}`,
          )
          .expect(404);
        expect(res.text).toBe(unknown.text);
        expect(res.headers['cache-control']).toBe(
          unknown.headers['cache-control'],
        );
      }
    });

    it('answers a reference this server never issues without touching the database (the same service, with a database that fails on any use)', async () => {
      const untouchable = new Proxy(
        {},
        {
          get: () => {
            throw new Error('the database was touched');
          },
        },
      ) as PrismaService;
      const service = new WaitlistService(untouchable, config, fake, fake);
      for (const reference of NEVER_ISSUED) {
        await expect(service.status(reference)).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(
          service.verify({ reference, transactionId: '12345' }),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      // The control: a well-formed reference that is merely unknown DOES go to the database.
      await expect(
        service.status('wawu-join-' + '0'.repeat(36)),
      ).rejects.toThrow('the database was touched');
      expect(fake.verifyCalls).toHaveLength(0);
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

    /**
     * `count` pending rows, 30 minutes old (inside the window), written
     * straight into the table: the shape of a registration burst. `layout`
     * decides the order the re-check's cursor has to walk them in.
     */
    let burstSeq = 0;
    const burst = async (
      tag: string,
      count: number,
      layout: 'spread' | 'shared' | 'inverse',
    ) => {
      const base = Date.now() - 30 * 60_000;
      const seq = (burstSeq++ % 16).toString(16);
      const pad = (v: number, w: number) => String(v).padStart(w, '0');
      const rows = Array.from({ length: count }, (_, i) => ({
        // ids sort the same way as i, except in the layout that reverses them
        id: `${tag}-${pad(layout === 'inverse' ? count - i : i, 5)}`,
        offerId: OFFER_ID,
        fullName: `Burst ${tag} ${i} ${MARK}`,
        phone: `+23481${pad(i, 8)}`,
        email: `${MARK}-burst-${tag}-${i}@test.wawu.dev`,
        consentAt: new Date(base),
        reference: `wawu-join-${seq}${i.toString(16).padStart(35, '0')}`,
        amountKobo: config.eventOffers[0].priceKobo,
        createdAt: new Date(layout === 'shared' ? base : base + i * 1000),
      }));
      await prisma.waitlistRegistration.createMany({ data: rows });
      return rows;
    };
    const dueCount = (now: Date) =>
      prisma.waitlistRegistration.count({
        where: {
          status: 'pending',
          createdAt: {
            lte: new Date(now.getTime() - RECHECK_AFTER_MS),
            gt: new Date(now.getTime() - RECHECK_UNTIL_MS),
          },
        },
      });

    it('finds a payer who is behind more than a page of older abandoned registrations, in the first run (it used to look only at the oldest 200)', async () => {
      const abandoned = await burst('abandoned', RECHECK_PAGE + 5, 'spread');
      // One payer inside the first page, one after every abandoned row.
      const early = await started();
      await prisma.waitlistRegistration.update({
        where: { reference: early.reference },
        data: {
          createdAt: new Date(
            Date.now() - 30 * 60_000 + (RECHECK_PAGE / 2) * 1000 + 500,
          ),
        },
      });
      const late = await started();
      await aged(late.reference, 10);
      lookup(early.reference);
      lookup(late.reference);
      const now = new Date();
      const expected = await dueCount(now);
      expect(expected).toBeGreaterThan(RECHECK_PAGE);
      const result = await sweep.recheckPending(now);
      expect(await rowOf(early.reference)).toMatchObject({ status: 'paid' });
      expect(await rowOf(late.reference)).toMatchObject({ status: 'paid' });
      expect(result.paid).toBe(2);
      // Every due row was looked at, once: the abandoned ones and the two payers.
      expect(result.checked).toBe(expected);
      const asked = new Set(fake.lookupCalls);
      expect(fake.lookupCalls).toHaveLength(asked.size);
      for (const r of abandoned) expect(asked.has(r.reference)).toBe(true);
      await cleanUp();
    }, 60_000);

    it.each([
      ['created times rising, ids rising', 'spread'],
      [
        'one shared created time (the cursor must tell them apart by id)',
        'shared',
      ],
      [
        'created times rising while ids fall (the cursor must follow created time first)',
        'inverse',
      ],
    ] as const)(
      'pages through every due row exactly once, none skipped and none read twice, with %s',
      async (_label, layout) => {
        const total = 2 * RECHECK_PAGE + 5;
        const rows = await burst(layout, total, layout);
        // Everyone in the burst paid and never came back, except one whose lookup fails at the end of the first page.
        const failing = rows[RECHECK_PAGE - 1].reference;
        for (const r of rows) lookup(r.reference);
        fake.lookupFails.add(failing);
        const now = new Date();
        const expected = await dueCount(now);
        const result = await sweep.recheckPending(now);
        const mine = rows.map((r) => r.reference);
        const lookedUp = fake.lookupCalls.filter((r) => mine.includes(r));
        expect(lookedUp).toHaveLength(total);
        expect(new Set(lookedUp).size).toBe(total);
        expect(result.checked).toBe(expected);
        const paid = await prisma.waitlistRegistration.count({
          where: { reference: { in: mine }, status: 'paid' },
        });
        expect(paid).toBe(total - 1);
        expect((await rowOf(failing)).status).toBe('pending');
        // The next run looks at the one left and nothing else of the burst.
        fake.lookupCalls = [];
        fake.lookupFails.clear();
        await sweep.recheckPending(now);
        expect(fake.lookupCalls.filter((r) => mine.includes(r))).toEqual([
          failing,
        ]);
        expect((await rowOf(failing)).status).toBe('paid');
        await cleanUp();
      },
      60_000,
    );

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

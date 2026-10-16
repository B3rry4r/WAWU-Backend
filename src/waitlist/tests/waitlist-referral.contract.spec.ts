// The spec reads response bodies and edits an untyped copy of the plans file.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig } from '../../plans/plans-config';
import { purgePersonPoints } from '../../points/points-purge';
import { WaitlistClaimService } from '../waitlist-claim.service';
import { WaitlistSweepService } from '../waitlist-sweep.service';
import { REFERRAL_HOLD_MS } from '../waitlist-config';
import { WaitlistService } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  DAY,
  OFFER_ID,
  openOffer,
  ScriptedFlutterwave,
} from './waitlist-harness';

/**
 * REF-01 (owner, 14 Oct 2026): referral codes on the registration page, over
 * HTTP on the real WaitlistModule and a real database, Flutterwave stood in at
 * its two seams. Every figure is read from the config or from the code row,
 * never written here, except the two the owner named for LOGOART (its price
 * and its limit are checked against the migration's own insert).
 */

const MARK = 'ref01-spec';
const UNKNOWN_WORDS =
  'We do not recognise that referral code. Check it, or leave it empty to pay the standard price.';
const BEFORE_CHARGE_WORDS =
  'You are already registered for this event. You have not been charged again.';

type Envelope<T> = { statusCode: number; message: string; data: T };
const data = <T = any>(res: Response): T => (res.body as Envelope<T>).data;
const reason = (res: Response) => res.body.reason;

describe('Referral codes on the registration page (REF-01) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let waitlist: WaitlistService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  let fetchSpy: jest.SpyInstance;
  let n = 0;
  let codeSeq = 0;
  const http = () => request(app.getHttpServer());
  const standard = () => config.eventOffers[0].priceKobo;

  const person = (over: Record<string, unknown> = {}) => {
    n += 1;
    const tail = String(30_000_000 + n).slice(-8);
    return {
      offerId: OFFER_ID,
      fullName: `Tester ${n} ${MARK}`,
      phone: `+23481${tail}`,
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
  const check = (code: string) =>
    http().get(`/api/hub/waitlist/referral-codes/${encodeURIComponent(code)}`);

  /** A code of this spec's own: unique each time, upper case. */
  const makeCode = (
    over: Partial<{
      priceKobo: number;
      usageLimit: number | null;
      active: boolean;
      community: string;
    }> = {},
  ) => {
    codeSeq += 1;
    return prisma.referralCode.create({
      data: {
        code: `RFS${process.pid}X${codeSeq}`.slice(0, 20),
        community: `Community ${codeSeq}`,
        priceKobo: 100000,
        usageLimit: null,
        active: true,
        ...over,
      },
    });
  };

  let txSeq = 6_000_000;
  const pay = (reference: string, amountNaira: number) => {
    txSeq += 1;
    const id = String(txSeq);
    fake.payments.set(id, {
      status: 'successful',
      amount: amountNaira,
      currency: 'NGN',
      txRef: reference,
    });
    return id;
  };

  const cleanUp = async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await prisma.referralCode.deleteMany({
      where: { code: { startsWith: 'RFS' } },
    });
  };

  beforeAll(async () => {
    config = configWith((raw) => {
      raw.event_offers = [openOffer()];
    });
    app = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    waitlist = app.get(WaitlistService);
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

  describe('the migration', () => {
    it('inserted LOGOART the moment it landed: community LOGOART, 120000 kobo, a limit of 4000, on', async () => {
      const row = await prisma.referralCode.findUniqueOrThrow({
        where: { code: 'LOGOART' },
      });
      expect(row).toMatchObject({
        code: 'LOGOART',
        community: 'LOGOART',
        priceKobo: 120000,
        usageLimit: 4000,
        active: true,
      });
    });

    it('keeps the database honest: a free row only with a code, a paid row with no transaction id only when it is free', async () => {
      const base = {
        offerId: OFFER_ID,
        fullName: `Constraint ${MARK}`,
        consentAt: new Date(),
      };
      const mk = (over: Record<string, unknown>) => {
        n += 1;
        return prisma.waitlistRegistration.create({
          data: {
            ...base,
            phone: `+23482${String(40_000_000 + n).slice(-8)}`,
            email: `${MARK}-c${n}@test.wawu.dev`,
            reference: `wawu-join-${String(n).padStart(36, 'c')}`,
            amountKobo: 200000,
            ...over,
          } as never,
        });
      };
      // Today's rules still hold for a row with no code.
      await expect(mk({ amountKobo: 0 })).rejects.toThrow();
      await expect(
        mk({
          status: 'paid',
          paidKobo: 200000,
          paidAt: new Date(),
          flutterwaveTxId: null,
        }),
      ).rejects.toThrow();
      // A coded row may be free, and be paid with no transaction id.
      const ok = await mk({
        amountKobo: 0,
        referralCode: 'RFSCHECK',
        referralCommunity: 'x',
        status: 'paid',
        paidKobo: 0,
        paidAt: new Date(),
      });
      expect(ok.flutterwaveTxId).toBeNull();
      // A free paid row that was paid 0 is not a way to skip a price: a coded row at a price must still carry an id.
      await expect(
        mk({
          amountKobo: 120000,
          referralCode: 'RFSCHECK',
          status: 'paid',
          paidKobo: 120000,
          paidAt: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  describe('no code: exactly what it was', () => {
    it('answers the same four keys and the same checkout, with no referral or completed field', async () => {
      const res = await register(person()).expect(200);
      expect(Object.keys(data(res))).toEqual([
        'reference',
        'offerId',
        'amountKobo',
        'flutterwaveConfig',
      ]);
      const start = data(res);
      expect(start.amountKobo).toBe(standard());
      expect(Object.keys(start.flutterwaveConfig)).toEqual([
        'publicKey',
        'txRef',
        'amount',
        'currency',
        'customerName',
        'customerEmail',
        'customerPhone',
      ]);
      expect(start.flutterwaveConfig).toMatchObject({
        txRef: start.reference,
        amount: standard() / 100,
        currency: 'NGN',
      });
      const row = await rowOf(start.reference);
      expect(row).toMatchObject({
        status: 'pending',
        amountKobo: standard(),
        referralCode: null,
        referralCommunity: null,
      });
      // The checkout is asked for the standard amount, as before.
      expect(fake.initCalls).toEqual([
        {
          amount: standard() / 100,
          purpose: 'waitlist',
          wawuUserId: 'waitlist',
        },
      ]);
    });

    it('is byte for byte what it was before codes existed, and an empty or blank code gives the same', async () => {
      // The answer's JSON text, key by key in the order it has always had,
      // built here from the person and the config, not from the new code.
      const today = (p: any, reference: string) =>
        JSON.stringify({
          reference,
          offerId: OFFER_ID,
          amountKobo: standard(),
          flutterwaveConfig: {
            publicKey: fake.publicKey,
            txRef: reference,
            amount: standard() / 100,
            currency: 'NGN',
            customerName: p.fullName,
            customerEmail: p.email,
            customerPhone: p.phone,
          },
        });
      for (const extra of [{}, { referralCode: '' }, { referralCode: '   ' }]) {
        const p = person();
        const res = await register({ ...p, ...extra }).expect(200);
        const start = data(res);
        expect(JSON.stringify(start)).toBe(today(p, start.reference));
        expect(await rowOf(start.reference)).toMatchObject({
          referralCode: null,
          referralCommunity: null,
          amountKobo: standard(),
          status: 'pending',
        });
      }
    });

    it('settles at the standard price as before: an underpayment is refused, the price is accepted', async () => {
      const start = data(await register(person()).expect(200));
      const short = pay(start.reference, standard() / 100 - 1);
      const res = await verify(start.reference, short).expect(422);
      expect(reason(res).code).toBe('payment_mismatch');
      await verify(
        start.reference,
        pay(start.reference, standard() / 100),
      ).expect(200);
      expect((await rowOf(start.reference)).status).toBe('paid');
    });
  });

  describe('a code we do not have', () => {
    it('is refused in the owner’s words on register, with no row and no charge, whatever the case or the shape', async () => {
      const before = await prisma.waitlistRegistration.count({
        where: { fullName: { contains: MARK } },
      });
      for (const typo of [
        'NOSUCHCODE',
        'nosuchcode',
        'LO',
        'A-B-C',
        'X'.repeat(21),
        '日本語',
      ]) {
        const res = await register(person({ referralCode: typo })).expect(404);
        expect(reason(res)).toEqual({
          code: 'referral_unknown',
          message: UNKNOWN_WORDS,
        });
        expect(res.body.message).toBe(UNKNOWN_WORDS);
      }
      expect(
        await prisma.waitlistRegistration.count({
          where: { fullName: { contains: MARK } },
        }),
      ).toBe(before);
      expect(fake.initCalls).toHaveLength(0);
    });

    it('is a 404 with the same words on the public check', async () => {
      for (const typo of ['NOSUCHCODE', 'no', 'a b', 'X'.repeat(30)]) {
        const res = await check(typo).expect(404);
        expect(reason(res)).toEqual({
          code: 'referral_unknown',
          message: UNKNOWN_WORDS,
        });
      }
    });
  });

  describe('a code that applies', () => {
    it('attributes the registration to the code and charges the code’s price: the row, the checkout and the answer agree', async () => {
      const code = await makeCode({
        priceKobo: 120000,
        community: 'Logo School',
      });
      const who = person({ referralCode: code.code.toLowerCase() });
      const start = data(await register(who).expect(200));
      expect(Object.keys(start)).toEqual([
        'reference',
        'offerId',
        'amountKobo',
        'flutterwaveConfig',
        'referral',
      ]);
      expect(start.amountKobo).toBe(120000);
      expect(start.flutterwaveConfig.amount).toBe(1200);
      expect(start.referral).toEqual({ code: code.code, applied: true });
      expect(fake.initCalls).toEqual([
        { amount: 1200, purpose: 'waitlist', wawuUserId: 'waitlist' },
      ]);
      expect(await rowOf(start.reference)).toMatchObject({
        status: 'pending',
        amountKobo: 120000,
        referralCode: code.code,
        referralCommunity: 'Logo School',
      });
    });

    it('is LOGOART at 1200 naira, written in any case with spaces round it', async () => {
      const start = data(
        await register(person({ referralCode: '  LogoArt ' })).expect(200),
      );
      expect(start.amountKobo).toBe(120000);
      expect(start.flutterwaveConfig.amount).toBe(1200);
      expect(start.referral).toEqual({ code: 'LOGOART', applied: true });
      expect(await rowOf(start.reference)).toMatchObject({
        referralCode: 'LOGOART',
        referralCommunity: 'LOGOART',
        amountKobo: 120000,
      });
    });

    it('never charges more than the offer: a code priced above it pays the offer’s price', async () => {
      const code = await makeCode({ priceKobo: standard() + 500000 });
      const start = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect(start.amountKobo).toBe(standard());
      expect(start.referral).toEqual({ code: code.code, applied: true });
    });

    it('settles by the row’s own amount: an underpayment of a coded price is refused, the coded price is accepted', async () => {
      const code = await makeCode({ priceKobo: 120000 });
      const start = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      const short = pay(start.reference, 1199);
      const res = await verify(start.reference, short).expect(422);
      expect(reason(res).code).toBe('payment_mismatch');
      expect((await rowOf(start.reference)).status).toBe('pending');
      await verify(start.reference, pay(start.reference, 1200)).expect(200);
      expect(await rowOf(start.reference)).toMatchObject({
        status: 'paid',
        paidKobo: 120000,
        referralCode: code.code,
      });
    });

    it('settles a coded registration through the re-check sweep by the same rule', async () => {
      const code = await makeCode({ priceKobo: 120000 });
      const start = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      await prisma.waitlistRegistration.update({
        where: { reference: start.reference },
        data: { createdAt: new Date(Date.now() - 10 * 60_000) },
      });
      txSeq += 1;
      fake.byReference.set(start.reference, {
        id: String(txSeq),
        status: 'successful',
        amount: 1199,
        currency: 'NGN',
        txRef: start.reference,
      });
      const sweep = app.get(WaitlistSweepService);
      expect((await sweep.recheckPending()).paid).toBe(0);
      expect((await rowOf(start.reference)).status).toBe('pending');
      fake.byReference.set(start.reference, {
        id: String(txSeq),
        status: 'successful',
        amount: 1200,
        currency: 'NGN',
        txRef: start.reference,
      });
      expect((await sweep.recheckPending()).paid).toBe(1);
      expect((await rowOf(start.reference)).status).toBe('paid');
    });
  });

  describe('a code that is switched off or full: the standard price, not counted under the code', () => {
    it('registers a switched-off code at the standard price, unattributed, and says so', async () => {
      const code = await makeCode({ active: false });
      const start = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect(start.amountKobo).toBe(standard());
      expect(start.flutterwaveConfig.amount).toBe(standard() / 100);
      expect(start.referral).toEqual({
        code: code.code,
        applied: false,
        reason: 'inactive',
      });
      expect(await rowOf(start.reference)).toMatchObject({
        amountKobo: standard(),
        referralCode: null,
        referralCommunity: null,
      });
    });

    it('registers a code at its limit at the standard price, unattributed, and says why', async () => {
      const code = await makeCode({ usageLimit: 2 });
      const a = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      const b = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect([a.referral.applied, b.referral.applied]).toEqual([true, true]);
      const c = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect(c.amountKobo).toBe(standard());
      expect(c.referral).toEqual({
        code: code.code,
        applied: false,
        reason: 'full',
      });
      expect(await rowOf(c.reference)).toMatchObject({
        referralCode: null,
        amountKobo: standard(),
      });
      // The two before it keep their place and their price.
      expect(await rowOf(a.reference)).toMatchObject({
        referralCode: code.code,
        amountKobo: code.priceKobo,
      });
      // The count under the code is still two.
      expect(
        await prisma.waitlistRegistration.count({
          where: { referralCode: code.code },
        }),
      ).toBe(2);
    });

    it('lets the unattributed person pay the standard price and be paid, counted under no code', async () => {
      const code = await makeCode({ usageLimit: 1 });
      await register(person({ referralCode: code.code })).expect(200);
      const full = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      await verify(
        full.reference,
        pay(full.reference, standard() / 100),
      ).expect(200);
      expect(await rowOf(full.reference)).toMatchObject({
        status: 'paid',
        referralCode: null,
        paidKobo: standard(),
      });
    });
  });

  describe('the last place', () => {
    it('goes to one of two people asking at the same moment, never both', async () => {
      for (let round = 0; round < 4; round += 1) {
        const code = await makeCode({ usageLimit: 1 });
        const [x, y] = await Promise.all([
          register(person({ referralCode: code.code })),
          register(person({ referralCode: code.code })),
        ]);
        expect(x.status).toBe(200);
        expect(y.status).toBe(200);
        const applied = [data(x), data(y)].filter((s) => s.referral.applied);
        const refused = [data(x), data(y)].filter((s) => !s.referral.applied);
        expect(applied).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0].referral.reason).toBe('full');
        expect(applied[0].amountKobo).toBe(code.priceKobo);
        expect(refused[0].amountKobo).toBe(standard());
        expect(
          await prisma.waitlistRegistration.count({
            where: { referralCode: code.code },
          }),
        ).toBe(1);
      }
    });

    it('goes to exactly the limit when many ask at once', async () => {
      const code = await makeCode({ usageLimit: 3 });
      const answers = await Promise.all(
        Array.from({ length: 9 }, () =>
          register(person({ referralCode: code.code })),
        ),
      );
      expect(answers.map((a) => a.status)).toEqual(Array(9).fill(200));
      expect(answers.filter((a) => data(a).referral.applied)).toHaveLength(3);
      expect(
        await prisma.waitlistRegistration.count({
          where: { referralCode: code.code },
        }),
      ).toBe(3);
    });
  });

  describe('a held place', () => {
    it('holds the place for 30 minutes and gives it back after, and a place paid late is still honoured', async () => {
      const code = await makeCode({ usageLimit: 1 });
      const t0 = new Date();
      const first = await waitlist.register(
        person({ referralCode: code.code }),
        t0,
      );
      expect(first.referral?.applied).toBe(true);
      // 29 minutes on, the place is still held.
      const early = await waitlist.register(
        person({ referralCode: code.code }),
        new Date(t0.getTime() + REFERRAL_HOLD_MS - 60_000),
      );
      expect(early.referral).toEqual({
        code: code.code,
        applied: false,
        reason: 'full',
      });
      // 31 minutes on, the hold has ended and the next person takes it.
      const late = await waitlist.register(
        person({ referralCode: code.code }),
        new Date(t0.getTime() + REFERRAL_HOLD_MS + 60_000),
      );
      expect(late.referral).toEqual({ code: code.code, applied: true });
      // The first person was slow but pays now: honoured, at the coded price.
      await verify(
        first.reference,
        pay(first.reference, code.priceKobo / 100),
      ).expect(200);
      expect(await rowOf(first.reference)).toMatchObject({
        status: 'paid',
        referralCode: code.code,
        paidKobo: code.priceKobo,
      });
      // Two now sit under a limit of one; the next person is told it is full.
      const next = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect(next.referral.reason).toBe('full');
    });

    it('counts a paid place for good, however old', async () => {
      const code = await makeCode({ usageLimit: 1 });
      const start = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      await verify(
        start.reference,
        pay(start.reference, code.priceKobo / 100),
      ).expect(200);
      await prisma.waitlistRegistration.update({
        where: { reference: start.reference },
        data: { createdAt: new Date(Date.now() - 20 * DAY) },
      });
      const res = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect(res.referral.reason).toBe('full');
    });

    it('does not count a second payment kept for a refund as a place', async () => {
      const code = await makeCode({ usageLimit: 1 });
      const who = person({ referralCode: code.code });
      const one = data(await register(who).expect(200));
      const two = data(await register(who).expect(200));
      expect(two.referral.applied).toBe(false);
      await verify(
        one.reference,
        pay(one.reference, code.priceKobo / 100),
      ).expect(200);
      await prisma.waitlistRegistration.update({
        where: { reference: two.reference },
        data: { status: 'failed', referralCode: code.code },
      });
      expect(await waitlist.referralCheck(code.code)).toMatchObject({
        applies: false,
        reason: 'full',
      });
      // One paid place and a failed row: only the paid place counts.
      const usage = await prisma.waitlistRegistration.count({
        where: { referralCode: code.code, status: { in: ['paid', 'pending'] } },
      });
      expect(usage).toBe(1);
    });
  });

  describe('a free code (price 0)', () => {
    it('opens no checkout: the row is made paid at once and the answer carries what the page shows next', async () => {
      const code = await makeCode({ priceKobo: 0, community: 'Free School' });
      const who = person({ referralCode: code.code });
      const res = await register(who).expect(200);
      const start = data(res);
      expect(Object.keys(start)).toEqual([
        'reference',
        'offerId',
        'amountKobo',
        'completed',
        'referral',
      ]);
      expect(start.amountKobo).toBe(0);
      expect(start.referral).toEqual({ code: code.code, applied: true });
      expect(fake.initCalls).toHaveLength(0);
      const row = await rowOf(start.reference);
      expect(row).toMatchObject({
        status: 'paid',
        amountKobo: 0,
        paidKobo: 0,
        flutterwaveTxId: null,
        referralCode: code.code,
        referralCommunity: 'Free School',
      });
      expect(row.paidAt).not.toBeNull();
      expect(start.completed).toEqual({
        status: 'paid',
        firstName: 'Tester',
        accessCode: `${row.accessCode.slice(0, 4)} ${row.accessCode.slice(4)}`,
      });
      // The status route and the verify route treat it as any paid row.
      const status = await http()
        .get(`/api/hub/waitlist/registrations/${start.reference}`)
        .expect(200);
      expect(data(status)).toEqual({
        reference: start.reference,
        status: 'paid',
        firstName: 'Tester',
      });
      const again = await verify(start.reference, '123456').expect(200);
      expect(data(again).status).toBe('paid');
      expect(fake.verifyCalls).toHaveLength(0);
    });

    it('needs no payment key: payments being off does not stop a free registration, and still stops a paid one', async () => {
      const free = await makeCode({ priceKobo: 0 });
      const paid = await makeCode({ priceKobo: 100000 });
      fake.publicKey = '';
      try {
        const ok = await register(person({ referralCode: free.code })).expect(
          200,
        );
        expect(data(ok).completed.status).toBe('paid');
        const before = await prisma.waitlistRegistration.count({
          where: { fullName: { contains: MARK } },
        });
        const refused = await register(
          person({ referralCode: paid.code }),
        ).expect(503);
        expect(reason(refused).code).toBe('payments_unavailable');
        // Nothing was written by the refused start, and no place was taken.
        expect(
          await prisma.waitlistRegistration.count({
            where: { fullName: { contains: MARK } },
          }),
        ).toBe(before);
      } finally {
        fake.publicKey = 'FLWPUBK_TEST-join01-spec-X';
      }
    });

    it('cannot be used twice by one person: the same email, or the same phone, is refused and no second row is made', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const who = person({ referralCode: code.code });
      await register(who).expect(200);
      const sameEmail = await register({
        ...person({ referralCode: code.code }),
        email: who.email,
      }).expect(409);
      expect(reason(sameEmail)).toEqual({
        code: 'already_registered',
        message: BEFORE_CHARGE_WORDS,
      });
      const samePhone = await register({
        ...person({ referralCode: code.code }),
        phone: who.phone,
      }).expect(409);
      expect(reason(samePhone).code).toBe('already_registered');
      expect(
        await prisma.waitlistRegistration.count({
          where: { email: who.email },
        }),
      ).toBe(1);
    });

    it('cannot be used twice at the same moment: one paid row, the other start refused', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const who = person({ referralCode: code.code });
      const answers = await Promise.all([
        register(who),
        register(who),
        register(who),
      ]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409]);
      expect(
        await prisma.waitlistRegistration.count({
          where: { email: who.email, status: 'paid' },
        }),
      ).toBe(1);
    });

    it('is refused for someone who already paid at the standard price', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const who = person();
      const start = data(await register(who).expect(200));
      await verify(
        start.reference,
        pay(start.reference, standard() / 100),
      ).expect(200);
      const res = await register({ ...who, referralCode: code.code }).expect(
        409,
      );
      expect(reason(res).code).toBe('already_registered');
    });

    it('counts under a limit like any other place', async () => {
      const code = await makeCode({ priceKobo: 0, usageLimit: 1 });
      await register(person({ referralCode: code.code })).expect(200);
      const next = data(
        await register(person({ referralCode: code.code })).expect(200),
      );
      expect(next.referral).toEqual({
        code: code.code,
        applied: false,
        reason: 'full',
      });
      expect(next.amountKobo).toBe(standard());
      expect(next.flutterwaveConfig).toBeDefined();
    });

    it('is treated as any paid row by the sweeps, the claim and the lists', async () => {
      const code = await makeCode({ priceKobo: 0 });
      const who = person({ referralCode: code.code });
      const start = data(await register(who).expect(200));
      const row = await rowOf(start.reference);
      // The re-check looks only at unpaid rows; the purge deletes only unpaid ones, even when old.
      const sweep = app.get(WaitlistSweepService);
      await prisma.waitlistRegistration.update({
        where: { id: row.id },
        data: { createdAt: new Date(Date.now() - 20 * DAY) },
      });
      expect((await sweep.recheckPending()).checked).toBe(0);
      await sweep.purgeUnpaid();
      expect((await rowOf(start.reference)).status).toBe('paid');
      expect(fake.lookupCalls).not.toContain(start.reference);
      // The claim in the app: the access code of a free row turns into the plan.
      const sub = `ref01-claimant-${process.pid}`;
      const claims = {
        sub,
        email: who.email,
        phone: who.phone,
        emailVerified: true,
        phoneVerified: true,
        firstName: 'F',
        lastName: 'R',
        country: 'Nigeria',
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      } as unknown as WawuJwtClaims;
      try {
        const claimed = await app
          .get(WaitlistClaimService)
          .claim(claims, start.completed.accessCode);
        expect(claimed.days).toBe(config.eventOffers[0].tierDays);
        const after = await rowOf(start.reference);
        expect(after.claimedByWawuId).toBe(sub);
        // A second claim by the same account is answered again, nothing written.
        const replay = await app
          .get(WaitlistClaimService)
          .claim(claims, start.completed.accessCode);
        expect(replay.claimedAt).toBe(claimed.claimedAt);
      } finally {
        await purgePersonPoints(prisma, sub);
        await prisma.eventPass.deleteMany({ where: { wawuUserId: sub } });
        await prisma.makerTier.deleteMany({ where: { wawuUserId: sub } });
        await prisma.pointLot.deleteMany({
          where: { sourceRef: { startsWith: 'join:' }, wawuUserId: sub },
        });
      }
    });
  });

  describe('GET /waitlist/referral-codes/{code}: the check before paying', () => {
    it('answers whether the code applies and the price, never the limit, the count or the community', async () => {
      const code = await makeCode({
        priceKobo: 150000,
        usageLimit: 5,
        community: 'Secret Community',
      });
      const res = await check(code.code.toLowerCase()).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(data(res)).toEqual({
        code: code.code,
        applies: true,
        priceKobo: 150000,
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /Secret Community|usageLimit|"limit"|community/i,
      );
    });

    it('says a switched-off or full code does not apply and shows the standard price', async () => {
      const off = await makeCode({ active: false });
      expect(data(await check(off.code).expect(200))).toEqual({
        code: off.code,
        applies: false,
        reason: 'inactive',
        priceKobo: standard(),
      });
      const full = await makeCode({ usageLimit: 1 });
      await register(person({ referralCode: full.code })).expect(200);
      expect(data(await check(full.code).expect(200))).toEqual({
        code: full.code,
        applies: false,
        reason: 'full',
        priceKobo: standard(),
      });
    });

    it('shows a free code as price 0, and a code priced above the offer as the offer’s price', async () => {
      const free = await makeCode({ priceKobo: 0 });
      expect(data(await check(free.code).expect(200)).priceKobo).toBe(0);
      const dear = await makeCode({ priceKobo: standard() * 3 });
      expect(data(await check(dear.code).expect(200)).priceKobo).toBe(
        standard(),
      );
    });

    it('answers LOGOART at 1200 naira', async () => {
      const res = data(await check('logoart').expect(200));
      expect(res).toMatchObject({
        code: 'LOGOART',
        applies: true,
        priceKobo: 120000,
      });
    });

    it('answers 404 no_open_offer when no offer is open', async () => {
      const closed = await bootWaitlist(
        configWith((raw) => {
          raw.event_offers = [
            openOffer({
              open_from: new Date(Date.now() - 9 * DAY).toISOString(),
              open_until: new Date(Date.now() - DAY).toISOString(),
            }),
          ];
        }),
        fake,
      );
      try {
        const res = await request(closed.getHttpServer())
          .get('/api/hub/waitlist/referral-codes/LOGOART')
          .expect(404);
        expect(reason(res).code).toBe('no_open_offer');
      } finally {
        await closed.close();
      }
    });
  });
});

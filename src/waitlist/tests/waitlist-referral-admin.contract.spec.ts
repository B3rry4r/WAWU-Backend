// The spec reads response bodies.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { generateKeyPairSync } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig } from '../../plans/plans-config';
import { newReference } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  openOffer,
  ScriptedFlutterwave,
} from './waitlist-harness';

/**
 * REF-01, the team's side: the referral codes (list, create, change), the
 * totals of the whole offer with a "No code" row that holds every paid
 * registration made before codes existed, and the people list and CSV with a
 * filter by code. Writes are superadmin only.
 */

const MARK = 'ref01-admin-spec';
const OFFER = 'event-ref01-admin';
const ADMINS = [
  ['ad010101-0000-4000-8000-000000000001', 'superadmin'],
  ['ad010101-0000-4000-8000-000000000002', 'reviewer'],
  ['ad010101-0000-4000-8000-000000000003', 'support'],
  ['ad010101-0000-4000-8000-000000000004', 'finance'],
] as const;
const email = (role: string) => `r01-${role}@admin.test.wawu.dev`;
const PASSWORD = 'ref01-admin-contract-password';
const KEYS = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];
const BASE = '/api/hub/admin/waitlist';

type Envelope<T> = { statusCode: number; message: string; data: T };
const data = <T = any>(res: Response): T => (res.body as Envelope<T>).data;
const reason = (res: Response) => res.body.reason;

describe('Referral codes and the offer totals, the team view (REF-01)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  const tokens: Record<string, string> = {};
  const snapshot: Record<string, string | undefined> = {};
  let userToken: string;
  const http = () => request(app.getHttpServer());
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const standard = () => config.eventOffers[0].priceKobo;
  let n = 0;
  let tx = 9_000_000;

  const person = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      offerId: OFFER,
      fullName: `Admin Person ${n} ${MARK}`,
      phone: `+23481${String(50_000_000 + n).slice(-8)}`,
      email: `${MARK}-${n}@test.wawu.dev`,
      consent: true,
      ...over,
    };
  };
  const register = (body: object) =>
    http().post('/api/hub/waitlist/registrations').send(body);
  const pay = (reference: string, amountNaira: number) => {
    tx += 1;
    fake.payments.set(String(tx), {
      status: 'successful',
      amount: amountNaira,
      currency: 'NGN',
      txRef: reference,
    });
    return http()
      .post('/api/hub/waitlist/registrations/verify')
      .send({ reference, transactionId: String(tx) });
  };

  /** A registration as it was written before referral codes: no code, a plain row. */
  const legacy = async (
    status: 'paid' | 'pending' | 'failed',
    amountKobo = 200000,
  ) => {
    const p = person({ fullName: `Legacy ${n} ${MARK}` });
    const reference = newReference();
    tx += 1;
    return prisma.waitlistRegistration.create({
      data: {
        offerId: OFFER,
        fullName: p.fullName,
        phone: p.phone,
        email: p.email,
        consentAt: new Date(),
        reference,
        amountKobo,
        status,
        ...(status === 'pending'
          ? {}
          : {
              flutterwaveTxId: `legacy-${tx}`,
              paidKobo: amountKobo,
              ...(status === 'paid' ? { paidAt: new Date() } : {}),
            }),
      } as never,
    });
  };

  const cleanUp = async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await prisma.referralCode.deleteMany({
      where: { code: { startsWith: 'RFA' } },
    });
  };

  beforeAll(async () => {
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'ref01-access-secret-0123456789abcdef01';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'ref01-refresh-secret-0123456789abcdef0';
    config = configWith((raw) => {
      raw.event_offers = [openOffer({ id: OFFER })];
    });
    app = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({
      where: { id: { in: ADMINS.map((a) => a[0]) } },
    });
    await prisma.adminUser.createMany({
      data: ADMINS.map(([id, role]) => ({
        id,
        email: email(role),
        passwordHash,
        name: `R01 ${role}`,
        role,
      })),
    });
    for (const [, role] of ADMINS) {
      const res = await http()
        .post('/api/hub/admin/auth/login')
        .send({ email: email(role), password: PASSWORD })
        .expect(200);
      tokens[role] = res.body.data.accessToken as string;
    }
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    userToken = jwt.sign(
      {
        sub: 'r01-user',
        email: 'r01-user@test.wawu.dev',
        phone: '+2348031234567',
        status: 'active',
      },
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { algorithm: 'RS256', keyid: 'ref01-throwaway', expiresIn: '15m' },
    );
    await cleanUp();
  }, 90_000);

  afterAll(async () => {
    await cleanUp();
    await prisma.adminUser.deleteMany({
      where: { id: { in: ADMINS.map((a) => a[0]) } },
    });
    await app.close();
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  describe('who may do what', () => {
    it('lets superadmin, finance and support read the list and the totals; reviewer, a user and no token are refused', async () => {
      for (const path of [
        `${BASE}/referral-codes`,
        `${BASE}/registrations/summary`,
      ]) {
        for (const role of ['superadmin', 'finance', 'support']) {
          await http().get(path).set(as(role)).expect(200);
        }
        await http().get(path).set(as('reviewer')).expect(403);
        await http()
          .get(path)
          .set({ Authorization: `Bearer ${userToken}` })
          .expect(401);
        await http().get(path).expect(401);
      }
    });

    it('lets only superadmin create or change a code', async () => {
      const body = { code: 'RFAROLE', community: 'Roles', priceKobo: 100000 };
      for (const role of ['finance', 'support', 'reviewer']) {
        await http()
          .post(`${BASE}/referral-codes`)
          .set(as(role))
          .send(body)
          .expect(403);
        await http()
          .patch(`${BASE}/referral-codes/anything`)
          .set(as(role))
          .send({ active: false })
          .expect(403);
      }
      await http().post(`${BASE}/referral-codes`).send(body).expect(401);
      await http()
        .post(`${BASE}/referral-codes`)
        .set({ Authorization: `Bearer ${userToken}` })
        .send(body)
        .expect(401);
      expect(
        await prisma.referralCode.count({ where: { code: 'RFAROLE' } }),
      ).toBe(0);
      const made = await http()
        .post(`${BASE}/referral-codes`)
        .set(as('superadmin'))
        .send(body)
        .expect(200);
      expect(data(made)).toMatchObject({ code: 'RFAROLE', active: true });
    });
  });

  describe('creating and changing codes', () => {
    it('creates a code upper-cased, with the answer the list would give, and records who made it', async () => {
      const res = await http()
        .post(`${BASE}/referral-codes`)
        .set(as('superadmin'))
        .send({
          code: 'rfaFree1',
          community: '  Law   School  ',
          priceKobo: 0,
          limit: 250,
        })
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(data(res)).toMatchObject({
        code: 'RFAFREE1',
        community: 'Law School',
        priceKobo: 0,
        limit: 250,
        active: true,
        paidCount: 0,
        heldCount: 0,
        paidKobo: 0,
      });
      const row = await prisma.referralCode.findUniqueOrThrow({
        where: { code: 'RFAFREE1' },
      });
      expect(row.createdBy).toBe(ADMINS[0][0]);
      // No limit is null; the standard price is allowed ("for tracking only").
      const open = await http()
        .post(`${BASE}/referral-codes`)
        .set(as('superadmin'))
        .send({
          code: 'RFATRACK',
          community: 'Tracking',
          priceKobo: standard(),
        })
        .expect(200);
      expect(data(open)).toMatchObject({ limit: null, priceKobo: standard() });
    });

    it('refuses what the rules refuse: a bad code, a price above the standard, a negative or fractional price, a bad limit, a blank community, a taken code', async () => {
      const bad = async (body: object, status: number, code?: string) => {
        const res = await http()
          .post(`${BASE}/referral-codes`)
          .set(as('superadmin'))
          .send({ code: 'RFABAD', community: 'Bad', priceKobo: 1, ...body })
          .expect(status);
        if (code) expect(reason(res).code).toBe(code);
        // No em-dash in anything a person reads.
        expect(JSON.stringify(res.body)).not.toContain('—');
      };
      await bad({ code: 'AB' }, 400, 'referral_invalid');
      await bad({ code: 'A'.repeat(21) }, 400);
      await bad({ code: 'AB CD' }, 400, 'referral_invalid');
      await bad({ code: 'AB-CD' }, 400, 'referral_invalid');
      await bad({ priceKobo: standard() + 1 }, 400, 'referral_invalid');
      await bad({ priceKobo: -1 }, 400);
      await bad({ priceKobo: 10.5 }, 400);
      await bad({ limit: 0 }, 400);
      await bad({ limit: 1.5 }, 400);
      await bad({ community: '   ' }, 400, 'referral_invalid');
      await bad({ community: '' }, 400);
      await bad({ code: 'logoart' }, 409, 'referral_code_taken');
      expect(
        await prisma.referralCode.count({ where: { code: 'RFABAD' } }),
      ).toBe(0);
    });

    it('changes the price, the limit (and clears it), the community and on or off, one at a time or together; the code never changes', async () => {
      const made = data(
        await http()
          .post(`${BASE}/referral-codes`)
          .set(as('superadmin'))
          .send({
            code: 'RFACHANGE',
            community: 'Before',
            priceKobo: 120000,
            limit: 10,
          })
          .expect(200),
      );
      const patch = (body: object) =>
        http()
          .patch(`${BASE}/referral-codes/${made.id}`)
          .set(as('superadmin'))
          .send(body);
      expect(
        data(await patch({ priceKobo: 100000 }).expect(200)),
      ).toMatchObject({
        priceKobo: 100000,
        limit: 10,
        community: 'Before',
        active: true,
        code: 'RFACHANGE',
      });
      expect(data(await patch({ limit: 20 }).expect(200)).limit).toBe(20);
      expect(data(await patch({ limit: null }).expect(200)).limit).toBeNull();
      expect(
        data(await patch({ community: ' After ' }).expect(200)).community,
      ).toBe('After');
      expect(data(await patch({ active: false }).expect(200)).active).toBe(
        false,
      );
      expect(
        data(await patch({ active: true, priceKobo: 0, limit: 5 }).expect(200)),
      ).toMatchObject({ active: true, priceKobo: 0, limit: 5 });
      // Refused: a price above the standard, nothing to change, a code that is not there, a stray field.
      expect(
        reason(await patch({ priceKobo: standard() + 1 }).expect(400)).code,
      ).toBe('referral_invalid');
      expect(reason(await patch({}).expect(400)).code).toBe('referral_invalid');
      await patch({ code: 'OTHER' }).expect(400);
      await patch({ limit: 0 }).expect(400);
      const gone = await http()
        .patch(`${BASE}/referral-codes/00000000-0000-4000-8000-000000000000`)
        .set(as('superadmin'))
        .send({ active: false })
        .expect(404);
      expect(reason(gone).code).toBe('referral_not_found');
      // Never deleted: there is no delete route.
      await http()
        .delete(`${BASE}/referral-codes/${made.id}`)
        .set(as('superadmin'))
        .expect(404);
    });

    it('lets a price or limit change touch only the registrations started after it', async () => {
      const made = data(
        await http()
          .post(`${BASE}/referral-codes`)
          .set(as('superadmin'))
          .send({ code: 'RFALATER', community: 'Later', priceKobo: 120000 })
          .expect(200),
      );
      const before = data(
        await register(person({ referralCode: 'rfalater' })).expect(200),
      );
      expect(before.amountKobo).toBe(120000);
      await http()
        .patch(`${BASE}/referral-codes/${made.id}`)
        .set(as('superadmin'))
        .send({ priceKobo: 90000, limit: 1 })
        .expect(200);
      // The registration made before keeps its price, and still settles at it.
      expect(
        (
          await prisma.waitlistRegistration.findUniqueOrThrow({
            where: { reference: before.reference },
          })
        ).amountKobo,
      ).toBe(120000);
      await pay(before.reference, 1200).expect(200);
      // The next start sees the new price; the limit of 1 is now used up by the paid place.
      const after = data(
        await register(person({ referralCode: 'RFALATER' })).expect(200),
      );
      expect(after.referral).toEqual({
        code: 'RFALATER',
        applied: false,
        reason: 'full',
      });
      await http()
        .patch(`${BASE}/referral-codes/${made.id}`)
        .set(as('superadmin'))
        .send({ limit: 5 })
        .expect(200);
      const later = data(
        await register(person({ referralCode: 'RFALATER' })).expect(200),
      );
      expect(later.amountKobo).toBe(90000);
    });
  });

  describe('the list of codes', () => {
    it('gives each code its paid count, held count, money paid and limit', async () => {
      const made = data(
        await http()
          .post(`${BASE}/referral-codes`)
          .set(as('superadmin'))
          .send({
            code: 'RFACOUNT',
            community: 'Counting',
            priceKobo: 120000,
            limit: 50,
          })
          .expect(200),
      );
      const paid1 = data(
        await register(person({ referralCode: 'RFACOUNT' })).expect(200),
      );
      const paid2 = data(
        await register(person({ referralCode: 'RFACOUNT' })).expect(200),
      );
      await pay(paid1.reference, 1200).expect(200);
      await pay(paid2.reference, 1500).expect(200); // overpaid: paidKobo is what was paid
      const held = data(
        await register(person({ referralCode: 'RFACOUNT' })).expect(200),
      );
      const stale = data(
        await register(person({ referralCode: 'RFACOUNT' })).expect(200),
      );
      await prisma.waitlistRegistration.update({
        where: { reference: stale.reference },
        data: { createdAt: new Date(Date.now() - 31 * 60_000) },
      });
      expect(held.referral.applied).toBe(true);
      const res = await http()
        .get(`${BASE}/referral-codes`)
        .set(as('finance'))
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const row = data<any[]>(res).find((c) => c.id === made.id);
      expect(row).toMatchObject({
        code: 'RFACOUNT',
        community: 'Counting',
        priceKobo: 120000,
        limit: 50,
        active: true,
        paidCount: 2,
        heldCount: 1,
        paidKobo: 120000 + 150000,
      });
      // LOGOART is there from the migration, with its own numbers.
      const logo = data<any[]>(res).find((c) => c.code === 'LOGOART');
      expect(logo).toMatchObject({
        priceKobo: 120000,
        limit: 4000,
        active: true,
      });
      // The first made first.
      const codes = data<any[]>(res).map((c) => c.code);
      expect(codes.indexOf('LOGOART')).toBeLessThan(codes.indexOf('RFACOUNT'));
    });
  });

  describe('the totals of the whole offer', () => {
    it('counts every paid registration, those before codes included in a "No code" row, with the failed ones apart and unpaid ones not money', async () => {
      const summary = async () =>
        data(
          await http()
            .get(`${BASE}/registrations/summary?offerId=${OFFER}`)
            .set(as('support'))
            .expect(200),
        );
      // What earlier tests of this file left on the offer.
      const was = await summary();
      // Made before referral codes existed: plain rows with no code.
      await legacy('paid');
      await legacy('paid', 150000);
      await legacy('failed');
      await legacy('pending');
      // Made after: two on a code (one free), one who used a full code and so pays standard.
      await http()
        .post(`${BASE}/referral-codes`)
        .set(as('superadmin'))
        .send({
          code: 'RFASPLIT',
          community: 'Split',
          priceKobo: 120000,
          limit: 2,
        })
        .expect(200);
      await http()
        .post(`${BASE}/referral-codes`)
        .set(as('superadmin'))
        .send({ code: 'RFAZERO', community: 'Zero', priceKobo: 0 })
        .expect(200);
      const a = data(
        await register(person({ referralCode: 'RFASPLIT' })).expect(200),
      );
      const b = data(
        await register(person({ referralCode: 'RFASPLIT' })).expect(200),
      );
      const full = data(
        await register(person({ referralCode: 'RFASPLIT' })).expect(200),
      );
      expect(full.referral.reason).toBe('full');
      await pay(a.reference, 1200).expect(200);
      await pay(b.reference, 1200).expect(200);
      await pay(full.reference, standard() / 100).expect(200);
      await register(person({ referralCode: 'RFAZERO' })).expect(200);
      await register(person()).expect(200); // started, never paid

      const res = await http()
        .get(`${BASE}/registrations/summary?offerId=${OFFER}`)
        .set(as('support'))
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const sum = data(res);
      expect(sum.offerId).toBe(OFFER);
      expect(sum.paid).toEqual({
        people: was.paid.people + 2 + 2 + 1 + 1,
        kobo:
          was.paid.kobo + (200000 + 150000 + 120000 + 120000 + standard() + 0),
      });
      expect(sum.failed).toEqual({
        people: was.failed.people + 1,
        kobo: was.failed.kobo + 200000,
      });
      expect(sum.unpaid).toBe(was.unpaid + 2);
      const rows: any[] = sum.split;
      // One row per code, then the "No code" row, last.
      expect(rows[rows.length - 1].code).toBeNull();
      expect(rows[rows.length - 1].community).toBeNull();
      expect(rows.filter((r) => r.code === null)).toHaveLength(1);
      expect(rows.find((r) => r.code === 'RFASPLIT')).toEqual({
        code: 'RFASPLIT',
        community: 'Split',
        people: 2,
        kobo: 240000,
      });
      expect(rows.find((r) => r.code === 'RFAZERO')).toEqual({
        code: 'RFAZERO',
        community: 'Zero',
        people: 1,
        kobo: 0,
      });
      // The "No code" row holds the two plain rows from before codes and the one who paid standard after a full code.
      const noCodeWas = was.split[was.split.length - 1];
      expect(rows[rows.length - 1]).toMatchObject({
        people: noCodeWas.people + 3,
        kobo: noCodeWas.kobo + 200000 + 150000 + standard(),
      });
      // A code nobody used yet is still a row.
      expect(rows.find((r) => r.code === 'LOGOART')).toBeDefined();
      // The people in the split add up to the people paid, for this offer's codes and no code.
      // Every paid person of the offer is in exactly one row of the split.
      expect(rows.reduce((t, r) => t + r.people, 0)).toBe(sum.paid.people);
      expect(rows.reduce((t, r) => t + r.kobo, 0)).toBe(sum.paid.kobo);
    });

    it('counts all offers when none is named', async () => {
      const all = data(
        await http()
          .get(`${BASE}/registrations/summary`)
          .set(as('finance'))
          .expect(200),
      );
      const mine = data(
        await http()
          .get(`${BASE}/registrations/summary?offerId=${OFFER}`)
          .set(as('finance'))
          .expect(200),
      );
      expect(all.offerId).toBeNull();
      expect(all.paid.people).toBeGreaterThanOrEqual(mine.paid.people);
    });
  });

  describe('the people, and their CSV, by code', () => {
    it('shows the code and community on each row and filters by one code, by no code, and by status', async () => {
      const list = (qs: string) =>
        http()
          .get(`${BASE}/registrations?offerId=${OFFER}&perPage=100&${qs}`)
          .set(as('support'));
      const all = data<any[]>(await list('').expect(200));
      const mine = all.filter((r) => r.fullName.includes(MARK));
      expect(mine.length).toBeGreaterThan(8);
      const split = mine.filter((r) => r.referralCode === 'RFASPLIT');
      expect(split).toHaveLength(2);
      expect(split[0]).toMatchObject({
        referralCode: 'RFASPLIT',
        referralCommunity: 'Split',
        amountKobo: 120000,
        paidKobo: 120000,
        status: 'paid',
      });
      // By one code, in any case.
      const byCode = data<any[]>(
        await list('referralCode=rfasplit').expect(200),
      );
      expect(byCode).toHaveLength(2);
      expect(byCode.every((r) => r.referralCode === 'RFASPLIT')).toBe(true);
      // By no code: every row without one, the old ones included.
      const none = data<any[]>(await list('noReferral=true').expect(200));
      expect(none.length).toBeGreaterThanOrEqual(5);
      expect(none.every((r) => r.referralCode === null)).toBe(true);
      expect(none.some((r) => r.fullName.startsWith('Legacy'))).toBe(true);
      // By status, with a code and without.
      const paidNone = data<any[]>(
        await list('noReferral=true&status=paid').expect(200),
      );
      expect(
        paidNone.every((r) => r.status === 'paid' && r.referralCode === null),
      ).toBe(true);
      const failedNone = data<any[]>(
        await list('noReferral=true&status=failed').expect(200),
      );
      expect(failedNone).toHaveLength(1);
      // A code that does not exist matches nobody; both filters at once, or a bad value, is a 400.
      expect(data(await list('referralCode=NOPE').expect(200))).toEqual([]);
      await list('referralCode=RFASPLIT&noReferral=true').expect(400);
      await list('noReferral=maybe').expect(400);
    });

    it('downloads the same filter as a CSV with the Referral code and Community columns last', async () => {
      const file = async (qs: string) => {
        const res = await http()
          .get(`${BASE}/registrations/export?offerId=${OFFER}&${qs}`)
          .set(as('finance'))
          .expect(200);
        const f = data(res);
        const lines = (f.content as string)
          .slice(1)
          .split('\r\n')
          .filter(Boolean);
        return { f, lines };
      };
      const split = await file('referralCode=RFASPLIT');
      expect(split.f.rowCount).toBe(2);
      expect(split.f.fileName).toMatch(
        new RegExp(
          `^registrations-${OFFER}-RFASPLIT-\\d{4}-\\d{2}-\\d{2}\\.csv$`,
        ),
      );
      const header = split.lines[0].split(',');
      expect(header.slice(-2)).toEqual(['Referral code', 'Community']);
      for (const line of split.lines.slice(1)) {
        const cells = line.split(',');
        expect(cells.slice(-2)).toEqual(['RFASPLIT', 'Split']);
      }
      const none = await file('noReferral=true');
      expect(none.f.fileName).toMatch(
        new RegExp(
          `^registrations-${OFFER}-nocode-\\d{4}-\\d{2}-\\d{2}\\.csv$`,
        ),
      );
      expect(none.f.rowCount).toBeGreaterThanOrEqual(5);
      for (const line of none.lines.slice(1)) {
        expect(line.split(',').slice(-2)).toEqual(['', '']);
      }
      const paidOnly = await file('status=paid&referralCode=RFAZERO');
      expect(paidOnly.f.rowCount).toBe(1);
      await http()
        .get(
          `${BASE}/registrations/export?referralCode=RFASPLIT&noReferral=true`,
        )
        .set(as('finance'))
        .expect(400);
      await http()
        .get(`${BASE}/registrations/export?referralCode=RFASPLIT`)
        .set(as('reviewer'))
        .expect(403);
    });
  });
});

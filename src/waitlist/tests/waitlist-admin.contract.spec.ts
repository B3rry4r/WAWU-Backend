// The spec reads response bodies.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { generateKeyPairSync } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlansConfig } from '../../plans/plans-config';
import { WaitlistService } from '../waitlist.service';
import {
  bootWaitlist,
  configWith,
  ScriptedFlutterwave,
  OFFER_ID,
  openOffer,
} from './waitlist-harness';

/**
 * JOIN-01, the team's side: every paid and pending row for an offer is listed
 * (paginated) and exported as a CSV, for the roles the matrix allows; a
 * reviewer, a user token and no token are refused.
 */

const MARK = 'join01-admin-spec';
const ADMINS = [
  ['ad010100-0000-4000-8000-000000000001', 'superadmin'],
  ['ad010100-0000-4000-8000-000000000002', 'reviewer'],
  ['ad010100-0000-4000-8000-000000000003', 'support'],
  ['ad010100-0000-4000-8000-000000000004', 'finance'],
] as const;
const email = (role: string) => `j01-${role}@admin.test.wawu.dev`;
const PASSWORD = 'join01-admin-contract-password';
const KEYS = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];

describe('Event registrations, the team view (JOIN-01)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let waitlist: WaitlistService;
  let config: PlansConfig;
  const fake = new ScriptedFlutterwave();
  const tokens: Record<string, string> = {};
  const snapshot: Record<string, string | undefined> = {};
  let userToken: string;
  const http = () => request(app.getHttpServer());
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  let paidRefs: string[] = [];
  let pendingRefs: string[] = [];
  let tx = 8_000_000;

  async function register(i: number, over: Record<string, unknown> = {}) {
    return waitlist.register({
      offerId: OFFER_ID,
      fullName: `Admin Person ${i} ${MARK}`,
      phone: `+23490${String(30_000_000 + i).slice(-8)}`,
      email: `${MARK}-${i}@test.wawu.dev`,
      consent: true,
      ...over,
    });
  }

  beforeAll(async () => {
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'join01-access-secret-0123456789abcdef01';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'join01-refresh-secret-0123456789abcdef0';
    config = configWith((raw) => {
      raw.event_offers = [openOffer(), openOffer({ id: 'other-offer' })];
    });
    app = await bootWaitlist(config, fake);
    prisma = app.get(PrismaService);
    waitlist = app.get(WaitlistService);
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
        name: `J01 ${role}`,
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
    // A signed-in app user's kind of token (RS256, as WAWU ID signs), from a
    // throwaway key: an admin route must refuse it whoever signed it.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    userToken = jwt.sign(
      {
        sub: 'j01-user',
        email: 'j01-user@test.wawu.dev',
        phone: '+2348031234567',
        status: 'active',
      },
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { algorithm: 'RS256', keyid: 'join01-throwaway', expiresIn: '15m' },
    );
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });

    // Five paid, three pending, in the first offer; one pending in the other.
    paidRefs = [];
    pendingRefs = [];
    for (let i = 1; i <= 8; i++) {
      const r = await register(
        i,
        i === 2
          ? { fullName: `=HYPERLINK("http://x","click") ${MARK}` }
          : // The two free-text fields come from people too.
            i === 3
            ? { state: '+SUM(1+1)', makes: '@SUM(2+2)' }
            : {},
      );
      if (i <= 5) {
        tx += 1;
        fake.payments.set(String(tx), {
          status: 'successful',
          amount: config.eventOffers[0].priceKobo / 100,
          currency: 'NGN',
          txRef: r.reference,
        });
        await waitlist.verify({
          reference: r.reference,
          transactionId: String(tx),
        });
        paidRefs.push(r.reference);
      } else pendingRefs.push(r.reference);
    }
    const o = await register(9, { offerId: 'other-offer' });
    pendingRefs.push(o.reference);
  }, 90_000);

  afterAll(async () => {
    await prisma.waitlistRegistration.deleteMany({
      where: { fullName: { contains: MARK } },
    });
    await prisma.adminUser.deleteMany({
      where: { id: { in: ADMINS.map((a) => a[0]) } },
    });
    await app.close();
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('lists every paid and pending row of the offer, newest first, paginated, with the phone, email and amounts', async () => {
    const res = await http()
      .get(
        `/api/hub/admin/waitlist/registrations?offerId=${OFFER_ID}&perPage=100`,
      )
      .set(as('finance'))
      .expect(200);
    const mine = (res.body.data as any[]).filter((r) =>
      r.fullName.includes(MARK),
    );
    expect(mine).toHaveLength(8);
    expect(mine.filter((r) => r.status === 'paid')).toHaveLength(5);
    expect(mine.filter((r) => r.status === 'pending')).toHaveLength(3);
    const paid = mine.find((r) => r.reference === paidRefs[0]);
    expect(paid).toMatchObject({
      offerId: OFFER_ID,
      status: 'paid',
      amountKobo: config.eventOffers[0].priceKobo,
      paidKobo: config.eventOffers[0].priceKobo,
      claimedByWawuId: null,
      claimedAt: null,
      phone: expect.stringMatching(/^\+23490\d{8}$/),
      email: expect.stringContaining(MARK),
    });
    expect(paid.flutterwaveTransactionId).toMatch(/^\d+$/);
    const dates = mine.map((r) => r.createdAt as string);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(res.body.pagination).toMatchObject({ currentPage: 1, perPage: 100 });
    // Narrowing by status, and paging.
    const pending = await http()
      .get(
        `/api/hub/admin/waitlist/registrations?offerId=${OFFER_ID}&status=pending&perPage=100`,
      )
      .set(as('superadmin'))
      .expect(200);
    expect(
      (pending.body.data as any[]).every((r) => r.status === 'pending'),
    ).toBe(true);
    const page = await http()
      .get(
        `/api/hub/admin/waitlist/registrations?offerId=${OFFER_ID}&perPage=3&page=2`,
      )
      .set(as('support'))
      .expect(200);
    expect(page.body.data).toHaveLength(3);
    expect(page.body.pagination).toMatchObject({ currentPage: 2, perPage: 3 });
    // The other offer is its own list.
    const other = await http()
      .get('/api/hub/admin/waitlist/registrations?offerId=other-offer')
      .set(as('superadmin'))
      .expect(200);
    expect(
      (other.body.data as any[]).filter((r) => r.fullName.includes(MARK)),
    ).toHaveLength(1);
    await http()
      .get('/api/hub/admin/waitlist/registrations?status=nonsense')
      .set(as('superadmin'))
      .expect(400);
    await http()
      .get('/api/hub/admin/waitlist/registrations?perPage=1000')
      .set(as('superadmin'))
      .expect(400);
  });

  it('exports a CSV of every paid and pending row: a byte-order mark, a header, one line each, naira with two decimals, formulas neutralised', async () => {
    const res = await http()
      .get(`/api/hub/admin/waitlist/registrations/export?offerId=${OFFER_ID}`)
      .set(as('finance'))
      .expect(200);
    const file = res.body.data;
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.fileName).toMatch(
      new RegExp(`^registrations-${OFFER_ID}-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
    );
    expect(file.content.startsWith('﻿')).toBe(true);
    const lines = (file.content as string)
      .slice(1)
      .split('\r\n')
      .filter(Boolean);
    expect(lines[0]).toBe(
      'Registered at,Offer,Status,Full name,Phone,Email,State,What they make,Fee (₦),Paid (₦),Paid at,Reference,Transaction id,Claimed at',
    );
    const mine = lines.slice(1).filter((l) => l.includes(MARK));
    expect(mine).toHaveLength(8);
    expect(file.rowCount).toBe(lines.length - 1);
    const fee = (config.eventOffers[0].priceKobo / 100).toFixed(2);
    const paidLine = mine.find(
      (l) => l.includes(paidRefs[1]) === false && l.includes(',paid,'),
    )!;
    expect(paidLine).toContain(`,${fee},${fee},`);
    const pendingLine = mine.find((l) => l.includes(pendingRefs[0]))!;
    expect(pendingLine).toContain(`,pending,`);
    expect(pendingLine).toContain(`,${fee},,,`);
    // A name that a spreadsheet would run as a formula is written with a quote in front.
    const formulaLine = mine.find((l) => l.includes('HYPERLINK'))!;
    expect(formulaLine).toContain(
      `"'=HYPERLINK(""http://x"",""click"") ${MARK}"`,
    );
    expect(mine.some((l) => /(^|,)=/.test(l))).toBe(false);
    // Narrowed by status.
    const paidOnly = await http()
      .get(
        `/api/hub/admin/waitlist/registrations/export?offerId=${OFFER_ID}&status=paid`,
      )
      .set(as('support'))
      .expect(200);
    expect(
      (paidOnly.body.data.content as string)
        .split('\r\n')
        .filter((l) => l.includes(MARK)),
    ).toHaveLength(5);
  });

  it('neutralises a formula typed into the state or what-they-make field too, not only the name', async () => {
    const res = await http()
      .get(`/api/hub/admin/waitlist/registrations/export?offerId=${OFFER_ID}`)
      .set(as('finance'))
      .expect(200);
    const lines = (res.body.data.content as string).split('\r\n');
    const line = lines.find((l) => l.includes(paidRefs[2]))!;
    // None of these cells holds a comma or a quote, so a plain split keeps the columns.
    const cells = line.split(',');
    const header = lines.find((l) => l.includes('Registered at'))!.split(',');
    expect(cells[header.indexOf('State')]).toBe("'+SUM(1+1)");
    expect(cells[header.indexOf('What they make')]).toBe("'@SUM(2+2)");
    // The list (JSON) still gives the real text; only the CSV is guarded.
    const list = await http()
      .get(
        `/api/hub/admin/waitlist/registrations?offerId=${OFFER_ID}&perPage=100`,
      )
      .set(as('finance'))
      .expect(200);
    const row = (list.body.data as any[]).find(
      (r) => r.reference === paidRefs[2],
    );
    expect([row.state, row.makes]).toEqual(['+SUM(1+1)', '@SUM(2+2)']);
  });

  it('refuses a reviewer on the list and the export, and refuses a user token and no token on every route', async () => {
    for (const path of [
      '/api/hub/admin/waitlist/registrations',
      '/api/hub/admin/waitlist/registrations/export',
    ]) {
      await http().get(path).set(as('reviewer')).expect(403);
      await http()
        .get(path)
        .set({ Authorization: `Bearer ${userToken}` })
        .expect(401);
      await http()
        .get(path)
        .set({ Authorization: 'Bearer not-a-token' })
        .expect(401);
      await http().get(path).expect(401);
      for (const role of ['superadmin', 'finance', 'support'])
        await http().get(path).set(as(role)).expect(200);
    }
  });

  it('has no route that changes a registration: write methods on the admin paths are not served', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await http()
        [method]('/api/hub/admin/waitlist/registrations')
        .set(as('superadmin'));
      expect(res.status).toBe(404);
    }
  });
});

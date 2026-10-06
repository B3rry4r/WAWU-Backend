// Run against wawu_hub_test — always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProfessionalModule } from '../professional.module';
import { REPLY_TIME_DEFAULTS } from '../professional-reply-time';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

const MINUTE = 60_000;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface DirectoryEntry {
  id: string;
  wawuId: string;
  category: string;
  field: { id: string; label: string } | null;
  city: string | null;
  usualReplyMinutes: number | null;
  answeredMessageCount: number;
  messagePriceKobo: number | null;
  dmEnabled: boolean;
  dmResponseHours: number;
}

interface Envelope<T> {
  data: T;
  pagination?: { perPage: number; total: number };
}

/** The response envelope, typed, so a test never reads an `any`. */
const bodyOf = <T = Record<string, unknown>>(res: { body: unknown }) =>
  res.body as Envelope<T>;

/**
 * The mobile directory (PROS-02): the canvas's fields over the categories,
 * and city, usual reply time and message price on every professional.
 *
 * Professionals here are made up for each run (random ids, their own
 * UserProfile, CreatorState and DirectMessage rows) so their reply times and
 * fields are exactly what each test wrote, whatever other suites left in the
 * shared test database. The seeded creator is used only where a real token
 * is needed (setting a city).
 */
describe('Professional directory: fields, city, reply time, price (contract)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let creatorToken: string;
  let plainToken: string;
  const made: string[] = [];

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        ProfessionalModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    creatorToken = await login('creator-pro@test.wawu.dev');
    plainToken = await login('user@test.wawu.dev');
  }, 40000);

  async function cleanUp(): Promise<void> {
    if (made.length > 0) {
      await prisma.directMessage.deleteMany({
        where: { creatorWawuId: { in: made } },
      });
      await prisma.professionalProfile.deleteMany({
        where: { wawuUserId: { in: made } },
      });
      await prisma.professionalLocation.deleteMany({
        where: { wawuUserId: { in: made } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: made } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: made } },
      });
      made.length = 0;
    }
    await prisma.blockedAccount.deleteMany({
      where: {
        OR: [{ userWawuId: USER_PLAIN }, { blockedWawuId: USER_PLAIN }],
      },
    });
    await prisma.professionalLocation.deleteMany({
      where: { wawuUserId: { in: [USER_CREATOR_PRO, USER_PLAIN] } },
    });
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: { in: [USER_CREATOR_PRO, USER_PLAIN] } },
    });
  }

  beforeEach(cleanUp);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  /**
   * A made-up professional with an approved, listed profile in `category`,
   * taking paid messages at `dmPrice` naira (or not, when null).
   */
  async function professional(
    category: string,
    opts: { dmPrice?: number | null; status?: 'approved' | 'pending' } = {},
  ): Promise<{ wawuId: string; listingId: string }> {
    const wawuId = randomUUID();
    made.push(wawuId);
    await prisma.userProfile.create({
      data: {
        wawuUserId: wawuId,
        accountType: 'creator',
        handle: `pros02_${wawuId.slice(0, 8)}`,
      },
    });
    const dmPrice = opts.dmPrice === undefined ? 5000 : opts.dmPrice;
    await prisma.creatorState.create({
      data: {
        wawuUserId: wawuId,
        dmEnabled: dmPrice !== null,
        dmPrice,
        dmResponseHours: 24,
      },
    });
    const listing = await prisma.professionalProfile.create({
      data: {
        wawuUserId: wawuId,
        category,
        headline: 'Chartered accountant, 9 years',
        about:
          'I help creators and small businesses file taxes, keep books and register with CAC.',
        services: ['Tax filing', 'Bookkeeping'],
        credentialKind: 'licence',
        licenceNumber: 'ICAN/2016/40921',
        issuingBody: 'ICAN',
        status: opts.status ?? 'approved',
        reviewedAt: new Date(),
      },
    });
    return { wawuId, listingId: listing.id };
  }

  /** A paid message to `creatorWawuId`, answered `minutes` after it was sent. */
  async function answered(
    creatorWawuId: string,
    minutes: number,
    answeredMinutesAgo = 0,
  ): Promise<void> {
    const respondedAt = new Date(Date.now() - answeredMinutesAgo * MINUTE);
    const sentAt = new Date(respondedAt.getTime() - minutes * MINUTE);
    await prisma.directMessage.create({
      data: {
        creatorWawuId,
        senderWawuId: USER_PLAIN,
        text: 'Could you look at my tax filing?',
        amount: 5000,
        status: 'responded',
        sentAt,
        deadlineAt: new Date(sentAt.getTime() + 24 * 60 * MINUTE),
        respondedAt,
        responseText: 'Yes, send it over.',
        flutterwaveTxRef: `pros02-${randomUUID()}`,
      },
    });
  }

  async function unanswered(
    creatorWawuId: string,
    status: 'awaiting_response' | 'refunded',
    minutesAgo: number,
  ): Promise<void> {
    const sentAt = new Date(Date.now() - minutesAgo * MINUTE);
    await prisma.directMessage.create({
      data: {
        creatorWawuId,
        senderWawuId: USER_PLAIN,
        text: 'Are you there?',
        amount: 5000,
        status,
        sentAt,
        deadlineAt: new Date(sentAt.getTime() + 24 * 60 * MINUTE),
        flutterwaveTxRef: `pros02-${randomUUID()}`,
      },
    });
  }

  const directory = (query: Record<string, string | number> = {}) =>
    request(app.getHttpServer())
      .get('/professionals/directory')
      .query({ perPage: 50, ...query });

  /** Every page of the directory for a query, so a busy test database never hides a row. */
  async function allOf(
    query: Record<string, string> = {},
  ): Promise<DirectoryEntry[]> {
    const out: DirectoryEntry[] = [];
    for (let page = 1; page < 50; page++) {
      const res = await directory({ ...query, page }).expect(200);
      const rows = bodyOf<DirectoryEntry[]>(res).data;
      out.push(...rows);
      if (rows.length < 50) break;
    }
    return out;
  }

  const entryFor = (rows: DirectoryEntry[], wawuId: string) =>
    rows.find((r) => r.wawuId === wawuId);

  // ---- the fields ----------------------------------------------------------

  it("lists the canvas's fields, in the canvas's order, each mapped to categories", async () => {
    const res = await request(app.getHttpServer())
      .get('/professionals/fields')
      .expect(200);
    const fields = bodyOf<
      Array<{
        id: string;
        label: string;
        categories: string[];
        applyCategory: string;
        regulated: boolean;
      }>
    >(res).data;
    expect(fields.map((f) => f.label)).toEqual([
      'Accounting & Tax',
      'Legal & Compliance',
      'Design & Creative',
      'Technology & IT',
      'Engineering',
      'Healthcare',
      'Business & Consulting',
    ]);
    const byId = new Map(fields.map((f) => [f.id, f]));
    expect(byId.get('accounting_tax')).toEqual({
      id: 'accounting_tax',
      label: 'Accounting & Tax',
      categories: ['finance'],
      applyCategory: 'finance',
      regulated: true,
    });
    // Regulated follows the category's own rule, never a second list.
    expect(byId.get('legal_compliance')?.regulated).toBe(true);
    expect(byId.get('healthcare')?.regulated).toBe(true);
    expect(byId.get('technology_it')?.regulated).toBe(false);
    expect(byId.get('engineering')?.regulated).toBe(false);
    expect(byId.get('business_consulting')?.categories).toEqual([
      'professional_services',
      'business_entrepreneurship',
    ]);
    // Every field's applyCategory is one of its own categories.
    for (const f of fields) expect(f.categories).toContain(f.applyCategory);
  });

  it('serves the fields without a token', async () => {
    await request(app.getHttpServer()).get('/professionals/fields').expect(200);
  });

  // ---- filtering by field (capability check 1) ------------------------------

  it('a user filtering by a field gets the professionals in that field, and only them', async () => {
    const accountant = await professional('finance');
    const engineer = await professional('technology');
    const advisor = await professional('professional_services');
    const founder = await professional('business_entrepreneurship');
    const farmer = await professional('agriculture_food');

    const accounting = await allOf({ field: 'accounting_tax' });
    expect(entryFor(accounting, accountant.wawuId)).toBeDefined();
    expect(entryFor(accounting, engineer.wawuId)).toBeUndefined();
    expect(accounting.every((r) => r.category === 'finance')).toBe(true);
    expect(entryFor(accounting, accountant.wawuId)?.field).toEqual({
      id: 'accounting_tax',
      label: 'Accounting & Tax',
    });

    const tech = await allOf({ field: 'technology_it' });
    expect(entryFor(tech, engineer.wawuId)?.field).toEqual({
      id: 'technology_it',
      label: 'Technology & IT',
    });
    expect(entryFor(tech, accountant.wawuId)).toBeUndefined();

    // One field over two categories.
    const business = await allOf({ field: 'business_consulting' });
    expect(entryFor(business, advisor.wawuId)).toBeDefined();
    expect(entryFor(business, founder.wawuId)).toBeDefined();
    expect(entryFor(business, accountant.wawuId)).toBeUndefined();

    // "All": everyone, and a listing no field covers shows with no field.
    const all = await allOf();
    for (const p of [accountant, engineer, advisor, founder, farmer]) {
      expect(entryFor(all, p.wawuId)).toBeDefined();
    }
    expect(entryFor(all, farmer.wawuId)?.field).toBeNull();
  });

  it('an empty field answers an empty page, not an error (P4)', async () => {
    // Nobody this run made is in Engineering; whatever other suites left is
    // all engineering too, never another field's listing.
    await professional('finance');
    const res = await directory({ field: 'engineering' }).expect(200);
    for (const r of bodyOf<DirectoryEntry[]>(res).data) {
      expect(r.category).toBe('engineering');
    }
    expect(bodyOf(res).pagination).toBeDefined();
  });

  it('a creator can apply in Engineering and is then found under it', async () => {
    const res = await request(app.getHttpServer())
      .post('/professionals/applications')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        category: 'engineering',
        headline: 'Structural engineer, 12 years',
        about:
          'I design and check residential and light commercial structures across Lagos and Ogun.',
        credentialKind: 'portfolio',
      })
      .expect(201);
    expect(bodyOf(res).data.category).toBe('engineering');

    // Pending is not listed, under any field.
    let engineering = await allOf({ field: 'engineering' });
    expect(entryFor(engineering, USER_CREATOR_PRO)).toBeUndefined();

    await prisma.professionalProfile.update({
      where: { id: bodyOf(res).data.id as string },
      data: { status: 'approved', reviewedAt: new Date() },
    });
    engineering = await allOf({ field: 'engineering' });
    expect(entryFor(engineering, USER_CREATOR_PRO)?.field).toEqual({
      id: 'engineering',
      label: 'Engineering',
    });
  });

  it('refuses a field that is not one of the fields, a category in its place, or the wrong case', async () => {
    await directory({ field: 'astrology' }).expect(400);
    // A category id is not a field id: `finance` is filed under accounting_tax.
    await directory({ field: 'finance' }).expect(400);
    await directory({ field: 'ACCOUNTING_TAX' }).expect(400);
    await directory({ perPage: 51 }).expect(400);
    await directory({ page: 0 }).expect(400);
    // An unknown query key is refused rather than silently ignored.
    await directory({ category: 'finance' }).expect(400);
  });

  it('pages: perPage given as text is read as a number', async () => {
    await professional('finance');
    await professional('finance');
    const res = await request(app.getHttpServer())
      .get('/professionals/directory')
      .query('field=accounting_tax&perPage=1&page=1')
      .expect(200);
    expect(bodyOf(res).data).toHaveLength(1);
    expect(bodyOf(res).pagination?.perPage).toBe(1);
    expect(bodyOf(res).pagination?.total).toBeGreaterThanOrEqual(2);
  });

  it('does not list a pending listing, and its profile is not found', async () => {
    const pending = await professional('finance', { status: 'pending' });
    const all = await allOf();
    expect(entryFor(all, pending.wawuId)).toBeUndefined();
    await request(app.getHttpServer())
      .get(`/professionals/directory/${pending.listingId}`)
      .expect(404);
    await request(app.getHttpServer())
      .get('/professionals/directory/not-a-uuid')
      .expect(400);
  });

  // ---- usual reply time (capability check 2) ---------------------------------

  it("a card's usual reply time is the median of the professional's real reply times", async () => {
    const p = await professional('finance');
    await answered(p.wawuId, 60);
    await answered(p.wawuId, 180);
    await answered(p.wawuId, 240);
    // Never answered: not a reply time, so not counted either way.
    await unanswered(p.wawuId, 'awaiting_response', 30);
    await unanswered(p.wawuId, 'refunded', 3000);

    const entry = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(entry?.usualReplyMinutes).toBe(180);
    expect(entry?.answeredMessageCount).toBe(3);

    const profile = await request(app.getHttpServer())
      .get(`/professionals/directory/${p.listingId}`)
      .expect(200);
    expect(bodyOf(profile).data.usualReplyMinutes).toBe(180);
    expect(bodyOf(profile).data.answeredMessageCount).toBe(3);
  });

  it('shows no reply time until enough messages have been answered', async () => {
    const none = await professional('finance');
    const few = await professional('finance');
    for (let i = 1; i < REPLY_TIME_DEFAULTS.minimumAnswered; i++) {
      await answered(few.wawuId, 30);
    }
    const rows = await allOf({ field: 'accounting_tax' });
    expect(entryFor(rows, none.wawuId)).toMatchObject({
      usualReplyMinutes: null,
      answeredMessageCount: 0,
    });
    expect(entryFor(rows, few.wawuId)).toMatchObject({
      usualReplyMinutes: null,
      answeredMessageCount: REPLY_TIME_DEFAULTS.minimumAnswered - 1,
    });
  });

  it('takes the usual reply time from the most recent answers only', async () => {
    const p = await professional('finance');
    // Slow replies long ago, then a run of quick ones: the card says quick.
    for (let i = 0; i < 5; i++) await answered(p.wawuId, 600, 10_000 + i);
    for (let i = 0; i < REPLY_TIME_DEFAULTS.sample; i++) {
      await answered(p.wawuId, 10, i);
    }
    const entry = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(entry?.usualReplyMinutes).toBe(10);
    expect(entry?.answeredMessageCount).toBe(REPLY_TIME_DEFAULTS.sample);
  });

  it('rounds a reply under a minute up to one minute, never zero', async () => {
    const p = await professional('finance');
    for (let i = 0; i < REPLY_TIME_DEFAULTS.minimumAnswered; i++) {
      await answered(p.wawuId, 0.2);
    }
    const entry = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(entry?.usualReplyMinutes).toBe(1);
  });

  // ---- message price --------------------------------------------------------

  it('carries the message price in kobo, and none for someone not taking messages', async () => {
    const open = await professional('finance', { dmPrice: 5000 });
    const closed = await professional('finance', { dmPrice: null });
    const rows = await allOf({ field: 'accounting_tax' });

    const o = entryFor(rows, open.wawuId);
    expect(o?.messagePriceKobo).toBe(500000);
    expect(o?.dmEnabled).toBe(true);
    expect(o).not.toHaveProperty('dmPrice');

    const c = entryFor(rows, closed.wawuId);
    expect(c?.messagePriceKobo).toBeNull();
    expect(c?.dmEnabled).toBe(false);
  });

  it('a creator who switched paid messages off shows no price even with one saved', async () => {
    const p = await professional('finance', { dmPrice: 7500 });
    await prisma.creatorState.update({
      where: { wawuUserId: p.wawuId },
      data: { dmEnabled: false },
    });
    const profile = await request(app.getHttpServer())
      .get(`/professionals/directory/${p.listingId}`)
      .expect(200);
    expect(bodyOf(profile).data.messagePriceKobo).toBeNull();
    expect(bodyOf(profile).data.dmEnabled).toBe(false);
  });

  // ---- the profile ----------------------------------------------------------

  it('the profile carries the card, the about, the issuing body and never the licence number', async () => {
    const p = await professional('finance');
    const res = await request(app.getHttpServer())
      .get(`/professionals/directory/${p.listingId}`)
      .expect(200);
    const d = bodyOf(res).data;
    expect(d.id).toBe(p.listingId);
    expect(d.field).toEqual({
      id: 'accounting_tax',
      label: 'Accounting & Tax',
    });
    expect(d.about).toMatch(/file taxes/);
    expect(d.issuingBody).toBe('ICAN');
    expect(d.credentialKind).toBe('licence');
    expect(d.services).toEqual(['Tax filing', 'Bookkeeping']);
    expect(d.dmResponseHours).toBe(24);
    expect(JSON.stringify(d)).not.toContain('ICAN/2016/40921');
    expect(d).not.toHaveProperty('licenceNumber');
  });

  // ---- city -----------------------------------------------------------------

  it('a creator sets their city, trimmed, and it shows on their card and profile', async () => {
    const put = await request(app.getHttpServer())
      .put('/professionals/location')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ city: '  Ikeja ' })
      .expect(200);
    expect(bodyOf(put).data).toEqual({ city: 'Ikeja' });

    const mine = await request(app.getHttpServer())
      .get('/professionals/location')
      .set('Authorization', `Bearer ${creatorToken}`)
      .expect(200);
    expect(bodyOf(mine).data).toEqual({ city: 'Ikeja' });

    const listing = await prisma.professionalProfile.create({
      data: {
        wawuUserId: USER_CREATOR_PRO,
        category: 'technology',
        headline: 'Backend engineer, 9 years',
        about:
          'I build and maintain payment integrations for Nigerian fintechs, mostly NestJS and Postgres.',
        credentialKind: 'portfolio',
        status: 'approved',
        reviewedAt: new Date(),
      },
    });
    const entry = entryFor(
      await allOf({ field: 'technology_it' }),
      USER_CREATOR_PRO,
    );
    expect(entry?.city).toBe('Ikeja');
    const profile = await request(app.getHttpServer())
      .get(`/professionals/directory/${listing.id}`)
      .expect(200);
    expect(bodyOf(profile).data.city).toBe('Ikeja');

    // Changing it replaces it; clearing it leaves no city, never a guess.
    await request(app.getHttpServer())
      .put('/professionals/location')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ city: 'Port Harcourt' })
      .expect(200);
    expect(
      entryFor(await allOf({ field: 'technology_it' }), USER_CREATOR_PRO)?.city,
    ).toBe('Port Harcourt');
    const cleared = await request(app.getHttpServer())
      .delete('/professionals/location')
      .set('Authorization', `Bearer ${creatorToken}`)
      .expect(200);
    expect(bodyOf(cleared).data).toEqual({ city: null });
    expect(
      entryFor(await allOf({ field: 'technology_it' }), USER_CREATOR_PRO)?.city,
    ).toBeNull();
  });

  it('a professional who never set a city shows none', async () => {
    const p = await professional('finance');
    const entry = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(entry?.city).toBeNull();
  });

  it('refuses a city from a buyer account, without a token, or that is blank or too long', async () => {
    await request(app.getHttpServer())
      .put('/professionals/location')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ city: 'Ikeja' })
      .expect(403);
    await request(app.getHttpServer())
      .delete('/professionals/location')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put('/professionals/location')
      .send({ city: 'Ikeja' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/professionals/location')
      .expect(401);
    for (const city of ['   ', 'I', 'x'.repeat(61), 42]) {
      await request(app.getHttpServer())
        .put('/professionals/location')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ city })
        .expect(400);
    }
    await request(app.getHttpServer())
      .put('/professionals/location')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ city: 'Ikeja', country: 'NG' })
      .expect(400);
    expect(
      await prisma.professionalLocation.findUnique({
        where: { wawuUserId: USER_CREATOR_PRO },
      }),
    ).toBeNull();
  });

  // ---- round 2: blocked people, impossible times, city text, test gaps -------

  it('hides a professional the caller blocked, or who blocked the caller, from the directory and its profile', async () => {
    const blockedByMe = await professional('finance');
    const blockedMe = await professional('finance');
    const other = await professional('finance');
    await prisma.blockedAccount.create({
      data: { userWawuId: USER_PLAIN, blockedWawuId: blockedByMe.wawuId },
    });
    await prisma.blockedAccount.create({
      data: { userWawuId: blockedMe.wawuId, blockedWawuId: USER_PLAIN },
    });
    const auth = { Authorization: `Bearer ${plainToken}` };

    const mine = await directory({ field: 'accounting_tax' }).set(auth);
    const rows = bodyOf<DirectoryEntry[]>(mine).data;
    expect(entryFor(rows, blockedByMe.wawuId)).toBeUndefined();
    expect(entryFor(rows, blockedMe.wawuId)).toBeUndefined();
    expect(entryFor(rows, other.wawuId)).toBeDefined();

    // The total does not count them either.
    const withViewer = await directory({
      field: 'accounting_tax',
      perPage: 1,
    }).set(auth);
    const without = await directory({ field: 'accounting_tax', perPage: 1 });
    expect(bodyOf(withViewer).pagination?.total).toBe(
      (bodyOf(without).pagination?.total ?? 0) - 2,
    );

    for (const gone of [blockedByMe, blockedMe]) {
      await request(app.getHttpServer())
        .get(`/professionals/directory/${gone.listingId}`)
        .set(auth)
        .expect(404);
      // Without a token nobody is hidden.
      await request(app.getHttpServer())
        .get(`/professionals/directory/${gone.listingId}`)
        .expect(200);
    }
    await request(app.getHttpServer())
      .get(`/professionals/directory/${other.listingId}`)
      .set(auth)
      .expect(200);
  });

  it('a listing someone hid (listed false) is not in the directory and its profile is not found', async () => {
    const p = await professional('finance');
    await prisma.professionalProfile.update({
      where: { id: p.listingId },
      data: { listed: false },
    });
    expect(
      entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId),
    ).toBeUndefined();
    await request(app.getHttpServer())
      .get(`/professionals/directory/${p.listingId}`)
      .expect(404);
  });

  it('never reads a reply that is dated before its message as a fast one', async () => {
    const p = await professional('finance');
    for (let i = 0; i < 3; i++) {
      // Answered 5 minutes BEFORE it was sent: not a reply time.
      await answered(p.wawuId, -5);
    }
    const entry = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(entry).toMatchObject({
      usualReplyMinutes: null,
      answeredMessageCount: 0,
    });
    // Real replies beside them are the only ones counted.
    for (const m of [20, 40, 60]) await answered(p.wawuId, m);
    const after = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(after?.usualReplyMinutes).toBe(40);
    expect(after?.answeredMessageCount).toBe(3);
  });

  it('needs three answered messages, rounds up past one minute, and counts each professional alone', async () => {
    const two = await professional('finance');
    const three = await professional('finance');
    await answered(two.wawuId, 30);
    await answered(two.wawuId, 30);
    for (const m of [10.5, 10.5, 10.5]) await answered(three.wawuId, m);
    const rows = await allOf({ field: 'accounting_tax' });
    expect(entryFor(rows, two.wawuId)?.usualReplyMinutes).toBeNull();
    // 10 minutes 30 seconds reads 11, and the other person's replies are not mixed in.
    expect(entryFor(rows, three.wawuId)).toMatchObject({
      usualReplyMinutes: 11,
      answeredMessageCount: 3,
    });
    expect(REPLY_TIME_DEFAULTS.minimumAnswered).toBe(3);
    expect(REPLY_TIME_DEFAULTS.sample).toBe(20);
  });

  it('a refunded message that carries a reply time is still not counted', async () => {
    const p = await professional('finance');
    for (const m of [10, 10, 10]) await answered(p.wawuId, m);
    const sentAt = new Date(Date.now() - 600 * MINUTE);
    await prisma.directMessage.create({
      data: {
        creatorWawuId: p.wawuId,
        senderWawuId: USER_PLAIN,
        text: 'Hello?',
        amount: 5000,
        status: 'refunded',
        sentAt,
        deadlineAt: new Date(sentAt.getTime() + 24 * 60 * MINUTE),
        respondedAt: new Date(sentAt.getTime() + 500 * MINUTE),
        flutterwaveTxRef: `pros02-${randomUUID()}`,
      },
    });
    const entry = entryFor(await allOf({ field: 'accounting_tax' }), p.wawuId);
    expect(entry).toMatchObject({
      usualReplyMinutes: 10,
      answeredMessageCount: 3,
    });
  });

  it('two professionals with different cities on one page each show their own', async () => {
    const a = await professional('finance');
    const b = await professional('finance');
    await prisma.professionalLocation.create({
      data: { wawuUserId: a.wawuId, city: 'Ikeja' },
    });
    await prisma.professionalLocation.create({
      data: { wawuUserId: b.wawuId, city: 'Enugu' },
    });
    const rows = await allOf({ field: 'accounting_tax' });
    expect(entryFor(rows, a.wawuId)?.city).toBe('Ikeja');
    expect(entryFor(rows, b.wawuId)?.city).toBe('Enugu');
  });

  it('refuses a city that is not a place name, and collapses inner spaces', async () => {
    const put = (city: string) =>
      request(app.getHttpServer())
        .put('/professionals/location')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ city });
    for (const city of [
      '​​',
      'Ikeja​',
      'Ikeja\n\nPay me directly on 0803',
      'Ikeja\u0007',
      '12345',
      '<script>alert(1)</script>',
      '-Ikeja',
    ]) {
      await put(city).expect(400);
    }
    expect(
      await prisma.professionalLocation.findUnique({
        where: { wawuUserId: USER_CREATOR_PRO },
      }),
    ).toBeNull();
    const ok = await put('Port   Harcourt').expect(200);
    expect(bodyOf(ok).data).toEqual({ city: 'Port Harcourt' });
    const dotted = await put("St. John's-on-Sea").expect(200);
    expect(bodyOf(dotted).data).toEqual({ city: "St. John's-on-Sea" });
    const accented = await put('Ìbàdàn').expect(200);
    expect(bodyOf(accented).data).toEqual({ city: 'Ìbàdàn' });
  });

  // ---- the web's routes keep their answers ------------------------------------

  it('GET /professionals and GET /professionals/:id answer exactly the keys they did', async () => {
    const p = await professional('finance');
    await answered(p.wawuId, 60);
    const listKeys = [
      'avatarUrl',
      'category',
      'dmEnabled',
      'dmPrice',
      'dmResponseHours',
      'handle',
      'headline',
      'id',
      'name',
      'pieceCount',
      'ratingAvg',
      'reviewCount',
      'services',
      'verification',
      'wawuId',
    ];
    const list = await request(app.getHttpServer())
      .get('/professionals')
      .query({ category: 'finance', perPage: 50 })
      .expect(200);
    const row = bodyOf<Array<Record<string, unknown>>>(list).data.find(
      (r) => r.wawuId === p.wawuId,
    );
    expect(Object.keys(row ?? {}).sort()).toEqual(listKeys);
    expect(row?.dmPrice).toBe(5000);

    const detail = await request(app.getHttpServer())
      .get(`/professionals/${p.listingId}`)
      .expect(200);
    expect(Object.keys(bodyOf(detail).data).sort()).toEqual(
      [...listKeys, 'about', 'credentialKind', 'issuingBody'].sort(),
    );
  });
});

import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';
import { ACCOUNT_DATA_MAP } from '../../account-purge/account-data-map';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_THROTTLERS } from '../../hub-throttlers';
import { ADS_CLOCK } from '../ads-clock';
import { AdsCountsService } from '../ads-counts.service';
import { AdsEventsModule } from '../ads-events.module';
import { AdsModule } from '../ads.module';

/**
 * ADS-05: POST /ads/:id/events and the read helper, over HTTP on a real
 * database, with tokens from the mock WAWU ID. The server's clock is replaced
 * by a settable one in most tests so every boundary is hit to the millisecond;
 * one block runs the real clock to prove the production wiring.
 *
 * The spec owns its rows (campaign ids start with "ad05ad05-"), removes them
 * after each test and checks that every table has the row count it began with,
 * so it passes alone, first, last or twice in a row.
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const VIEWER_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';

const PREFIX = 'ad05ad05-0000-4000-8000-';
const cid = (n: number) => PREFIX + String(n).padStart(12, '0');
const T0 = new Date('2026-11-01T12:00:00.000Z');
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
const DAY = 24 * 60 * 60 * 1000;
const UNKNOWN_ID = 'ad05ad05-0000-4000-8000-ffffffffffff';

interface Login {
  sub: string;
  token: string;
}

async function loginToWawuId(identifier: string): Promise<Login> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

let nonce = 0;
async function registerViewer(label: string): Promise<Login> {
  nonce += 1;
  const stamp = `${Date.now().toString().slice(-7)}${nonce}`;
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Ads Spec ${label}`,
      email: `ads05-spec-${label}-${stamp}@test.wawu.dev`,
      phone: `+2348${stamp}`.slice(0, 14),
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

interface Envelope {
  statusCode: number;
  message: string;
  data: Record<string, unknown> | null;
}
const envelope = (res: { body: unknown }): Envelope => res.body as Envelope;

/** The app's global guard (AppModule registers the same one). */
@Module({ providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }] })
class ThrottleGuardModule {}

interface CampaignOpts {
  n: number;
  status?: 'draft' | 'scheduled' | 'live' | 'paused' | 'ended';
  startsAt?: Date;
  endsAt?: Date;
  noCreative?: boolean;
  placement?: 'tgif_card' | 'today_slot';
  eventId?: string;
}

describe('POST /ads/:id/events (ADS-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let counts: AdsCountsService;
  let db: Client;
  let viewer: Login;
  let now = T0;
  let countsBefore: Record<string, number> = {};
  /** Who a block row was made for, so cleanUp removes exactly those. */
  const blockOwners: string[] = [];

  // Every app listens on a real port, so parallel requests share one server
  // instead of each opening its own.
  let baseUrl = '';
  const urls = new Map<INestApplication, string>();
  const urlOf = (a: INestApplication): string => urls.get(a) ?? baseUrl;
  const http = () => request(baseUrl);
  const report = (
    id: string,
    body: unknown,
    token = viewer.token,
    server: string = baseUrl,
  ) =>
    request(server)
      .post(`/api/hub/ads/${id}/events`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
  const send = (id: string, type: string, who: Login = viewer) =>
    report(id, { type }, who.token);

  async function boot(clock: boolean, extra: unknown[] = []) {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdsEventsModule,
        ...(extra as []),
      ],
    });
    if (clock) builder.overrideProvider(ADS_CLOCK).useValue(() => now);
    const moduleRef: TestingModule = await builder.compile();
    const a = moduleRef.createNestApplication();
    a.setGlobalPrefix('api/hub');
    a.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    a.useGlobalFilters(new AllExceptionsFilter());
    a.useGlobalInterceptors(new ResponseInterceptor());
    await a.listen(0, '127.0.0.1');
    urls.set(a, await a.getUrl());
    return a;
  }

  async function allCounts(): Promise<Record<string, number>> {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const out: Record<string, number> = {};
    for (const { tablename } of tables.rows) {
      const r = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${tablename}"`,
      );
      out[tablename] = Number(r.rows[0].n);
    }
    return out;
  }

  async function cleanUp(): Promise<void> {
    await prisma.adEvent.deleteMany({
      where: { campaignId: { startsWith: PREFIX } },
    });
    await prisma.adDailyTotal.deleteMany({
      where: { campaignId: { startsWith: PREFIX } },
    });
    await prisma.adCampaign.deleteMany({
      where: { id: { startsWith: PREFIX } },
    });
    await prisma.event.deleteMany({
      where: { id: { startsWith: 'ads05-spec-' } },
    });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: blockOwners } },
    });
    blockOwners.length = 0;
  }

  /** A campaign with its creative, countable unless overridden. */
  async function makeEvent(
    id: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    await prisma.event.create({
      data: {
        id,
        hostWawuId: HOST_SUB,
        name: 'Gospel Night Live',
        description: 'A fixture event for the ads counting spec.',
        hostOrg: 'Ads Spec Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Abuja',
        startsAt: new Date('2027-01-15T18:00:00.000Z'),
        status: 'published',
        ...over,
      },
    });
    return id;
  }

  async function makeCampaign(o: CampaignOpts): Promise<string> {
    const id = cid(o.n);
    const eventId = o.eventId ?? (await makeEvent(`ads05-spec-ev-${o.n}`));
    await prisma.adCampaign.create({
      data: {
        id,
        advertiser: `Advertiser ${o.n}`,
        placement: o.placement ?? 'tgif_card',
        status: o.status ?? 'live',
        startsAt: o.startsAt ?? ms(T0, -DAY),
        endsAt: o.endsAt ?? ms(T0, DAY),
        ...(o.noCreative
          ? {}
          : {
              creative: {
                create: {
                  headline: `Headline ${o.n}`,
                  ctaLabel: 'Get tickets',
                  ctaDestination: 'event',
                  ctaDestinationId: eventId,
                },
              },
            }),
      },
    });
    return id;
  }

  const rawCounts = async (id: string) => {
    const r = await db.query<{ type: string; n: string }>(
      `SELECT "type"::text AS type, count(*) AS n FROM "AdEvent" WHERE "campaignId" = $1 GROUP BY 1`,
      [id],
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.type, Number(x.n)]));
    return { views: by.view ?? 0, taps: by.tap ?? 0, skips: by.skip ?? 0 };
  };
  const totalsRow = async (id: string) => {
    const r = await db.query<{ views: number; taps: number; skips: number }>(
      `SELECT coalesce(sum("views"),0)::int AS views, coalesce(sum("taps"),0)::int AS taps, coalesce(sum("skips"),0)::int AS skips FROM "AdDailyTotal" WHERE "campaignId" = $1`,
      [id],
    );
    return r.rows[0];
  };
  const eventRows = async (id: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "AdEvent" WHERE "campaignId" = $1`,
          [id],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    db = new Client({
      connectionString: (() => {
        const u = new URL(process.env.DATABASE_URL ?? '');
        u.search = '';
        return u.toString();
      })(),
    });
    await db.connect();
    app = await boot(true);
    baseUrl = urlOf(app);
    prisma = app.get(PrismaService);
    counts = app.get(AdsCountsService);
    await cleanUp();
    countsBefore = await allCounts();
    viewer = await loginToWawuId(VIEWER_EMAIL);
  });

  beforeEach(() => {
    now = T0;
  });
  afterEach(cleanUp);

  afterAll(async () => {
    await cleanUp();
    expect(await allCounts()).toEqual(countsBefore);
    await db.end();
    await app.close();
  });

  describe('who may report, and what they may send', () => {
    it('refuses a request with no token or a bad one (401) and counts nothing', async () => {
      const id = await makeCampaign({ n: 1 });
      await http()
        .post(`/api/hub/ads/${id}/events`)
        .send({ type: 'view' })
        .expect(401);
      await http()
        .post(`/api/hub/ads/${id}/events`)
        .set('Authorization', 'Bearer not-a-token')
        .send({ type: 'view' })
        .expect(401);
      expect(await eventRows(id)).toBe(0);
    });

    it('needs a campaign id that is a uuid (400)', async () => {
      for (const bad of ['1', 'not-a-uuid', 'ad05ad05-0000-4000-8000']) {
        await report(bad, { type: 'view' }).expect(400);
      }
    });

    it('needs type, and only view, tap or skip, nothing else in the body (400)', async () => {
      const id = await makeCampaign({ n: 1 });
      const bodies: unknown[] = [
        {},
        { type: '' },
        { type: 'click' },
        { type: 'impression' },
        { type: 'VIEW' },
        { type: ' view' },
        { type: 1 },
        { type: null },
        { type: ['view'] },
        { type: { a: 1 } },
        { type: 'view', campaignId: id },
        { type: 'view', viewerWawuId: viewer.sub },
        { kind: 'view' },
      ];
      for (const b of bodies) {
        const res = await report(id, b).expect(400);
        expect(envelope(res).data ?? null).toBeNull();
      }
      await http()
        .post(`/api/hub/ads/${id}/events`)
        .set('Authorization', `Bearer ${viewer.token}`)
        .expect(400);
      expect(await eventRows(id)).toBe(0);
      expect(
        await db
          .query(`SELECT 1 FROM "AdDailyTotal" WHERE "campaignId" = $1`, [id])
          .then((r) => r.rowCount),
      ).toBe(0);
    });

    it('does not read the type from the query string or the person from the body', async () => {
      const id = await makeCampaign({ n: 1 });
      await http()
        .post(`/api/hub/ads/${id}/events?type=view`)
        .set('Authorization', `Bearer ${viewer.token}`)
        .send({})
        .expect(400);
      expect(await eventRows(id)).toBe(0);
    });

    it('has no other verbs or paths on the events route', async () => {
      const id = await makeCampaign({ n: 1 });
      const auth = { Authorization: `Bearer ${viewer.token}` };
      await http().get(`/api/hub/ads/${id}/events`).set(auth).expect(404);
      await http().put(`/api/hub/ads/${id}/events`).set(auth).expect(404);
      await http().delete(`/api/hub/ads/${id}/events`).set(auth).expect(404);
      await http()
        .post('/api/hub/ads')
        .set(auth)
        .send({ type: 'view' })
        .expect(404);
    });
  });

  describe('what the answer says', () => {
    it('is 200 with exactly { accepted: true }, uncached, the same for a first report and a repeat', async () => {
      const id = await makeCampaign({ n: 1 });
      const first = await send(id, 'view').expect(200);
      const again = await send(id, 'view').expect(200);
      expect(first.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: { accepted: true },
      });
      expect(again.body).toEqual(first.body);
      expect(Object.keys(envelope(first).data ?? {})).toEqual(['accepted']);
      expect(first.headers['cache-control']).toBe('no-store');
    });
  });

  describe('capability: opening the same card twice in a day counts one view', () => {
    it('counts one view for two views by one person on one day', async () => {
      const id = await makeCampaign({ n: 1 });
      await send(id, 'view').expect(200);
      await send(id, 'view').expect(200);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 0, skips: 0 });
      expect(await totalsRow(id)).toEqual({ views: 1, taps: 0, skips: 0 });
      const read = await counts.forCampaign(id);
      expect(read.delivery).toEqual({ views: 1, taps: 0, skips: 0, ctr: 0 });
    });

    it('counts a tap once and a skip once the same way', async () => {
      const id = await makeCampaign({ n: 1 });
      for (let i = 0; i < 3; i++) {
        await send(id, 'tap').expect(200);
        await send(id, 'skip').expect(200);
      }
      expect(await rawCounts(id)).toEqual({ views: 0, taps: 1, skips: 1 });
      expect(await totalsRow(id)).toEqual({ views: 0, taps: 1, skips: 1 });
    });

    it('counts view, tap and skip separately: one of each is three counts', async () => {
      const id = await makeCampaign({ n: 1 });
      await send(id, 'view').expect(200);
      await send(id, 'tap').expect(200);
      await send(id, 'skip').expect(200);
      expect(await totalsRow(id)).toEqual({ views: 1, taps: 1, skips: 1 });
      expect(await eventRows(id)).toBe(3);
    });

    it('counts a second person on the same day, and the same person again on the next UTC day', async () => {
      const id = await makeCampaign({ n: 1, endsAt: ms(T0, 5 * DAY) });
      const other = await registerViewer('second');
      await send(id, 'view').expect(200);
      await send(id, 'view', other).expect(200);
      expect((await counts.forCampaign(id)).delivery.views).toBe(2);

      now = ms(T0, DAY);
      await send(id, 'view').expect(200);
      await send(id, 'view').expect(200);
      const read = await counts.forCampaign(id);
      expect(read.delivery.views).toBe(3);
      expect(read.days.map((d) => [d.day, d.views])).toEqual([
        ['2026-11-01', 2],
        ['2026-11-02', 1],
      ]);
    });

    it('cuts the day at midnight UTC, to the millisecond', async () => {
      const id = await makeCampaign({ n: 1, endsAt: ms(T0, 5 * DAY) });
      now = new Date('2026-11-01T23:59:59.999Z');
      await send(id, 'view').expect(200);
      now = new Date('2026-11-02T00:00:00.000Z');
      await send(id, 'view').expect(200);
      await send(id, 'view').expect(200);
      const read = await counts.forCampaign(id);
      expect(read.days.map((d) => [d.day, d.views])).toEqual([
        ['2026-11-01', 1],
        ['2026-11-02', 1],
      ]);
    });

    it('stores the server clock in UTC: the day and the instant of the first report', async () => {
      const id = await makeCampaign({ n: 1 });
      now = new Date('2026-11-01T23:30:15.123Z');
      await send(id, 'view').expect(200);
      const r = await db.query<{ day: string; at: string }>(
        `SELECT to_char("day", 'YYYY-MM-DD') AS day,
                to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at
           FROM "AdEvent" WHERE "campaignId" = $1`,
        [id],
      );
      expect(r.rows).toEqual([
        { day: '2026-11-01', at: '2026-11-01T23:30:15.123' },
      ]);
      // A repeat later the same day does not move the stored instant.
      now = new Date('2026-11-01T23:59:00.000Z');
      await send(id, 'view').expect(200);
      const again = await db.query<{ at: string }>(
        `SELECT to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at FROM "AdEvent" WHERE "campaignId" = $1`,
        [id],
      );
      expect(again.rows).toEqual([{ at: '2026-11-01T23:30:15.123' }]);
    });
  });

  describe('capability: daily totals match the raw events', () => {
    it('after a mixed week by several people the totals equal the events, every day', async () => {
      const id = await makeCampaign({ n: 1, endsAt: ms(T0, 10 * DAY) });
      const people = [
        viewer,
        await registerViewer('a'),
        await registerViewer('b'),
      ];
      // Expected, worked out by the spec itself: [personIndex, dayOffset, type]
      // lists, with deliberate repeats.
      const plan: Array<[number, number, string]> = [
        [0, 0, 'view'],
        [0, 0, 'view'],
        [1, 0, 'view'],
        [1, 0, 'tap'],
        [1, 0, 'tap'],
        [2, 0, 'skip'],
        [0, 1, 'view'],
        [0, 1, 'tap'],
        [1, 1, 'skip'],
        [1, 1, 'skip'],
        [2, 1, 'view'],
        [2, 2, 'view'],
        [2, 2, 'tap'],
        [2, 2, 'tap'],
        [2, 2, 'skip'],
        [0, 2, 'view'],
      ];
      const expected = new Map<
        string,
        { views: number; taps: number; skips: number }
      >();
      const seen = new Set<string>();
      for (const [p, d, type] of plan) {
        now = ms(T0, d * DAY);
        await send(id, type, people[p]).expect(200);
        const day = now.toISOString().slice(0, 10);
        const key = `${p}|${day}|${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cur = expected.get(day) ?? { views: 0, taps: 0, skips: 0 };
        if (type === 'view') cur.views++;
        if (type === 'tap') cur.taps++;
        if (type === 'skip') cur.skips++;
        expected.set(day, cur);
      }
      expect(expected.size).toBe(3);

      // What the helper reports is what the spec worked out ...
      const read = await counts.forCampaign(id);
      expect(read.days.map((d) => [d.day, d.views, d.taps, d.skips])).toEqual(
        [...expected.entries()]
          .sort()
          .map(([day, c]) => [day, c.views, c.taps, c.skips]),
      );
      // ... and equals the raw events counted straight from the table.
      const raw = await db.query<{ day: string; type: string; n: string }>(
        `SELECT to_char("day",'YYYY-MM-DD') AS day, "type"::text AS type, count(*) AS n
           FROM "AdEvent" WHERE "campaignId" = $1 GROUP BY 1, 2`,
        [id],
      );
      for (const r of raw.rows) {
        const day = read.days.find((d) => d.day === r.day);
        const col =
          r.type === 'view' ? 'views' : r.type === 'tap' ? 'taps' : 'skips';
        expect(day?.[col]).toBe(Number(r.n));
      }
      expect(await counts.reconcile(id)).toEqual([]);
      expect(read.delivery.views).toBe(
        read.days.reduce((s, d) => s + d.views, 0),
      );
      expect(await totalsRow(id)).toEqual({
        views: read.delivery.views,
        taps: read.delivery.taps,
        skips: read.delivery.skips,
      });
    });

    it('reconcile reports a day whose total differs from its events', async () => {
      const id = await makeCampaign({ n: 1 });
      await send(id, 'view').expect(200);
      await send(id, 'tap').expect(200);
      expect(await counts.reconcile(id)).toEqual([]);
      await db.query(
        `UPDATE "AdDailyTotal" SET "views" = "views" + 1 WHERE "campaignId" = $1`,
        [id],
      );
      expect(await counts.reconcile(id)).toEqual([
        {
          day: '2026-11-01',
          totals: { views: 2, taps: 1, skips: 0 },
          events: { views: 1, taps: 1, skips: 0 },
        },
      ]);
      await db.query(
        `DELETE FROM "AdEvent" WHERE "campaignId" = $1 AND "type" = 'tap'`,
        [id],
      );
      const mismatches = await counts.reconcile(id);
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0].events.taps).toBe(0);
    });

    it('a refused report writes neither an event nor a total', async () => {
      const id = await makeCampaign({ n: 1, status: 'paused' });
      await send(id, 'view').expect(404);
      expect(await eventRows(id)).toBe(0);
      expect(
        await prisma.adDailyTotal.count({ where: { campaignId: id } }),
      ).toBe(0);
    });
  });

  describe('which campaigns count', () => {
    it('counts scheduled and live and nothing else; refuses draft, paused and ended (404)', async () => {
      const ok: Array<[number, 'scheduled' | 'live']> = [
        [1, 'scheduled'],
        [2, 'live'],
      ];
      for (const [n, status] of ok) {
        const id = await makeCampaign({ n, status });
        await send(id, 'view').expect(200);
        expect((await counts.forCampaign(id)).delivery.views).toBe(1);
      }
      for (const [n, status] of [
        [3, 'draft'],
        [4, 'paused'],
        [5, 'ended'],
      ] as const) {
        const id = await makeCampaign({ n, status });
        for (const type of ['view', 'tap', 'skip']) {
          await send(id, type).expect(404);
        }
        expect(await eventRows(id)).toBe(0);
      }
    });

    it('counts from startsAt to just before endsAt and not outside, to the millisecond', async () => {
      const startsAt = ms(T0, 10 * DAY);
      const endsAt = ms(startsAt, 5 * DAY);
      const id = await makeCampaign({ n: 1, startsAt, endsAt });
      const trials: Array<[Date, number]> = [
        [ms(startsAt, -DAY), 404],
        [ms(startsAt, -1), 404],
        [startsAt, 200],
        [ms(startsAt, 1), 200],
        [ms(endsAt, -1), 200],
        [endsAt, 404],
        [ms(endsAt, 1), 404],
        [ms(endsAt, 30 * DAY), 404],
      ];
      let counted = 0;
      for (const [at, status] of trials) {
        now = at;
        const res = await send(id, 'tap');
        expect([at.toISOString(), res.status]).toEqual([
          at.toISOString(),
          status,
        ]);
        if (status === 200) counted += 1;
      }
      // Three reports were accepted. start and start+1ms are one person on one
      // day (one tap); end-1ms is the next UTC day (a second).
      expect(counted).toBe(3);
      const read = await counts.forCampaign(id);
      expect(read.delivery.taps).toBe(2);
      expect(read.days.map((d) => d.day)).toEqual(['2026-11-11', '2026-11-16']);
    });

    it('a campaign without a creative is not counted', async () => {
      const id = await makeCampaign({ n: 1, noCreative: true });
      await send(id, 'view').expect(404);
      expect(await eventRows(id)).toBe(0);
    });

    it('counts a campaign whichever placement it has', async () => {
      const a = await makeCampaign({ n: 1, placement: 'tgif_card' });
      const b = await makeCampaign({ n: 2, placement: 'today_slot' });
      await send(a, 'view').expect(200);
      await send(b, 'view').expect(200);
      expect((await counts.forCampaign(a)).delivery.views).toBe(1);
      expect((await counts.forCampaign(b)).delivery.views).toBe(1);
    });

    it('answers an unknown id and every kind of uncountable campaign with one identical 404 that names nothing', async () => {
      const draft = await makeCampaign({ n: 1, status: 'draft' });
      const paused = await makeCampaign({ n: 2, status: 'paused' });
      const ended = await makeCampaign({ n: 3, status: 'ended' });
      const late = await makeCampaign({
        n: 4,
        startsAt: ms(T0, 2 * DAY),
        endsAt: ms(T0, 3 * DAY),
      });
      const bare = await makeCampaign({ n: 5, noCreative: true });
      const bodies: unknown[] = [];
      for (const id of [UNKNOWN_ID, draft, paused, ended, late, bare]) {
        const res = await send(id, 'view').expect(404);
        bodies.push(res.body);
        expect(JSON.stringify(res.body)).not.toContain(id);
        expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(
          /draft|paused|ended|window|creative|expired/,
        );
      }
      for (const b of bodies) expect(b).toEqual(bodies[0]);
      expect((bodies[0] as { message: string }).message).toBe('Ad not found');
    });
  });

  describe('concurrency: counts stay right when requests arrive together', () => {
    it('30 parallel taps from one person count once', async () => {
      const id = await makeCampaign({ n: 1 });
      const results = await Promise.all(
        Array.from({ length: 30 }, () => send(id, 'tap')),
      );
      expect(results.map((r) => r.status)).toEqual(Array(30).fill(200));
      expect(await rawCounts(id)).toEqual({ views: 0, taps: 1, skips: 0 });
      expect(await totalsRow(id)).toEqual({ views: 0, taps: 1, skips: 0 });
    });

    it('parallel view, tap and skip from one person, five of each, count one of each', async () => {
      const id = await makeCampaign({ n: 1 });
      const types = ['view', 'tap', 'skip'];
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) => send(id, types[i % 3])),
      );
      expect(results.map((r) => r.status)).toEqual(Array(15).fill(200));
      expect(await totalsRow(id)).toEqual({ views: 1, taps: 1, skips: 1 });
      expect(await counts.reconcile(id)).toEqual([]);
    });

    it('8 people, four parallel views each, count 8', async () => {
      const id = await makeCampaign({ n: 1 });
      const people = await Promise.all(
        Array.from({ length: 8 }, (_, i) => registerViewer(`p${i}`)),
      );
      const results = await Promise.all(
        people.flatMap((p) =>
          Array.from({ length: 4 }, () => send(id, 'view', p)),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(32).fill(200));
      expect(await totalsRow(id)).toEqual({ views: 8, taps: 0, skips: 0 });
      expect(await eventRows(id)).toBe(8);
      expect(await counts.reconcile(id)).toEqual([]);
    });

    it('parallel reports over two campaigns and two days keep each total separate', async () => {
      const a = await makeCampaign({ n: 1, endsAt: ms(T0, 5 * DAY) });
      const b = await makeCampaign({ n: 2, endsAt: ms(T0, 5 * DAY) });
      const people = await Promise.all(
        Array.from({ length: 4 }, (_, i) => registerViewer(`q${i}`)),
      );
      await Promise.all(
        people.flatMap((p) => [
          send(a, 'view', p),
          send(a, 'view', p),
          send(b, 'tap', p),
        ]),
      );
      expect((await counts.forCampaign(a)).delivery).toEqual({
        views: 4,
        taps: 0,
        skips: 0,
        ctr: 0,
      });
      expect((await counts.forCampaign(b)).delivery).toEqual({
        views: 0,
        taps: 4,
        skips: 0,
        ctr: null,
      });
    });
  });

  describe('history is kept', () => {
    it('counts do not change when a campaign is paused or ends, and later reports are refused', async () => {
      const id = await makeCampaign({ n: 1 });
      const other = await registerViewer('h');
      await send(id, 'view').expect(200);
      await send(id, 'tap').expect(200);
      await send(id, 'view', other).expect(200);
      const before = await counts.forCampaign(id);
      expect(before.delivery).toEqual({
        views: 2,
        taps: 1,
        skips: 0,
        ctr: 0.5,
      });

      await prisma.adCampaign.update({
        where: { id },
        data: { status: 'paused' },
      });
      expect(await counts.forCampaign(id)).toEqual(before);
      await send(id, 'skip').expect(404);
      await prisma.adCampaign.update({
        where: { id },
        data: { status: 'ended' },
      });
      expect(await counts.forCampaign(id)).toEqual(before);
      await send(id, 'view').expect(404);
      now = ms(T0, 3 * DAY);
      expect(await counts.forCampaign(id)).toEqual(before);

      // Resumed, the same person's view that day is still one.
      now = T0;
      await prisma.adCampaign.update({
        where: { id },
        data: { status: 'live' },
      });
      await send(id, 'view').expect(200);
      expect(await counts.forCampaign(id)).toEqual(before);
    });

    it('refuses to delete a campaign that has counts, and deletes one without', async () => {
      const counted = await makeCampaign({ n: 1 });
      const unseen = await makeCampaign({ n: 2 });
      await send(counted, 'view').expect(200);
      await expect(
        prisma.adCampaign.delete({ where: { id: counted } }),
      ).rejects.toThrow();
      expect(await prisma.adCampaign.count({ where: { id: counted } })).toBe(1);
      expect((await counts.forCampaign(counted)).delivery.views).toBe(1);

      await prisma.adCampaign.delete({ where: { id: unseen } });
      expect(
        await prisma.adCreative.count({ where: { campaignId: unseen } }),
      ).toBe(0);
      // Only the totals row is left holding it, if the events are removed.
      await prisma.adEvent.deleteMany({ where: { campaignId: counted } });
      await expect(
        prisma.adCampaign.delete({ where: { id: counted } }),
      ).rejects.toThrow();
    });
  });

  describe('only a card this person could be served counts (the event behind it must be open)', () => {
    const closed: Array<[string, Record<string, unknown>]> = [
      ['pending', { status: 'pending' }],
      ['rejected', { status: 'rejected' }],
      ['removed', { status: 'removed' }],
      ['cancelled (status)', { status: 'cancelled' }],
      ['cancelled (cancelledAt set)', { cancelledAt: ms(T0, -1000) }],
      [
        'already over (ends before now)',
        { startsAt: ms(T0, -2 * DAY), endsAt: ms(T0, -1) },
      ],
      ['already over (no end, started before now)', { startsAt: ms(T0, -1) }],
    ];

    it.each(closed)(
      'refuses every kind for a campaign whose event is %s (the same 404), and counts nothing',
      async (_name, over) => {
        const ev = await makeEvent('ads05-spec-closed', over);
        const id = await makeCampaign({ n: 1, eventId: ev });
        const unknown = await send(UNKNOWN_ID, 'view').expect(404);
        for (const type of ['view', 'tap', 'skip']) {
          const res = await send(id, type).expect(404);
          expect(res.body).toEqual(unknown.body);
          expect(res.headers['content-type']).toBe(
            unknown.headers['content-type'],
          );
          expect(res.headers['cache-control']).toBe(
            unknown.headers['cache-control'],
          );
        }
        expect(await eventRows(id)).toBe(0);
        expect(await totalsRow(id)).toEqual({ views: 0, taps: 0, skips: 0 });
      },
    );

    it('refuses a campaign whose event never existed or was deleted', async () => {
      const ghost = await makeCampaign({ n: 1, eventId: 'ads05-spec-ghost' });
      await send(ghost, 'view').expect(404);
      const ev = await makeEvent('ads05-spec-soon-gone');
      const id = await makeCampaign({ n: 2, eventId: ev });
      await send(id, 'view').expect(200);
      await prisma.event.delete({ where: { id: ev } });
      await send(id, 'tap').expect(404);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 0, skips: 0 });
    });

    it('counts while the event is open, to the instant it ends', async () => {
      const ev = await makeEvent('ads05-spec-edge', {
        startsAt: ms(T0, -DAY),
        endsAt: ms(T0, 1000),
      });
      const id = await makeCampaign({ n: 1, eventId: ev });
      await send(id, 'view').expect(200);
      now = ms(T0, 1000);
      await send(id, 'tap').expect(200);
      now = ms(T0, 1001);
      await send(id, 'skip').expect(404);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 1, skips: 0 });
    });

    it('an event with no end that has not started counts; one that has started does not', async () => {
      const ev = await makeEvent('ads05-spec-noend', { startsAt: ms(T0, 1) });
      const id = await makeCampaign({ n: 1, eventId: ev });
      await send(id, 'view').expect(200);
      now = ms(T0, 2);
      await send(id, 'tap').expect(404);
    });

    it('a card that was served and then lost its event stops counting: the tap after the event closes is refused', async () => {
      const ev = await makeEvent('ads05-spec-closes');
      const id = await makeCampaign({ n: 1, eventId: ev });
      await send(id, 'view').expect(200);
      await prisma.event.update({
        where: { id: ev },
        data: { status: 'cancelled' },
      });
      await send(id, 'tap').expect(404);
      await send(id, 'view').expect(404);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 0, skips: 0 });
    });

    it('a host who blocked the person, or whom the person blocked, refuses only that person', async () => {
      const other = await registerViewer('blk');
      const id = await makeCampaign({ n: 1 });
      await prisma.blockedAccount.create({
        data: { userWawuId: HOST_SUB, blockedWawuId: viewer.sub },
      });
      blockOwners.push(HOST_SUB);
      await send(id, 'view').expect(404);
      await send(id, 'view', other).expect(200);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 0, skips: 0 });

      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: HOST_SUB },
      });
      await prisma.blockedAccount.create({
        data: { userWawuId: viewer.sub, blockedWawuId: HOST_SUB },
      });
      blockOwners.push(viewer.sub);
      await send(id, 'tap').expect(404);
      await send(id, 'tap', other).expect(200);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 1, skips: 0 });
    });

    it('counts a lighter booking under a heavier one: servable to this person is the rule, not winning the placement', async () => {
      // The one rule: whatever GET /ads would return for somebody can be
      // counted by them; a lighter booking under a heavier one still counts.
      const heavy = await makeCampaign({ n: 1 });
      await prisma.adCampaign.update({
        where: { id: heavy },
        data: { weight: 50 },
      });
      const light = await makeCampaign({ n: 2 });
      await send(heavy, 'view').expect(200);
      await send(light, 'view').expect(200);
    });
  });

  describe('the read helper', () => {
    it('answers zeros, no days and no rate for a campaign nobody has seen', async () => {
      const id = await makeCampaign({ n: 1 });
      expect(await counts.forCampaign(id)).toEqual({
        campaignId: id,
        delivery: { views: 0, taps: 0, skips: 0, ctr: null },
        days: [],
      });
      expect(await counts.forCampaign(UNKNOWN_ID)).toEqual({
        campaignId: UNKNOWN_ID,
        delivery: { views: 0, taps: 0, skips: 0, ctr: null },
        days: [],
      });
      expect(await counts.reconcile(id)).toEqual([]);
    });

    it('reports views, taps, skips and CTR as taps over views', async () => {
      const id = await makeCampaign({ n: 1 });
      const people = await Promise.all(
        Array.from({ length: 4 }, (_, i) => registerViewer(`c${i}`)),
      );
      for (const p of people) await send(id, 'view', p).expect(200);
      await send(id, 'tap', people[0]).expect(200);
      await send(id, 'skip', people[1]).expect(200);
      await send(id, 'skip', people[2]).expect(200);
      const read = await counts.forCampaign(id);
      expect(read.delivery).toEqual({ views: 4, taps: 1, skips: 2, ctr: 0.25 });
      expect(read.days).toEqual([
        { day: '2026-11-01', views: 4, taps: 1, skips: 2 },
      ]);
      expect(Object.keys(read).sort()).toEqual([
        'campaignId',
        'days',
        'delivery',
      ]);
      expect(Object.keys(read.delivery).sort()).toEqual([
        'ctr',
        'skips',
        'taps',
        'views',
      ]);
    });

    it('has no rate when there are taps and no views', async () => {
      const id = await makeCampaign({ n: 1 });
      await send(id, 'tap').expect(200);
      expect((await counts.forCampaign(id)).delivery).toEqual({
        views: 0,
        taps: 1,
        skips: 0,
        ctr: null,
      });
    });

    it('limits by an inclusive span of days, and refuses a day that is not a date', async () => {
      const id = await makeCampaign({ n: 1, endsAt: ms(T0, 10 * DAY) });
      for (let d = 0; d < 4; d++) {
        now = ms(T0, d * DAY);
        await send(id, 'view').expect(200);
      }
      const span = await counts.forCampaign(id, {
        from: '2026-11-02',
        to: '2026-11-03',
      });
      expect(span.days.map((d) => d.day)).toEqual(['2026-11-02', '2026-11-03']);
      expect(span.delivery.views).toBe(2);
      expect(
        (await counts.forCampaign(id, { from: '2026-11-04' })).delivery.views,
      ).toBe(1);
      expect(
        (await counts.forCampaign(id, { to: '2026-11-01' })).delivery.views,
      ).toBe(1);
      expect(
        (await counts.forCampaign(id, { from: '2027-01-01' })).delivery.views,
      ).toBe(0);
      for (const bad of [
        '2026-13-01',
        '2026-02-30',
        'yesterday',
        '2026-1-1',
        '',
      ]) {
        await expect(counts.forCampaign(id, { from: bad })).rejects.toThrow(
          'Days are written YYYY-MM-DD.',
        );
      }
    });

    it('summary adds every campaign (or the ones named) over a span', async () => {
      expect(await counts.summary({ from: '2099-01-01' })).toEqual({
        views: 0,
        taps: 0,
        skips: 0,
        ctr: null,
      });
      const a = await makeCampaign({ n: 1, endsAt: ms(T0, 5 * DAY) });
      const b = await makeCampaign({ n: 2, endsAt: ms(T0, 5 * DAY) });
      const other = await registerViewer('s');
      await send(a, 'view').expect(200);
      await send(a, 'view', other).expect(200);
      await send(a, 'tap').expect(200);
      await send(b, 'view').expect(200);
      now = ms(T0, DAY);
      await send(b, 'skip').expect(200);
      const ids = [a, b];
      expect(await counts.summary({}, ids)).toEqual({
        views: 3,
        taps: 1,
        skips: 1,
        ctr: 1 / 3,
      });
      expect(await counts.summary({ from: '2026-11-02' }, ids)).toEqual({
        views: 0,
        taps: 0,
        skips: 1,
        ctr: null,
      });
      expect((await counts.summary({}, [a])).views).toBe(2);
      expect((await counts.summary({}, [])).views).toBe(0);
    });

    it('totalsFor gives every id asked, zeros for the unseen, and nothing for none', async () => {
      const a = await makeCampaign({ n: 1 });
      const b = await makeCampaign({ n: 2 });
      await send(a, 'view').expect(200);
      await send(a, 'tap').expect(200);
      expect(await counts.totalsFor([])).toEqual({});
      const all = await counts.totalsFor([a, b, UNKNOWN_ID]);
      expect(Object.keys(all).sort()).toEqual([a, b, UNKNOWN_ID].sort());
      expect(all[a]).toEqual({ views: 1, taps: 1, skips: 0, ctr: 1 });
      expect(all[b]).toEqual({ views: 0, taps: 0, skips: 0, ctr: null });
      expect(all[UNKNOWN_ID]).toEqual(all[b]);
    });
  });

  describe('the account purge', () => {
    it("classifies the per-person table, and removes only that person's rows, leaving the totals", async () => {
      expect(ACCOUNT_DATA_MAP.filter((r) => r.model === 'AdEvent')).toEqual([
        { model: 'AdEvent', column: 'viewerWawuId', disposition: 'OWNED' },
      ]);
      expect(ACCOUNT_DATA_MAP.some((r) => r.model === 'AdDailyTotal')).toBe(
        false,
      );

      const id = await makeCampaign({ n: 1 });
      const keeper = await registerViewer('keep');
      const leaver = await registerViewer('leave');
      await send(id, 'view', keeper).expect(200);
      await send(id, 'view', leaver).expect(200);
      await send(id, 'tap', leaver).expect(200);

      const purge = new AccountPurgeService(prisma);
      const out = await purge.purge(leaver.sub);
      expect(out.deleted['AdEvent.viewerWawuId']).toBe(2);
      expect(
        await prisma.adEvent.count({ where: { viewerWawuId: leaver.sub } }),
      ).toBe(0);
      expect(
        await prisma.adEvent.count({ where: { viewerWawuId: keeper.sub } }),
      ).toBe(1);
      // The figure that was invoiced is not walked back.
      expect((await counts.forCampaign(id)).delivery).toEqual({
        views: 2,
        taps: 1,
        skips: 0,
        ctr: 0.5,
      });
    });
  });

  describe('the database holds the rules too', () => {
    it('has the report index and refuses a stray kind, a duplicate and a negative count', async () => {
      const idx = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'AdEvent' ORDER BY 1`,
      );
      expect(idx.rows.map((r) => r.indexname)).toEqual([
        'AdEvent_campaignId_day_idx',
        'AdEvent_pkey',
        'AdEvent_viewerWawuId_idx',
      ]);
      const id = await makeCampaign({ n: 1 });
      await expect(
        db.query(
          `INSERT INTO "AdEvent" ("campaignId","viewerWawuId","type","day") VALUES ($1,'x','click','2026-11-01')`,
          [id],
        ),
      ).rejects.toThrow();
      await db.query(
        `INSERT INTO "AdEvent" ("campaignId","viewerWawuId","type","day") VALUES ($1,'x','view','2026-11-01')`,
        [id],
      );
      await expect(
        db.query(
          `INSERT INTO "AdEvent" ("campaignId","viewerWawuId","type","day") VALUES ($1,'x','view','2026-11-01')`,
          [id],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO "AdDailyTotal" ("campaignId","day","views") VALUES ($1,'2026-11-01',-1)`,
          [id],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO "AdEvent" ("campaignId","viewerWawuId","type","day") VALUES ('no-such-campaign','x','view','2026-11-01')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('beside serving and under the app rate limit', () => {
    let both: INestApplication;
    let throttled: INestApplication;

    beforeAll(async () => {
      both = await boot(true, [AdsModule]);
      throttled = await boot(true, [
        ThrottlerModule.forRoot([...HUB_THROTTLERS]),
        ThrottleGuardModule,
      ]);
    });
    afterAll(async () => {
      await both.close();
      await throttled.close();
    });

    it('GET /ads still serves the card and POST counts it, in one app, in either order', async () => {
      const ev = { id: await makeEvent('ads05-spec-event') };
      const id = await makeCampaign({ n: 1, eventId: ev.id });
      const server = urlOf(both);
      await report(id, { type: 'view' }, viewer.token, server).expect(200);
      const served = await request(server)
        .get('/api/hub/ads?placement=tgif_card')
        .set('Authorization', `Bearer ${viewer.token}`)
        .expect(200);
      expect((served.body as Envelope).data?.id).toBe(id);
      await report(id, { type: 'tap' }, viewer.token, server).expect(200);
      expect(await totalsRow(id)).toEqual({ views: 1, taps: 1, skips: 0 });
      await request(server)
        .post('/api/hub/ads?placement=tgif_card')
        .set('Authorization', `Bearer ${viewer.token}`)
        .expect(404);
    });

    it('is refused with 429 beyond the app limit, and the refused ones count nothing', async () => {
      const id = await makeCampaign({ n: 1 });
      const people = await Promise.all(
        Array.from({ length: 3 }, (_, i) => registerViewer(`t${i}`)),
      );
      const server = urlOf(throttled);
      const short = HUB_THROTTLERS.find((t) => t.name === 'short')!;
      const results = await Promise.all(
        Array.from({ length: short.limit + 15 }, (_, i) =>
          report(id, { type: 'view' }, people[i % 3].token, server),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(
        short.limit,
      );
      // Three people, whatever got through: at most one view each.
      expect((await counts.forCampaign(id)).delivery.views).toBeLessThanOrEqual(
        3,
      );
      expect(await counts.reconcile(id)).toEqual([]);
    });
  });

  describe('with the real clock', () => {
    let real: INestApplication;
    let realViewer: Login;

    beforeAll(async () => {
      real = await boot(false);
      realViewer = await loginToWawuId(VIEWER_EMAIL);
    });
    afterAll(async () => {
      await real.close();
    });

    it('counts a campaign running now, stamps today UTC, and stops when its end passes', async () => {
      const endsAt = new Date(Date.now() + 1500);
      const id = await makeCampaign({
        n: 1,
        startsAt: ms(endsAt, -DAY),
        endsAt,
      });
      const server = urlOf(real);
      await report(id, { type: 'view' }, realViewer.token, server).expect(200);
      const r = await db.query<{ same: boolean }>(
        `SELECT "day" = (now() AT TIME ZONE 'UTC')::date AS same FROM "AdEvent" WHERE "campaignId" = $1`,
        [id],
      );
      expect(r.rows).toEqual([{ same: true }]);
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await report(id, { type: 'tap' }, realViewer.token, server).expect(404);
      expect(await rawCounts(id)).toEqual({ views: 1, taps: 0, skips: 0 });
    });
  });
});

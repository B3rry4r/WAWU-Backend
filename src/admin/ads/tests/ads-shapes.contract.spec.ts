/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   supertest hands back untyped JSON; every field read here is asserted by value. */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdsModule } from '../../../ads/ads.module';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminAdsModule } from '../admin-ads.module';
import { resolvePictures } from '../ad-pictures-input';
import { showsIn } from '../../../ads/ads-pictures';

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const TAG = 'ADSHAPE-contract';
const PASSWORD = 'ads-shape-contract-password';
const ADMIN_ID = 'a8000000-0000-4000-8000-000000000001';
const FINANCE_ID = 'a8000000-0000-4000-8000-000000000002';

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * HOUR);

type Json = Record<string, any>;

const LAND = 'https://cdn.example.com/ads/acme-landscape.png';
const LAND2 = 'https://cdn.example.com/ads/acme-landscape-2.png';
const PORT = 'https://cdn.example.com/ads/acme-portrait.png';
const PORT2 = 'https://cdn.example.com/ads/acme-portrait-2.png';
const OLD = 'https://cdn.example.com/ads/acme-old.png';
const EVENT_ID = 'e8000000-0000-4000-8000-000000000001';

/**
 * ADS-LINK round 2 (R-92, owner, 26 Oct 2026): an ad has TWO shapes, not three
 * places. LANDSCAPE shows in the Explore slider AND on the Today strip;
 * PORTRAIT shows in the TGIF full screen. One booking takes one picture per
 * shape, each optional, at least one required. Where an ad shows follows from
 * its pictures. A booking saved before the two shapes keeps its single picture
 * and its placement and is served exactly as it was, in that one place.
 *
 * Over HTTP on the migrated database with the real admin guards and serving.
 * Fixtures are suite-owned (the TAG below, admin ids starting `a8`) and swept
 * in afterAll, which then checks every table has the row count it began with.
 */
describe('Ads have two shapes: landscape and portrait (ADS-LINK round 2, R-92)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: Client;
  let adminTok = '';
  let financeTok = '';
  let viewerTok = '';
  let countsBefore: Record<string, number>;
  const env: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const BASE = '/api/hub/admin/ads';

  /** A booking made the way the dashboard makes it now: pictures only, no placement. */
  const shaped = (creative: Json = {}, over: Json = {}): Json => ({
    advertiser: `${TAG} Acme`,
    startsAt: iso(hoursFromNow(-1)),
    endsAt: iso(hoursFromNow(48)),
    weight: 100,
    creative: {
      headline: 'Shop with Acme',
      subline: 'Lagos',
      ctaLabel: 'Visit us',
      ctaDestination: 'link',
      ctaUrl: 'https://acme.example.com/shop?ref=wawu',
      ...creative,
    },
    ...over,
  });
  /** A booking made the old way: one picture and a placement. */
  const old = (placement: string, creative: Json = {}, over: Json = {}): Json =>
    shaped({ artworkUrl: OLD, ...creative }, { placement, ...over });

  const post = (b: Json) => http().post(BASE).set(bearer(adminTok)).send(b);
  const created = async (b: Json) => {
    const res = await post(b);
    expect(res.status).toBe(200);
    return res.body.data.campaign as Json;
  };
  const patch = (id: string, creative: Json, over: Json = {}) =>
    http()
      .patch(`${BASE}/${id}`)
      .set(bearer(adminTok))
      .send({ ...over, creative });
  const act = (id: string, action: string) =>
    http().post(`${BASE}/${id}/${action}`).set(bearer(adminTok));
  const onAir = async (b: Json) => {
    const c = await created(b);
    expect((await act(c.id, 'schedule')).status).toBe(200);
    return c;
  };
  const get = (url: string, query: Json = {}) =>
    http().get(url).query(query).set(bearer(adminTok));
  const served = async (placement: string) => {
    const res = await http()
      .get('/api/hub/ads')
      .query({ placement })
      .set(bearer(viewerTok));
    expect(res.status).toBe(200);
    return res.body.data;
  };
  /** The ids served in each of the three places. */
  const placesOf = async (id: string) => {
    const [tgif, today, explore] = await Promise.all([
      served('tgif_card'),
      served('today_slot'),
      served('explore_slider'),
    ]);
    return {
      tgif: tgif?.id === id ? tgif : null,
      today: today?.id === id ? today : null,
      explore: (explore as Json[]).find((c) => c.id === id) ?? null,
    };
  };

  async function counts(): Promise<Record<string, number>> {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    const out: Record<string, number> = {};
    for (const { tablename } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${tablename}"`,
      );
      out[tablename] = Number(rows[0].n);
    }
    return out;
  }
  async function sweepCampaigns(): Promise<void> {
    const ids = (
      await prisma.adCampaign.findMany({
        where: { advertiser: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((c) => c.id);
    await prisma.adEvent.deleteMany({ where: { campaignId: { in: ids } } });
    await prisma.adDailyTotal.deleteMany({
      where: { campaignId: { in: ids } },
    });
    await prisma.adminAdAudit.deleteMany({
      where: { campaignId: { in: ids } },
    });
    await prisma.adCampaign.deleteMany({ where: { id: { in: ids } } });
    await prisma.event.deleteMany({ where: { id: EVENT_ID } });
  }

  beforeAll(async () => {
    for (const k of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      env[k] = process.env[k];
    }
    process.env.ADMIN_JWT_SECRET = 'ads-shape-access-secret-0123456789abcdef';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'ads-shape-refresh-secret-0123456789abcdef';

    const login = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
    });
    viewerTok = ((await login.json()) as { accessToken: string }).accessToken;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminAdsModule,
        WawuAuthModule,
        AdsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
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
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.search = '';
    db = new Client({ connectionString: url.toString() });
    await db.connect();

    await sweepCampaigns();
    countsBefore = await counts();
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({
      where: { id: { in: [ADMIN_ID, FINANCE_ID] } },
    });
    await prisma.adminUser.createMany({
      data: [
        {
          id: ADMIN_ID,
          email: 'adshape-super@admin.test.wawu.dev',
          name: 'AdsShape super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: FINANCE_ID,
          email: 'adshape-fin@admin.test.wawu.dev',
          name: 'AdsShape finance',
          role: 'finance',
          passwordHash,
        },
      ],
    });
    const tok = async (email: string) =>
      (
        await http()
          .post('/api/hub/admin/auth/login')
          .send({ email, password: PASSWORD })
          .expect(200)
      ).body.data.accessToken as string;
    adminTok = await tok('adshape-super@admin.test.wawu.dev');
    financeTok = await tok('adshape-fin@admin.test.wawu.dev');
  }, 60_000);

  beforeEach(async () => {
    await prisma.adminAdAudit.deleteMany({
      where: { adminId: { in: [ADMIN_ID, FINANCE_ID] } },
    });
    await sweepCampaigns();
  });

  afterAll(async () => {
    await prisma.adminAdAudit.deleteMany({
      where: { adminId: { in: [ADMIN_ID, FINANCE_ID] } },
    });
    await sweepCampaigns();
    await prisma.adminUser.deleteMany({
      where: { id: { in: [ADMIN_ID, FINANCE_ID] } },
    });
    const after = await counts();
    await db.end();
    await app.close();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    expect(after).toEqual(countsBefore);
  });

  describe('where an ad shows follows from its pictures', () => {
    it('a landscape picture only: Explore and Today, each with that picture, never TGIF', async () => {
      const c = await onAir(shaped({ landscapeUrl: LAND }));
      expect(c.shows).toEqual(['explore_slider', 'today_slot']);
      expect(c.creative.landscapeUrl).toBe(LAND);
      expect(c.creative.portraitUrl).toBeNull();
      expect(c.creative.artworkUrl).toBeNull();
      const at = await placesOf(c.id);
      expect(at.tgif).toBeNull();
      expect(at.today?.artworkUrl).toBe(LAND);
      expect(at.explore?.artworkUrl).toBe(LAND);
    });

    it('a portrait picture only: TGIF only, never Explore or Today', async () => {
      const c = await onAir(shaped({ portraitUrl: PORT }));
      expect(c.shows).toEqual(['tgif_card']);
      expect(c.creative.portraitUrl).toBe(PORT);
      expect(c.creative.landscapeUrl).toBeNull();
      const at = await placesOf(c.id);
      expect(at.tgif?.artworkUrl).toBe(PORT);
      expect(at.today).toBeNull();
      expect(at.explore).toBeNull();
    });

    it('both pictures: all three places, each with the picture of its shape', async () => {
      const c = await onAir(shaped({ landscapeUrl: LAND, portraitUrl: PORT }));
      expect(c.shows).toEqual(['explore_slider', 'today_slot', 'tgif_card']);
      const at = await placesOf(c.id);
      expect(at.tgif?.artworkUrl).toBe(PORT);
      expect(at.today?.artworkUrl).toBe(LAND);
      expect(at.explore?.artworkUrl).toBe(LAND);
    });

    it('the card carries its kind of tap in every place it shows (a link card and a card that does nothing)', async () => {
      const link = await onAir(
        shaped({ landscapeUrl: LAND, portraitUrl: PORT }),
      );
      const none = await onAir(
        shaped(
          {
            landscapeUrl: LAND2,
            portraitUrl: PORT2,
            ctaDestination: 'none',
            ctaLabel: undefined,
            ctaUrl: undefined,
          },
          { weight: 1 },
        ),
      );
      const at = await placesOf(link.id);
      for (const card of [at.tgif, at.today, at.explore]) {
        expect(card.ctaDestination).toBe('link');
        expect(card.ctaUrl).toBe('https://acme.example.com/shop?ref=wawu');
        expect(Object.keys(card).sort()).toEqual([
          'advertiser',
          'artworkUrl',
          'ctaDestination',
          'ctaLabel',
          'ctaUrl',
          'headline',
          'id',
          'subline',
        ]);
      }
      const list = (await served('explore_slider')) as Json[];
      const noneCard = list.find((c) => c.id === none.id) as Json;
      expect(noneCard.ctaDestination).toBe('none');
      expect(noneCard.artworkUrl).toBe(LAND2);
      expect('ctaLabel' in noneCard).toBe(false);
    });

    it('the Explore list serves a landscape booking after a heavier one and the Today strip serves the heaviest', async () => {
      const heavy = await onAir(shaped({ landscapeUrl: LAND }, { weight: 90 }));
      const light = await onAir(shaped({ landscapeUrl: LAND2 }, { weight: 5 }));
      const list = ((await served('explore_slider')) as Json[]).map(
        (c) => c.id,
      );
      expect(list.indexOf(heavy.id)).toBeLessThan(list.indexOf(light.id));
      expect((await served('today_slot')).id).toBe(heavy.id);
    });

    it('the placement stored for a booking with pictures is only derived', async () => {
      const land = await created(shaped({ landscapeUrl: LAND }));
      const port = await created(shaped({ portraitUrl: PORT }));
      expect(land.placement).toBe('explore_slider');
      expect(port.placement).toBe('tgif_card');
    });
  });

  describe('an event booking is served as before, in whatever places its pictures give it', () => {
    it('carries exactly the eight keys it always had in every place, so a build already on phones reads it', async () => {
      const future = hoursFromNow(24 * 60);
      await prisma.event.create({
        data: {
          id: EVENT_ID,
          hostWawuId: 'a8a8a8a8-0000-4000-8000-000000000001',
          description: 'A fixture event for the ads shapes suite.',
          hostOrg: 'Contract Fixtures Ltd',
          format: 'in_person',
          type: 'workshop',
          location: 'Abuja',
          name: 'Gospel Night Live',
          status: 'published',
          startsAt: future,
          endsAt: new Date(future.getTime() + 4 * HOUR),
        },
      });
      const c = await onAir(
        shaped({
          landscapeUrl: LAND,
          portraitUrl: PORT,
          ctaDestination: 'event',
          ctaLabel: 'Get tickets',
          ctaDestinationId: EVENT_ID,
          ctaUrl: undefined,
        }),
      );
      const at = await placesOf(c.id);
      for (const [place, card] of Object.entries(at)) {
        expect(card).not.toBeNull();
        expect([place, Object.keys(card).sort()]).toEqual([
          place,
          [
            'advertiser',
            'artworkUrl',
            'ctaDestination',
            'ctaDestinationId',
            'ctaLabel',
            'headline',
            'id',
            'subline',
          ],
        ]);
        expect(card.ctaDestinationId).toBe(EVENT_ID);
      }
      expect(at.tgif.artworkUrl).toBe(PORT);
      expect(at.today.artworkUrl).toBe(LAND);
    });
  });

  describe('a picture is required, and the two ways of saving do not mix', () => {
    it('refuses a booking with no picture: 422', async () => {
      const res = await post(shaped({}));
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/artwork/i);
    });

    it('accepts the picture as a typed address and refuses a bad one', async () => {
      expect((await post(shaped({ landscapeUrl: LAND }))).status).toBe(200);
      for (const bad of [
        'http://x.example.com/a.png',
        'javascript:alert(1)',
        'a b',
      ]) {
        expect((await post(shaped({ landscapeUrl: bad }))).status).toBe(400);
        expect((await post(shaped({ portraitUrl: bad }))).status).toBe(400);
      }
    });

    it('refuses artworkUrl together with a shape, and a placement with a shape: 400', async () => {
      const mixed = await post(shaped({ artworkUrl: OLD, landscapeUrl: LAND }));
      expect(mixed.status).toBe(400);
      expect(mixed.body.reason?.code ?? mixed.body.message).toBeDefined();
      const withPlacement = await post(
        shaped({ landscapeUrl: LAND }, { placement: 'today_slot' }),
      );
      expect(withPlacement.status).toBe(400);
    });

    it('still takes the old body (one picture and a placement), and needs the placement for it', async () => {
      const ok = await created(old('today_slot'));
      expect(ok.placement).toBe('today_slot');
      expect(ok.creative.artworkUrl).toBe(OLD);
      const none = await post(shaped({ artworkUrl: OLD }));
      expect(none.status).toBe(400);
    });

    it('the database keeps the old picture and the two shapes apart, and each new picture an http(s) address', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      await expect(
        db.query(
          `UPDATE "AdCreative" SET "artworkUrl" = $1 WHERE "campaignId" = $2`,
          [OLD, c.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `UPDATE "AdCreative" SET "artworkPortraitUrl" = 'ftp://x.example.com/a.png' WHERE "campaignId" = $1`,
          [c.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `UPDATE "AdCreative" SET "artworkLandscapeUrl" = 'https://x.example.com/a b.png' WHERE "campaignId" = $1`,
          [c.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('a booking saved with no picture at all (before R-59) cannot go on air', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      await db.query(
        `UPDATE "AdCreative" SET "artworkLandscapeUrl" = NULL WHERE "campaignId" = $1`,
        [c.id],
      );
      const res = await act(c.id, 'schedule');
      expect(res.status).toBe(422);
      const row = (await get(`${BASE}/${c.id}`)).body.data;
      expect(row.needsArtwork).toBe(true);
      expect(row.shows).toEqual([]);
    });
  });

  describe('a booking saved before the two shapes is served exactly as it was', () => {
    it.each([
      ['explore_slider', ['explore']],
      ['today_slot', ['today']],
      ['tgif_card', ['tgif']],
    ])(
      'an old %s booking shows in its own place only',
      async (placement, only) => {
        const c = await onAir(old(placement));
        expect(c.shows).toEqual([placement]);
        const at = await placesOf(c.id);
        for (const [key, card] of Object.entries(at)) {
          if (only.includes(key)) expect((card as Json).artworkUrl).toBe(OLD);
          else expect(card).toBeNull();
        }
        // The admin view fills the shape of its own place.
        const landscape = placement !== 'tgif_card';
        expect(c.creative.landscapeUrl).toBe(landscape ? OLD : null);
        expect(c.creative.portraitUrl).toBe(landscape ? null : OLD);
      },
    );

    it('an edit that sends no picture leaves it as it was', async () => {
      const c = await created(old('explore_slider'));
      const res = await patch(c.id, { headline: 'A new headline' });
      expect(res.status).toBe(200);
      const after = res.body.data.campaign;
      expect(after.creative.artworkUrl).toBe(OLD);
      expect(after.shows).toEqual(['explore_slider']);
      expect(after.placement).toBe('explore_slider');
    });

    it('an edit that sends a new old-style picture or placement still works', async () => {
      const c = await created(old('explore_slider'));
      const a = await patch(c.id, { artworkUrl: LAND });
      expect(a.status).toBe(200);
      expect(a.body.data.campaign.creative.artworkUrl).toBe(LAND);
      const b = await patch(c.id, {}, { placement: 'tgif_card' });
      expect(b.status).toBe(200);
      expect(b.body.data.campaign.shows).toEqual(['tgif_card']);
    });

    it('sending a shape moves it to the two shapes and its own picture keeps its place', async () => {
      const ex = await created(old('explore_slider'));
      const a = await patch(ex.id, { portraitUrl: PORT });
      expect(a.status).toBe(200);
      const after = a.body.data.campaign;
      expect(after.creative.artworkUrl).toBeNull();
      expect(after.creative.landscapeUrl).toBe(OLD);
      expect(after.creative.portraitUrl).toBe(PORT);
      expect(after.shows).toEqual([
        'explore_slider',
        'today_slot',
        'tgif_card',
      ]);

      const tg = await created(old('tgif_card'));
      const b = await patch(tg.id, { landscapeUrl: LAND });
      expect(b.body.data.campaign.creative.portraitUrl).toBe(OLD);
      expect(b.body.data.campaign.creative.landscapeUrl).toBe(LAND);
      expect(b.body.data.campaign.shows).toEqual([
        'explore_slider',
        'today_slot',
        'tgif_card',
      ]);
    });

    it('replacing the picture of the shape it came from does not carry the old one', async () => {
      const ex = await created(old('today_slot'));
      const res = await patch(ex.id, { landscapeUrl: LAND });
      expect(res.body.data.campaign.creative.landscapeUrl).toBe(LAND);
      expect(res.body.data.campaign.creative.portraitUrl).toBeNull();
      expect(res.body.data.campaign.shows).toEqual([
        'explore_slider',
        'today_slot',
      ]);
    });
  });

  describe('editing the pictures of a booking', () => {
    it('adds a portrait picture to a landscape booking, replaces one, and takes one away', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      const add = await patch(c.id, { portraitUrl: PORT });
      expect(add.body.data.campaign.shows).toEqual([
        'explore_slider',
        'today_slot',
        'tgif_card',
      ]);
      const swap = await patch(c.id, { landscapeUrl: LAND2 });
      expect(swap.body.data.campaign.creative.landscapeUrl).toBe(LAND2);
      const drop = await patch(c.id, { landscapeUrl: null });
      expect(drop.status).toBe(200);
      expect(drop.body.data.campaign.shows).toEqual(['tgif_card']);
      expect(drop.body.data.campaign.placement).toBe('tgif_card');
      expect(drop.body.data.campaign.creative.landscapeUrl).toBeNull();
    });

    it('refuses taking away the last picture: 422', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      const res = await patch(c.id, { landscapeUrl: null });
      expect(res.status).toBe(422);
      expect(
        (await get(`${BASE}/${c.id}`)).body.data.creative.landscapeUrl,
      ).toBe(LAND);
    });

    it('refuses artworkUrl and a placement on a booking that holds shapes: 400', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      expect((await patch(c.id, { artworkUrl: OLD })).status).toBe(400);
      expect((await patch(c.id, {}, { placement: 'tgif_card' })).status).toBe(
        400,
      );
      expect(
        (await patch(c.id, { artworkUrl: OLD, landscapeUrl: LAND2 })).status,
      ).toBe(400);
    });

    it('records the pictures in the history, and an edit that changes nothing is refused', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      expect((await patch(c.id, { landscapeUrl: LAND })).status).toBe(400);
      const res = await patch(c.id, { portraitUrl: PORT });
      const entry = res.body.data.audit;
      expect(entry.changes.portraitUrl).toEqual({ from: null, to: PORT });
      expect(entry.changes.landscapeUrl).toBeUndefined();
      // The placement stored for a booking with pictures is only derived, so
      // the history does not record it.
      expect(entry.changes.placement).toBeUndefined();
      const dropped = await patch(c.id, { landscapeUrl: null });
      expect(dropped.body.data.audit.changes.placement).toBeUndefined();
      expect(dropped.body.data.audit.changes.landscapeUrl).toEqual({
        from: LAND,
        to: null,
      });
    });
  });

  describe('the admin list, report and overlaps follow where an ad shows', () => {
    it('the placement filter finds the bookings that show there', async () => {
      const land = await created(shaped({ landscapeUrl: LAND }));
      const port = await created(shaped({ portraitUrl: PORT }));
      const both = await created(
        shaped({ landscapeUrl: LAND2, portraitUrl: PORT2 }),
      );
      const oldToday = await created(old('today_slot'));
      const oldTgif = await created(old('tgif_card'));
      const ids = async (placement: string) =>
        ((await get(BASE, { placement, perPage: 100 })).body.data as Json[])
          .filter((i) => i.advertiser.startsWith(TAG))
          .map((i) => i.id)
          .sort();
      expect(await ids('explore_slider')).toEqual([land.id, both.id].sort());
      expect(await ids('today_slot')).toEqual(
        [land.id, both.id, oldToday.id].sort(),
      );
      expect(await ids('tgif_card')).toEqual(
        [port.id, both.id, oldTgif.id].sort(),
      );
    });

    it('the list row says where it shows, and what shapes it holds', async () => {
      const both = await created(
        shaped({ landscapeUrl: LAND, portraitUrl: PORT }),
      );
      const row = (
        (await get(BASE, { perPage: 100 })).body.data as Json[]
      ).find((i) => i.id === both.id) as Json;
      expect(row.shows).toEqual(['explore_slider', 'today_slot', 'tgif_card']);
      expect(row.creative.landscapeUrl).toBe(LAND);
      expect(row.creative.portraitUrl).toBe(PORT);
    });

    it('the summary counts a booking under each place it shows in, and servingNow likewise', async () => {
      const before = (await get(`${BASE}/report`)).body.data;
      await onAir(shaped({ landscapeUrl: LAND }));
      await onAir(shaped({ landscapeUrl: LAND2, portraitUrl: PORT2 }));
      const after = (await get(`${BASE}/report`)).body.data;
      expect(
        after.byPlacement.explore_slider - before.byPlacement.explore_slider,
      ).toBe(2);
      expect(after.byPlacement.today_slot - before.byPlacement.today_slot).toBe(
        2,
      );
      expect(after.byPlacement.tgif_card - before.byPlacement.tgif_card).toBe(
        1,
      );
      expect(
        after.servingNow.explore_slider - before.servingNow.explore_slider,
      ).toBe(2);
      expect(after.servingNow.tgif_card - before.servingNow.tgif_card).toBe(1);
      expect(after.campaigns - before.campaigns).toBe(2);
    });

    it('lists the bookings that share any place as overlapping', async () => {
      const a = await onAir(shaped({ landscapeUrl: LAND }));
      const sameShape = await onAir(shaped({ landscapeUrl: LAND2 }));
      const otherShape = await onAir(shaped({ portraitUrl: PORT }));
      const oldToday = await onAir(old('today_slot'));
      const detail = (await get(`${BASE}/${a.id}`)).body.data;
      const ids = (detail.overlapping as Json[]).map((o) => o.id);
      expect(ids).toContain(sameShape.id);
      expect(ids).toContain(oldToday.id);
      expect(ids).not.toContain(otherShape.id);
    });

    it('the finance role reads the views and cannot save pictures', async () => {
      const c = await created(shaped({ landscapeUrl: LAND }));
      const read = await http().get(`${BASE}/${c.id}`).set(bearer(financeTok));
      expect(read.status).toBe(200);
      expect(read.body.data.shows).toEqual(['explore_slider', 'today_slot']);
      const write = await http()
        .patch(`${BASE}/${c.id}`)
        .set(bearer(financeTok))
        .send({ creative: { portraitUrl: PORT } });
      expect(write.status).toBe(403);
    });
  });

  describe('views and taps are counted as before', () => {
    it('counts a view and a tap for a landscape booking, once a day each', async () => {
      const c = await onAir(shaped({ landscapeUrl: LAND }));
      for (const type of ['view', 'tap', 'view']) {
        const res = await http()
          .post(`/api/hub/ads/${c.id}/events`)
          .set(bearer(viewerTok))
          .send({ type });
        expect(res.status).toBe(200);
      }
      const row = (await get(`${BASE}/${c.id}`)).body.data;
      expect(row.delivery.views).toBe(1);
      expect(row.delivery.taps).toBe(1);
    });

    it('does not count for a booking that is not served', async () => {
      const draft = await created(shaped({ portraitUrl: PORT }));
      const res = await http()
        .post(`/api/hub/ads/${draft.id}/events`)
        .set(bearer(viewerTok))
        .send({ type: 'view' });
      expect(res.status).toBe(404);
    });
  });

  describe('the rule on its own', () => {
    const cols = {
      placement: 'today_slot' as const,
      artworkUrl: null,
      artworkLandscapeUrl: null,
      artworkPortraitUrl: null,
    };
    it('keeps an old booking in its own place and a shaped one by its pictures', () => {
      const row = (c: Json, placement = 'explore_slider') =>
        ({ placement, creative: { ...cols, ...c } }) as never;
      expect(showsIn(row({ artworkUrl: OLD }, 'today_slot'))).toEqual([
        'today_slot',
      ]);
      expect(showsIn(row({ artworkPortraitUrl: PORT }))).toEqual(['tgif_card']);
      expect(showsIn(row({ artworkLandscapeUrl: LAND }, 'tgif_card'))).toEqual([
        'explore_slider',
        'today_slot',
      ]);
      expect(showsIn(row({}))).toEqual([]);
    });
    it('resolves a request without touching the database', () => {
      expect(resolvePictures(null, {}).ok).toBe(false);
      expect(resolvePictures(null, { landscapeUrl: LAND })).toMatchObject({
        ok: true,
        value: { placement: 'explore_slider', artworkLandscapeUrl: LAND },
      });
    });
  });
});

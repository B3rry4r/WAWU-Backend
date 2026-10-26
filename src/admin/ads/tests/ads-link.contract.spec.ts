/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   supertest hands back untyped JSON; every field read here is asserted by value. */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
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
import { AD_LINK_URL_MAX } from '../../../ads/ads-text-limits';
import { AD_ARTWORK_MAX_BYTES } from '../../../storage/ad-artwork';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminAdsModule } from '../admin-ads.module';
import { checkCtaUrl, isHubArtworkShape } from '../ad-text';
import { resolveCta } from '../ad-destination';

/**
 * ADS-LINK (R-92): an ad opens the advertiser's web link, or does nothing, and
 * is not tied to an event. Over HTTP on the seeded database with the real
 * admin guards, serving, and the Hub's real storage client pointed at the
 * local storage stand-in (scripts/dev/storage-standin.cjs).
 *
 * Fixtures are suite-owned (the TAG below, admin ids starting `a7`) and swept
 * in afterAll, which then checks every table has the row count it began with.
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const TAG = 'ADSLINK-contract';
const PASSWORD = 'ads-link-contract-password';
const ADMIN_ID = 'a7000000-0000-4000-8000-000000000001';
const FINANCE_ID = 'a7000000-0000-4000-8000-000000000002';
const STANDIN_PORT = Number(process.env.ADK_STANDIN_PORT ?? 9942);
const BUCKET = 'adk-bucket';

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * HOUR);

type Json = Record<string, any>;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(32, 3),
]);

describe('Ads open a link or do nothing (ADS-LINK, R-92)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: Client;
  let standin: ChildProcess;
  let adminTok = '';
  let financeTok = '';
  let viewerTok = '';
  let countsBefore: Record<string, number>;
  const env: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const BASE = '/api/hub/admin/ads';

  const body = (creative: Json = {}, over: Json = {}): Json => ({
    advertiser: `${TAG} Acme`,
    placement: 'tgif_card',
    startsAt: iso(hoursFromNow(-1)),
    endsAt: iso(hoursFromNow(48)),
    weight: 5,
    creative: {
      headline: 'Shop with Acme',
      subline: 'Lagos',
      ctaLabel: 'Visit us',
      ctaDestination: 'link',
      ctaUrl: 'https://acme.example.com/shop?ref=wawu',
      artworkUrl: 'https://cdn.example.com/ads/acme.png',
      ...creative,
    },
    ...over,
  });
  const post = (creative: Json = {}, over: Json = {}) =>
    http().post(BASE).set(bearer(adminTok)).send(body(creative, over));
  const created = async (creative: Json = {}, over: Json = {}) => {
    const res = await post(creative, over);
    expect(res.status).toBe(200);
    return res.body.data.campaign as Json;
  };
  const patch = (id: string, creative: Json) =>
    http().patch(`${BASE}/${id}`).set(bearer(adminTok)).send({ creative });
  const act = (id: string, action: string) =>
    http().post(`${BASE}/${id}/${action}`).set(bearer(adminTok));
  const onAir = async (creative: Json = {}, over: Json = {}) => {
    const c = await created(creative, over);
    expect((await act(c.id, 'schedule')).status).toBe(200);
    return c;
  };
  const served = async (placement = 'tgif_card') => {
    const res = await http()
      .get('/api/hub/ads')
      .query({ placement })
      .set(bearer(viewerTok));
    expect(res.status).toBe(200);
    return res.body.data;
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
    await prisma.adCampaign.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    for (const k of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'STORAGE_ENDPOINT',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
      'STORAGE_BUCKET',
      'STORAGE_REGION',
      'STORAGE_FORCE_PATH_STYLE',
    ]) {
      env[k] = process.env[k];
    }
    process.env.ADMIN_JWT_SECRET = 'ads-link-access-secret-0123456789abcdef';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'ads-link-refresh-secret-0123456789abcdef';
    process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${STANDIN_PORT}`;
    process.env.STORAGE_ACCESS_KEY_ID = 'adk-key';
    process.env.STORAGE_SECRET_ACCESS_KEY = 'adk-secret';
    process.env.STORAGE_BUCKET = BUCKET;
    process.env.STORAGE_REGION = 'auto';
    process.env.STORAGE_FORCE_PATH_STYLE = 'true';

    standin = spawn(
      process.execPath,
      [
        join(__dirname, '../../../../scripts/dev/storage-standin.cjs'),
        String(STANDIN_PORT),
        BUCKET,
      ],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${STANDIN_PORT}/__standin/state`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

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
          email: 'adslink-super@admin.test.wawu.dev',
          name: 'AdsLink super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: FINANCE_ID,
          email: 'adslink-fin@admin.test.wawu.dev',
          name: 'AdsLink finance',
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
    adminTok = await tok('adslink-super@admin.test.wawu.dev');
    financeTok = await tok('adslink-fin@admin.test.wawu.dev');
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
    standin.kill();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    expect(after).toEqual(countsBefore);
  });

  describe('the address check', () => {
    it.each([
      ['https://acme.example.com', 'https://acme.example.com/'],
      [
        '  HTTPS://Acme.Example.COM/Shop?a=1#top ',
        'https://acme.example.com/Shop?a=1#top',
      ],
      ['https://acme.example.com:443/x', 'https://acme.example.com/x'],
    ])('accepts %j as %j', (raw, normal) => {
      expect(checkCtaUrl(raw)).toEqual({ ok: true, value: normal });
    });

    it.each([
      'http://acme.example.com',
      'javascript:alert(1)',
      'data:text/html;base64,AAAA',
      'ftp://acme.example.com',
      'file:///etc/passwd',
      'acme.example.com',
      '//acme.example.com',
      'https://localhost/x',
      'https://10.0.0.1/x',
      'https://u:p@acme.example.com',
      'https://acme.example.com/a b',
      'https://acme.example.com/"><script>',
      '',
      '   ',
      `https://acme.example.com/${'a'.repeat(AD_LINK_URL_MAX)}`,
    ])('refuses %j', (raw) => {
      expect(checkCtaUrl(raw).ok).toBe(false);
    });

    it("recognises only the shape of the Hub's own picture address", () => {
      const id = '0a1b2c3d-0000-4000-8000-000000000001';
      expect(
        isHubArtworkShape(`http://127.0.0.1:9942/b/ads/artwork/${id}.jpg`),
      ).toBe(true);
      expect(
        isHubArtworkShape(`https://x.example.com/ads/artwork/${id}.webp`),
      ).toBe(true);
      expect(
        isHubArtworkShape(`https://x.example.com/ads/artwork/${id}.gif`),
      ).toBe(false);
      expect(
        isHubArtworkShape(`https://x.example.com/ads/artwork/${id}.jpg?sig=1`),
      ).toBe(false);
      expect(
        isHubArtworkShape(`https://u:p@x.example.com/ads/artwork/${id}.jpg`),
      ).toBe(false);
    });
  });

  describe('what each kind keeps (resolveCta)', () => {
    it('clears what a kind does not keep and refuses it when sent', () => {
      const link = {
        ctaDestination: 'link' as const,
        ctaLabel: 'Visit',
        ctaDestinationId: null,
        ctaUrl: 'https://a.example.com/',
      };
      expect(resolveCta(link, { ctaDestination: 'none' })).toEqual({
        ok: true,
        value: {
          ctaDestination: 'none',
          ctaLabel: null,
          ctaDestinationId: null,
          ctaUrl: null,
        },
      });
      expect(
        resolveCta(link, { ctaDestination: 'none', ctaLabel: 'x' }).ok,
      ).toBe(false);
      expect(
        resolveCta(null, { ctaDestination: 'link', ctaLabel: 'x' }).ok,
      ).toBe(false);
      expect(
        resolveCta(null, {
          ctaDestination: 'event',
          ctaLabel: 'x',
          ctaUrl: 'https://a.example.com/',
        }).ok,
      ).toBe(false);
    });
  });

  describe('creating a campaign', () => {
    it('a link campaign stores the normal form and has no event', async () => {
      const c = await created({ ctaUrl: ' HTTPS://Acme.Example.com/Shop ' });
      expect(c.creative).toMatchObject({
        ctaDestination: 'link',
        ctaLabel: 'Visit us',
        ctaDestinationId: null,
        ctaUrl: 'https://acme.example.com/Shop',
      });
      expect(c.event).toBeNull();
      const row = await prisma.adCreative.findUnique({
        where: { campaignId: c.id },
      });
      expect(row).toMatchObject({
        ctaDestination: 'link',
        ctaUrl: 'https://acme.example.com/Shop',
        ctaDestinationId: null,
      });
    });

    it('a campaign that does nothing needs no button, no event and no address', async () => {
      const res = await post({
        ctaDestination: 'none',
        ctaLabel: undefined,
        ctaUrl: undefined,
      });
      expect(res.status).toBe(200);
      const c = res.body.data.campaign;
      expect(c.creative).toMatchObject({
        ctaDestination: 'none',
        ctaLabel: null,
        ctaDestinationId: null,
      });
      expect('ctaUrl' in c.creative).toBe(false);
      expect(c.event).toBeNull();
      const created2 = res.body.data.audit.changes;
      expect(created2.ctaDestination.to).toBe('none');
    });

    it.each([
      ['a link with no address', { ctaUrl: undefined }],
      ['a link with no button label', { ctaLabel: undefined }],
      [
        'a link that also names an event',
        { ctaDestinationId: 'e6000000-0000-4000-8000-000000000001' },
      ],
      ['a link to http', { ctaUrl: 'http://acme.example.com' }],
      ['a link to javascript:', { ctaUrl: 'javascript:alert(1)' }],
      ['a link to data:', { ctaUrl: 'data:text/html,hi' }],
      ['a bare host', { ctaUrl: 'acme.example.com' }],
      [
        'an address too long',
        { ctaUrl: `https://acme.example.com/${'a'.repeat(AD_LINK_URL_MAX)}` },
      ],
      ['an address that is null', { ctaUrl: null }],
      [
        'a campaign that does nothing but has a label',
        { ctaDestination: 'none', ctaUrl: undefined },
      ],
      [
        'a campaign that does nothing but has an address',
        { ctaDestination: 'none', ctaLabel: undefined },
      ],
      [
        'an event campaign with an address',
        {
          ctaDestination: 'event',
          ctaDestinationId: 'e6000000-0000-4000-8000-000000000001',
        },
      ],
      ['an unknown kind', { ctaDestination: 'phone' }],
    ])('refuses %s with a 400 and writes nothing', async (_n, creative) => {
      const before = await prisma.adCampaign.count();
      const res = await post(creative);
      expect(res.status).toBe(400);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).not.toMatch(/—|–/);
      expect(await prisma.adCampaign.count()).toBe(before);
    });

    it('finance can read but not upload or write', async () => {
      const c = await created();
      expect(
        (await http().get(`${BASE}/${c.id}`).set(bearer(financeTok))).status,
      ).toBe(200);
      expect(
        (
          await http()
            .post(`${BASE}/artwork`)
            .set(bearer(financeTok))
            .set('Content-Type', 'image/png')
            .send(PNG)
        ).status,
      ).toBe(403);
    });
  });

  describe('editing', () => {
    it('turns a link into a campaign that does nothing, and back', async () => {
      const c = await created();
      let res = await patch(c.id, { ctaDestination: 'none' });
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.creative).toMatchObject({
        ctaDestination: 'none',
        ctaLabel: null,
      });
      expect('ctaUrl' in res.body.data.campaign.creative).toBe(false);
      expect(res.body.data.audit.changes.ctaUrl.to).toBeNull();

      // No button label or address is carried over from before: both are asked for again.
      res = await patch(c.id, { ctaDestination: 'link' });
      expect(res.status).toBe(400);
      res = await patch(c.id, {
        ctaDestination: 'link',
        ctaLabel: 'Visit us',
        ctaUrl: 'https://acme.example.com/again',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.creative.ctaUrl).toBe(
        'https://acme.example.com/again',
      );
    });

    it('changes only the address of a link and keeps its button', async () => {
      const c = await created();
      const res = await patch(c.id, { ctaUrl: 'https://acme.example.com/new' });
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.creative).toMatchObject({
        ctaLabel: 'Visit us',
        ctaUrl: 'https://acme.example.com/new',
      });
      expect(Object.keys(res.body.data.audit.changes)).toEqual(['ctaUrl']);
    });

    it('refuses an address on a card that does nothing', async () => {
      const c = await created({
        ctaDestination: 'none',
        ctaLabel: undefined,
        ctaUrl: undefined,
      });
      expect(
        (await patch(c.id, { ctaUrl: 'https://acme.example.com/x' })).status,
      ).toBe(400);
      expect((await patch(c.id, { ctaLabel: 'Hi' })).status).toBe(400);
    });
  });

  describe('serving', () => {
    it('a link card carries its address and button, and no event id', async () => {
      await onAir();
      const card = await served();
      expect(Object.keys(card).sort()).toEqual(
        [
          'advertiser',
          'artworkUrl',
          'ctaDestination',
          'ctaLabel',
          'ctaUrl',
          'headline',
          'id',
          'subline',
        ].sort(),
      );
      expect(card).toMatchObject({
        ctaDestination: 'link',
        ctaLabel: 'Visit us',
        ctaUrl: 'https://acme.example.com/shop?ref=wawu',
      });
    });

    it('a card that does nothing has no button label, address or event id', async () => {
      await onAir({
        ctaDestination: 'none',
        ctaLabel: undefined,
        ctaUrl: undefined,
      });
      const card = await served();
      expect(Object.keys(card).sort()).toEqual(
        [
          'advertiser',
          'artworkUrl',
          'ctaDestination',
          'headline',
          'id',
          'subline',
        ].sort(),
      );
      expect(card.ctaDestination).toBe('none');
    });

    it('a campaign with no event at all is on air and counted as serving now', async () => {
      const c = await onAir({
        ctaDestination: 'none',
        ctaLabel: undefined,
        ctaUrl: undefined,
      });
      const detail = (await http().get(`${BASE}/${c.id}`).set(bearer(adminTok)))
        .body.data;
      expect(detail.servingNow).toBe(true);
    });

    it('the Explore list carries every kind, and views and taps are counted for a link', async () => {
      const a = await onAir({}, { placement: 'explore_slider', weight: 9 });
      const b = await onAir(
        { ctaDestination: 'none', ctaLabel: undefined, ctaUrl: undefined },
        { placement: 'explore_slider', weight: 8 },
      );
      const list = (await served('explore_slider')) as Json[];
      expect(list.map((x) => x.id)).toEqual([a.id, b.id]);
      expect(list.map((x) => x.ctaDestination)).toEqual(['link', 'none']);
      const tap = await http()
        .post(`/api/hub/ads/${a.id}/events`)
        .set(bearer(viewerTok))
        .send({ type: 'tap' });
      expect(tap.status).toBe(200);
      const view = await http()
        .post(`/api/hub/ads/${b.id}/events`)
        .set(bearer(viewerTok))
        .send({ type: 'view' });
      expect(view.status).toBe(200);
    });

    it('a paused link campaign is no longer served', async () => {
      const c = await onAir();
      expect(await served()).not.toBeNull();
      await act(c.id, 'pause');
      expect(await served()).toBeNull();
    });
  });

  describe('what the database refuses (AdCreative_cta_check)', () => {
    const SQL = `INSERT INTO "AdCreative" (id, "campaignId", headline, "ctaLabel", "ctaDestination", "ctaDestinationId", "ctaUrl", "artworkUrl", "updatedAt")
      VALUES ($1, $2, 'h', $3, $4::"AdCtaDestination", $5, $6, 'https://cdn.example.com/a.png', now())`;
    const refusal = async (args: Array<string | null>) => {
      const c = await created();
      await db.query('DELETE FROM "AdCreative" WHERE "campaignId" = $1', [
        c.id,
      ]);
      try {
        await db.query(SQL, [`${TAG}-${Math.random()}`, c.id, ...args]);
        return 'accepted';
      } catch (e) {
        return (e as { code?: string }).code ?? 'error';
      }
    };

    it.each([
      ['a link with no address', ['Visit', 'link', null, null]],
      [
        'a link carrying an event id',
        [
          'Visit',
          'link',
          'e6000000-0000-4000-8000-000000000001',
          'https://a.example.com/',
        ],
      ],
      [
        'a link with no button label',
        [null, 'link', null, 'https://a.example.com/'],
      ],
      ['a link to http', ['Visit', 'link', null, 'http://a.example.com/']],
      [
        'a link with a space',
        ['Visit', 'link', null, 'https://a.example.com/a b'],
      ],
      [
        'an event with an address',
        [
          'Go',
          'event',
          'e6000000-0000-4000-8000-000000000001',
          'https://a.example.com/',
        ],
      ],
      ['an event with no id', ['Go', 'event', null, null]],
      ['a card that does nothing with a label', ['Go', 'none', null, null]],
      [
        'a card that does nothing with an address',
        [null, 'none', null, 'https://a.example.com/'],
      ],
    ])('refuses %s', async (_n, args) => {
      expect(await refusal(args)).toBe('23514');
    });

    it.each([
      ['a link', ['Visit', 'link', null, 'https://a.example.com/']],
      ['a card that does nothing', [null, 'none', null, null]],
      [
        'an event',
        ['Go', 'event', 'e6000000-0000-4000-8000-000000000001', null],
      ],
    ])('accepts %s', async (_n, args) => {
      expect(await refusal(args)).toBe('accepted');
    });
  });

  describe('uploading the picture', () => {
    const upload = (
      type: string | undefined,
      bytes: Buffer,
      token = adminTok,
    ) => {
      const r = http().post(`${BASE}/artwork`).set(bearer(token));
      if (type) r.set('Content-Type', type);
      return r.send(bytes);
    };

    it.each([
      ['image/png', PNG, 'png'],
      ['image/jpeg', JPEG, 'jpg'],
      ['image/webp', WEBP, 'webp'],
    ])(
      'stores a %s and gives an address a campaign accepts',
      async (type, bytes, ext) => {
        const res = await upload(type, bytes);
        expect(res.status).toBe(200);
        const { artworkUrl, previewUrl, bytes: n } = res.body.data;
        expect(n).toBe(bytes.length);
        expect(artworkUrl).toMatch(
          new RegExp(`/ads/artwork/[0-9a-f-]{36}\\.${ext}$`),
        );
        expect(artworkUrl).not.toContain('?');
        expect(previewUrl).toContain('X-Amz-Signature');

        // The stand-in holds exactly these bytes under the key.
        const key = new URL(artworkUrl).pathname.replace(`/${BUCKET}/`, '');
        const held = await fetch(
          `http://127.0.0.1:${STANDIN_PORT}/${BUCKET}/${key}`,
        );
        expect(Buffer.from(await held.arrayBuffer()).equals(bytes)).toBe(true);

        // It saves as the artwork (plain http here, so the Hub checks it is its own bucket)...
        const c = await created({ artworkUrl });
        expect(c.creative.artworkUrl).toBe(artworkUrl);
        expect(c.creative.artworkPreviewUrl).toContain('X-Amz-Signature');
        // ...and is served signed afresh.
        await act(c.id, 'schedule');
        const card = await served();
        expect(card.artworkUrl).toContain('X-Amz-Signature');
        expect(card.artworkUrl.split('?')[0]).toBe(artworkUrl);
      },
    );

    it.each([
      [
        'a page sent as a picture',
        'image/png',
        Buffer.from('<html><script>alert(1)</script></html>'),
      ],
      ['a PNG declared as a JPEG', 'image/jpeg', PNG],
      ['a GIF', 'image/gif', Buffer.from('GIF89a......')],
      [
        'an SVG',
        'image/svg+xml',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ],
      ['an empty file', 'image/png', Buffer.alloc(0)],
      ['no content type', undefined, PNG],
    ])('refuses %s with a 400', async (_n, type, bytes) => {
      const res = await upload(type, bytes);
      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('refuses a file over the limit with a 413 and keeps nothing', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(AD_ARTWORK_MAX_BYTES)]);
      const res = await upload('image/png', big);
      expect(res.status).toBe(413);
    });

    it('is refused without an admin token', async () => {
      expect(
        (
          await http()
            .post(`${BASE}/artwork`)
            .set('Content-Type', 'image/png')
            .send(PNG)
        ).status,
      ).toBe(401);
      expect(
        (
          await http()
            .post(`${BASE}/artwork`)
            .set(bearer(viewerTok))
            .set('Content-Type', 'image/png')
            .send(PNG)
        ).status,
      ).toBe(401);
    });

    it("refuses a plain-http address that is not on the Hub's own bucket", async () => {
      const res = await post({
        artworkUrl:
          'http://evil.example.com/ads/artwork/0a1b2c3d-0000-4000-8000-000000000001.png',
      });
      expect(res.status).toBe(400);
    });
  });
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'http';
import { Client } from 'pg';
import request from 'supertest';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ADS_CLOCK } from '../ads-clock';
import { AdsModule } from '../ads.module';

/**
 * ADS-04: GET /ads?placement= over HTTP, on a real database, with tokens from
 * the mock WAWU ID. The server's clock is replaced by a settable one in most
 * tests, so every boundary is hit to the millisecond; one block at the end
 * runs the real clock to prove the production wiring.
 *
 * The spec owns its rows (ids start with "ads04-spec-"), removes them after
 * each test and checks that every table has the row count it began with, so
 * it passes alone, first, last or twice in a row.
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const VIEWER_EMAIL = 'user@test.wawu.dev';
const VIEWER_SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER_SUB = '00000000-0000-4000-8000-000000000002';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';

const PREFIX = 'ads04-spec-';
const T0 = new Date('2026-11-01T12:00:00.000Z');
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
const DAY = 24 * 60 * 60 * 1000;
const EVENT_START = new Date('2027-01-15T18:00:00.000Z');

const CARD_KEYS = [
  'advertiser',
  'artworkUrl',
  'ctaDestination',
  'ctaDestinationId',
  'ctaLabel',
  'headline',
  'id',
  'subline',
];

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface Envelope {
  statusCode: number;
  message: string;
  data: Record<string, unknown> | null;
}
/** The unwrapped body of a response, typed. */
const envelope = (res: { body: unknown }): Envelope => res.body as Envelope;
const dataOf = (res: { body: unknown }): Record<string, unknown> =>
  envelope(res).data ?? {};

interface CampaignOpts {
  id: string;
  placement?: 'tgif_card' | 'today_slot';
  status?: 'draft' | 'scheduled' | 'live' | 'paused' | 'ended';
  startsAt?: Date;
  endsAt?: Date;
  weight?: number;
  createdAt?: Date;
  /** The event the button opens. Default: a fresh open one is made. */
  eventId?: string;
  noCreative?: boolean;
  advertiser?: string;
  headline?: string;
}

describe('GET /ads (ADS-04)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: Client;
  let viewerToken: string;
  let otherToken: string;
  let now = T0;
  let countsBefore: Record<string, number> = {};

  const http = () => request(app.getHttpServer() as Server);
  const ask = (placement: string, token = viewerToken) =>
    http()
      .get(`/api/hub/ads?placement=${placement}`)
      .set('Authorization', `Bearer ${token}`);
  const card = async (placement = 'tgif_card', token = viewerToken) => {
    const res = await ask(placement, token).expect(200);
    return envelope(res).data;
  };

  async function boot(clock: boolean): Promise<INestApplication> {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdsModule,
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
    await a.init();
    return a;
  }

  async function allCounts(): Promise<Record<string, number>> {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    const counts: Record<string, number> = {};
    for (const { tablename } of tables.rows) {
      const r = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${tablename}"`,
      );
      counts[tablename] = Number(r.rows[0].n);
    }
    return counts;
  }

  async function cleanUp(): Promise<void> {
    await prisma.adCampaign.deleteMany({
      where: { id: { startsWith: PREFIX } },
    });
    await prisma.event.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: [VIEWER_SUB, OTHER_SUB, HOST_SUB] } },
    });
  }

  async function makeEvent(
    id: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    await prisma.event.create({
      data: {
        id,
        hostWawuId: HOST_SUB,
        name: 'Gospel Night Live',
        description: 'A fixture event for the ads serving spec.',
        hostOrg: 'Ads Spec Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Abuja',
        startsAt: EVENT_START,
        status: 'published',
        ...over,
      },
    });
    return id;
  }

  /** A campaign with its creative, in an eligible state unless overridden. */
  async function makeCampaign(o: CampaignOpts): Promise<string> {
    const id = PREFIX + o.id;
    const eventId = o.eventId ?? (await makeEvent(PREFIX + 'ev-' + o.id));
    await prisma.adCampaign.create({
      data: {
        id,
        advertiser: o.advertiser ?? `Advertiser ${o.id}`,
        placement: o.placement ?? 'tgif_card',
        status: o.status ?? 'live',
        startsAt: o.startsAt ?? ms(T0, -DAY),
        endsAt: o.endsAt ?? ms(T0, DAY),
        weight: o.weight ?? 1,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
        ...(o.noCreative
          ? {}
          : {
              creative: {
                create: {
                  id: PREFIX + 'cr-' + o.id,
                  headline: o.headline ?? `Headline ${o.id}`,
                  subline: `Subline ${o.id}`,
                  ctaLabel: 'Get tickets',
                  ctaDestination: 'event',
                  ctaDestinationId: eventId,
                  artworkUrl: `https://cdn.example.test/${o.id}.jpg`,
                },
              },
            }),
      },
    });
    return id;
  }

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
    prisma = app.get(PrismaService);
    await cleanUp();
    countsBefore = await allCounts();
    viewerToken = await loginToWawuId(VIEWER_EMAIL);
    otherToken = await loginToWawuId(OTHER_EMAIL);
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

  describe('who may ask, and what they may ask', () => {
    it('refuses a request with no token or a bad one (401)', async () => {
      await http().get('/api/hub/ads?placement=tgif_card').expect(401);
      await http()
        .get('/api/hub/ads?placement=tgif_card')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
    });

    it('needs a placement, and only the two placements (400)', async () => {
      const auth = { Authorization: `Bearer ${viewerToken}` };
      await http().get('/api/hub/ads').set(auth).expect(400);
      await http().get('/api/hub/ads?placement=').set(auth).expect(400);
      await http().get('/api/hub/ads?placement=banner').set(auth).expect(400);
      await http()
        .get('/api/hub/ads?placement=TGIF_CARD')
        .set(auth)
        .expect(400);
      await http()
        .get('/api/hub/ads?placement=tgif_card&placement=today_slot')
        .set(auth)
        .expect(400);
      await http()
        .get('/api/hub/ads?placement=tgif_card&status=draft')
        .set(auth)
        .expect(400);
    });

    it('answers only GET', async () => {
      const auth = { Authorization: `Bearer ${viewerToken}` };
      await http()
        .post('/api/hub/ads?placement=tgif_card')
        .set(auth)
        .expect(404);
      await http()
        .delete('/api/hub/ads?placement=tgif_card')
        .set(auth)
        .expect(404);
    });
  });

  describe('capability: each placement returns at most one live card, none outside its dates', () => {
    it('serves a tgif_card card and a today_slot card, one each, from the same bookings', async () => {
      await makeCampaign({ id: 't1', placement: 'tgif_card' });
      await makeCampaign({ id: 't2', placement: 'tgif_card' });
      await makeCampaign({ id: 's1', placement: 'today_slot' });
      await makeCampaign({ id: 's2', placement: 'today_slot' });

      const tgif = await ask('tgif_card').expect(200);
      expect(Array.isArray(envelope(tgif).data)).toBe(false);
      expect(String(dataOf(tgif).id)).toMatch(/^ads04-spec-t[12]$/);

      const today = await ask('today_slot').expect(200);
      expect(Array.isArray(envelope(today).data)).toBe(false);
      expect(String(dataOf(today).id)).toMatch(/^ads04-spec-s[12]$/);
    });

    it('never serves a card for the other placement', async () => {
      await makeCampaign({ id: 'only-tgif', placement: 'tgif_card' });
      expect(await card('today_slot')).toBeNull();
      await cleanUp();
      await makeCampaign({ id: 'only-today', placement: 'today_slot' });
      expect(await card('tgif_card')).toBeNull();
      expect((await card('today_slot'))?.id).toBe(PREFIX + 'only-today');
    });

    it.each(['tgif_card', 'today_slot'] as const)(
      '%s: serves exactly from startsAt to just before endsAt, to the millisecond',
      async (placement) => {
        const startsAt = ms(T0, 10 * DAY);
        const endsAt = ms(startsAt, 5 * DAY);
        await makeCampaign({ id: 'win', placement, startsAt, endsAt });

        now = ms(startsAt, -DAY);
        expect(await card(placement)).toBeNull();
        now = ms(startsAt, -1);
        expect(await card(placement)).toBeNull();
        now = startsAt;
        expect((await card(placement))?.id).toBe(PREFIX + 'win');
        now = ms(startsAt, 1);
        expect((await card(placement))?.id).toBe(PREFIX + 'win');
        now = ms(endsAt, -1);
        expect((await card(placement))?.id).toBe(PREFIX + 'win');
        now = endsAt;
        expect(await card(placement)).toBeNull();
        now = ms(endsAt, 1);
        expect(await card(placement)).toBeNull();
        now = ms(endsAt, 30 * DAY);
        expect(await card(placement)).toBeNull();
      },
    );

    it('a one-millisecond window serves for that millisecond only', async () => {
      await makeCampaign({ id: 'tiny', startsAt: T0, endsAt: ms(T0, 1) });
      expect((await card())?.id).toBe(PREFIX + 'tiny');
      now = ms(T0, 1);
      expect(await card()).toBeNull();
    });
  });

  describe('capability: with no live campaign, nothing is returned', () => {
    it('answers 200 with data null on an empty table', async () => {
      const res = await ask('tgif_card').expect(200);
      expect(res.body).toEqual({ statusCode: 200, message: 'OK', data: null });
      const res2 = await ask('today_slot').expect(200);
      expect(res2.body).toEqual({ statusCode: 200, message: 'OK', data: null });
    });

    it('answers the same 200 null when every booking is outside its dates or not servable', async () => {
      await makeCampaign({
        id: 'past',
        endsAt: ms(T0, -1),
        startsAt: ms(T0, -DAY),
      });
      await makeCampaign({
        id: 'future',
        startsAt: ms(T0, 1),
        endsAt: ms(T0, DAY),
      });
      await makeCampaign({ id: 'draft', status: 'draft' });
      await makeCampaign({ id: 'paused', status: 'paused' });
      await makeCampaign({ id: 'ended', status: 'ended' });
      await makeCampaign({ id: 'nocreative', noCreative: true });
      const res = await ask('tgif_card').expect(200);
      expect(res.body).toEqual({ statusCode: 200, message: 'OK', data: null });
    });
  });

  describe('what a card carries', () => {
    it('has exactly the card fields and nothing else', async () => {
      await makeCampaign({
        id: 'shape',
        advertiser: 'Gospel House',
        headline: 'Gospel Night Live',
      });
      const res = await ask('tgif_card').expect(200);
      expect(envelope(res).statusCode).toBe(200);
      expect(Object.keys(dataOf(res)).sort()).toEqual(CARD_KEYS);
      expect(envelope(res).data).toEqual({
        id: PREFIX + 'shape',
        advertiser: 'Gospel House',
        headline: 'Gospel Night Live',
        subline: 'Subline shape',
        ctaLabel: 'Get tickets',
        ctaDestination: 'event',
        ctaDestinationId: PREFIX + 'ev-shape',
        artworkUrl: 'https://cdn.example.test/shape.jpg',
      });
    });

    it('serves a null subline and a null artwork as null, not as missing keys', async () => {
      await makeCampaign({ id: 'plain' });
      await prisma.adCreative.update({
        where: { campaignId: PREFIX + 'plain' },
        data: { subline: null, artworkUrl: null },
      });
      const data = await card();
      expect(Object.keys(data ?? {}).sort()).toEqual(CARD_KEYS);
      expect(data?.subline).toBeNull();
      expect(data?.artworkUrl).toBeNull();
    });

    it('is never cached: no-store on a card and on an empty answer', async () => {
      await makeCampaign({ id: 'cache' });
      const withCard = await ask('tgif_card').expect(200);
      expect(withCard.headers['cache-control']).toBe('no-store');
      const empty = await ask('today_slot').expect(200);
      expect(empty.headers['cache-control']).toBe('no-store');
    });

    it('leaks nothing of the other bookings, nor any internal field', async () => {
      await makeCampaign({
        id: 'shown',
        weight: 50,
        advertiser: 'Shown Advertiser',
        headline: 'Shown Headline',
      });
      await makeCampaign({
        id: 'hidden-draft',
        status: 'draft',
        weight: 99,
        advertiser: 'Draft Advertiser',
        headline: 'Draft Headline',
      });
      await makeCampaign({
        id: 'hidden-paused',
        status: 'paused',
        weight: 98,
        advertiser: 'Paused Advertiser',
        headline: 'Paused Headline',
      });
      await makeCampaign({
        id: 'hidden-ended',
        status: 'ended',
        weight: 97,
        advertiser: 'Ended Advertiser',
        headline: 'Ended Headline',
      });
      await makeCampaign({
        id: 'hidden-expired',
        weight: 96,
        endsAt: ms(T0, -1),
        advertiser: 'Expired Advertiser',
        headline: 'Expired Headline',
      });
      await makeCampaign({
        id: 'hidden-other',
        placement: 'today_slot',
        weight: 95,
        advertiser: 'Other Placement Advertiser',
      });
      const res = await ask('tgif_card').expect(200);
      const text = JSON.stringify(res.body);
      for (const word of [
        'Draft',
        'Paused',
        'Ended',
        'Expired',
        'Other Placement',
        '"weight"',
        '"status"',
        '"startsAt"',
        '"endsAt"',
        '"placement"',
        '"createdAt"',
        '"updatedAt"',
        '"campaignId"',
        '"creativeId"',
        'ads04-spec-cr-',
      ]) {
        expect(text).not.toContain(word);
      }
      expect(dataOf(res).id).toBe(PREFIX + 'shown');
      expect(Object.keys(dataOf(res)).sort()).toEqual(CARD_KEYS);
    });

    it('serves the same card to every signed-in viewer', async () => {
      await makeCampaign({ id: 'same' });
      expect(await card('tgif_card', viewerToken)).toEqual(
        await card('tgif_card', otherToken),
      );
    });
  });

  describe('status', () => {
    it.each(['draft', 'paused', 'ended'] as const)(
      '%s is never served, even inside its window',
      async (status) => {
        await makeCampaign({ id: 'st', status });
        expect(await card()).toBeNull();
      },
    );

    it.each(['scheduled', 'live'] as const)(
      '%s is served inside its window',
      async (status) => {
        await makeCampaign({ id: 'st', status });
        expect((await card())?.id).toBe(PREFIX + 'st');
      },
    );

    it('a pause takes effect on the very next request, and so does going live again', async () => {
      await makeCampaign({ id: 'pause' });
      expect((await card())?.id).toBe(PREFIX + 'pause');
      await prisma.adCampaign.update({
        where: { id: PREFIX + 'pause' },
        data: { status: 'paused' },
      });
      expect(await card()).toBeNull();
      await prisma.adCampaign.update({
        where: { id: PREFIX + 'pause' },
        data: { status: 'live' },
      });
      expect((await card())?.id).toBe(PREFIX + 'pause');
    });

    it('a campaign without a creative is skipped and the next is served', async () => {
      await makeCampaign({ id: 'bare', weight: 100, noCreative: true });
      await makeCampaign({ id: 'full', weight: 1 });
      expect((await card())?.id).toBe(PREFIX + 'full');
    });
  });

  describe('which one, when several are eligible', () => {
    it('the highest weight wins', async () => {
      await makeCampaign({ id: 'w1', weight: 1 });
      await makeCampaign({ id: 'w50', weight: 50 });
      await makeCampaign({ id: 'w100', weight: 100 });
      await makeCampaign({ id: 'w99', weight: 99 });
      expect((await card())?.id).toBe(PREFIX + 'w100');
    });

    it('a heavier campaign that is not eligible does not win', async () => {
      await makeCampaign({ id: 'light', weight: 1 });
      await makeCampaign({ id: 'heavy-paused', weight: 100, status: 'paused' });
      await makeCampaign({
        id: 'heavy-future',
        weight: 100,
        startsAt: ms(T0, 1),
      });
      await makeCampaign({
        id: 'heavy-other',
        weight: 100,
        placement: 'today_slot',
      });
      expect((await card())?.id).toBe(PREFIX + 'light');
    });

    it('a tie goes to the booking whose window began first', async () => {
      await makeCampaign({ id: 'late', weight: 5, startsAt: ms(T0, -DAY) });
      await makeCampaign({
        id: 'early',
        weight: 5,
        startsAt: ms(T0, -3 * DAY),
      });
      await makeCampaign({ id: 'mid', weight: 5, startsAt: ms(T0, -2 * DAY) });
      expect((await card())?.id).toBe(PREFIX + 'early');
    });

    it('a tie in weight and start goes to the one created first', async () => {
      const same = { weight: 5, startsAt: ms(T0, -DAY) };
      await makeCampaign({ id: 'c-b', ...same, createdAt: ms(T0, -2000) });
      await makeCampaign({ id: 'c-a', ...same, createdAt: ms(T0, -1000) });
      await makeCampaign({ id: 'c-c', ...same, createdAt: ms(T0, -3000) });
      expect((await card())?.id).toBe(PREFIX + 'c-c');
    });

    it('a tie in all three goes to the smallest id, the same every time', async () => {
      const same = {
        weight: 5,
        startsAt: ms(T0, -DAY),
        createdAt: ms(T0, -1000),
      };
      await makeCampaign({ id: 'z', ...same });
      await makeCampaign({ id: 'm', ...same });
      await makeCampaign({ id: 'a', ...same });
      for (let i = 0; i < 5; i += 1) {
        expect((await card())?.id).toBe(PREFIX + 'a');
      }
    });

    it('answers the same to a crowd of parallel requests, from both viewers', async () => {
      const same = {
        weight: 7,
        startsAt: ms(T0, -DAY),
        createdAt: ms(T0, -1000),
      };
      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        await makeCampaign({ id, ...same });
      }
      await app.listen(0);
      const base = await app.getUrl();
      const answers = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          request(base)
            .get('/api/hub/ads?placement=tgif_card')
            .set(
              'Authorization',
              `Bearer ${i % 2 === 0 ? viewerToken : otherToken}`,
            )
            .then((r) => ({ status: r.status, body: envelope(r) })),
        ),
      );
      for (const a of answers) expect(a.status).toBe(200);
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
      expect((answers[0].body.data ?? {}).id).toBe(PREFIX + 'p1');
    });

    it('requests do not write: the bookings are untouched by serving', async () => {
      await makeCampaign({ id: 'ro' });
      const before = await prisma.adCampaign.findMany({
        where: { id: { startsWith: PREFIX } },
        include: { creative: true },
      });
      for (let i = 0; i < 10; i += 1) await card();
      const after = await prisma.adCampaign.findMany({
        where: { id: { startsWith: PREFIX } },
        include: { creative: true },
      });
      expect(after).toEqual(before);
    });
  });

  describe('the event behind the button must still be open', () => {
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
      'skips a campaign whose event is %s and serves the next one',
      async (_name, over) => {
        const ev = await makeEvent(PREFIX + 'ev-closed', over);
        await makeCampaign({ id: 'heavy', weight: 100, eventId: ev });
        await makeCampaign({ id: 'next', weight: 1 });
        expect((await card())?.id).toBe(PREFIX + 'next');
      },
    );

    it.each(closed)(
      'serves nothing when the only campaign has an event that is %s',
      async (_name, over) => {
        const ev = await makeEvent(PREFIX + 'ev-closed', over);
        await makeCampaign({ id: 'only', eventId: ev });
        expect(await card()).toBeNull();
      },
    );

    it('skips a campaign whose event was deleted, or never existed', async () => {
      await makeCampaign({
        id: 'ghost',
        weight: 100,
        eventId: 'ads04-spec-no-such-event',
      });
      const gone = await makeEvent(PREFIX + 'ev-gone');
      await makeCampaign({ id: 'deleted', weight: 90, eventId: gone });
      await prisma.event.delete({ where: { id: gone } });
      await makeCampaign({ id: 'ok', weight: 1 });
      expect((await card())?.id).toBe(PREFIX + 'ok');
    });

    it('serves a campaign again the moment its event is published', async () => {
      const ev = await makeEvent(PREFIX + 'ev-late', { status: 'pending' });
      await makeCampaign({ id: 'late', eventId: ev });
      expect(await card()).toBeNull();
      await prisma.event.update({
        where: { id: ev },
        data: { status: 'published' },
      });
      expect((await card())?.id).toBe(PREFIX + 'late');
    });

    it('an event ending exactly now is still open, one millisecond later it is not', async () => {
      const ev = await makeEvent(PREFIX + 'ev-edge', {
        startsAt: ms(T0, -DAY),
        endsAt: ms(T0, 5),
      });
      await makeCampaign({ id: 'edge', eventId: ev });
      now = ms(T0, 5);
      expect((await card())?.id).toBe(PREFIX + 'edge');
      now = ms(T0, 6);
      expect(await card()).toBeNull();
    });

    it('an event with no end that starts exactly now is open', async () => {
      const ev = await makeEvent(PREFIX + 'ev-now', { startsAt: T0 });
      await makeCampaign({ id: 'now', eventId: ev });
      expect((await card())?.id).toBe(PREFIX + 'now');
    });

    it('falls through many closed events to the one that is open', async () => {
      for (let i = 0; i < 40; i += 1) {
        const ev = await makeEvent(`${PREFIX}ev-c${i}`, { status: 'rejected' });
        await makeCampaign({ id: `c${i}`, weight: 100, eventId: ev });
      }
      await makeCampaign({ id: 'last', weight: 1 });
      expect((await card())?.id).toBe(PREFIX + 'last');
    });

    it('two campaigns on one event: both follow it', async () => {
      const ev = await makeEvent(PREFIX + 'ev-shared');
      await makeCampaign({ id: 'a', weight: 2, eventId: ev });
      await makeCampaign({ id: 'b', weight: 1, eventId: ev });
      expect((await card())?.id).toBe(PREFIX + 'a');
      await prisma.event.update({
        where: { id: ev },
        data: { status: 'removed' },
      });
      expect(await card()).toBeNull();
    });

    it('skips an event whose host the viewer blocked, or who blocked the viewer, for that viewer only', async () => {
      const ev = await makeEvent(PREFIX + 'ev-blocked');
      await makeCampaign({ id: 'heavy', weight: 100, eventId: ev });
      const elsewhere = await makeEvent(PREFIX + 'ev-elsewhere', {
        hostWawuId: '00000000-0000-4000-8000-0000000000aa',
      });
      await makeCampaign({ id: 'plain', weight: 1, eventId: elsewhere });

      await prisma.blockedAccount.create({
        data: { userWawuId: VIEWER_SUB, blockedWawuId: HOST_SUB },
      });
      expect((await card('tgif_card', viewerToken))?.id).toBe(PREFIX + 'plain');
      expect((await card('tgif_card', otherToken))?.id).toBe(PREFIX + 'heavy');

      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: VIEWER_SUB },
      });
      await prisma.blockedAccount.create({
        data: { userWawuId: HOST_SUB, blockedWawuId: OTHER_SUB },
      });
      expect((await card('tgif_card', otherToken))?.id).toBe(PREFIX + 'plain');
      expect((await card('tgif_card', viewerToken))?.id).toBe(PREFIX + 'heavy');
    });
  });

  describe('with the real clock', () => {
    let real: INestApplication;
    let realToken: string;

    beforeAll(async () => {
      real = await boot(false);
      realToken = await loginToWawuId(VIEWER_EMAIL);
    });
    afterAll(async () => {
      await real.close();
    });

    const realCard = async () => {
      const res = await request(real.getHttpServer() as Server)
        .get('/api/hub/ads?placement=tgif_card')
        .set('Authorization', `Bearer ${realToken}`)
        .expect(200);
      return envelope(res).data as { id: string } | null;
    };

    it('serves a campaign that is running now and none that has ended or not begun', async () => {
      const real0 = Date.now();
      await makeCampaign({
        id: 'r-now',
        weight: 1,
        startsAt: ms(new Date(real0), -DAY),
        endsAt: ms(new Date(real0), DAY),
      });
      await makeCampaign({
        id: 'r-ended',
        weight: 100,
        startsAt: ms(new Date(real0), -2 * DAY),
        endsAt: ms(new Date(real0), -1000),
      });
      await makeCampaign({
        id: 'r-soon',
        weight: 100,
        startsAt: ms(new Date(real0), DAY),
        endsAt: ms(new Date(real0), 2 * DAY),
      });
      expect((await realCard())?.id).toBe(PREFIX + 'r-now');
    });

    it('stops serving a campaign when its end passes, with nothing cached', async () => {
      const endsAt = new Date(Date.now() + 1500);
      await makeCampaign({
        id: 'r-ends',
        startsAt: ms(endsAt, -DAY),
        endsAt,
      });
      expect((await realCard())?.id).toBe(PREFIX + 'r-ends');
      await new Promise((r) => setTimeout(r, 1700));
      expect(await realCard()).toBeNull();
    });
  });
});

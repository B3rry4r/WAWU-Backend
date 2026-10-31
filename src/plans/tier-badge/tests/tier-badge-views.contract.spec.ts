import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ContentPieceModule } from '../../../content-piece/content-piece.module';
import { FeedCardsService } from '../../../content-piece/feed-cards.service';
import { ExploreModule } from '../../../explore/explore.module';
import { ProfessionalModule } from '../../../professional/professional.module';
import { StorageService } from '../../../storage/storage.service';
import { UserProfileModule } from '../../../user-profile/user-profile.module';

/**
 * TIER-07: the tier badge on the profile fields, the explore and feed cards and
 * the professional directory, and the web's routes answering exactly as before.
 * Seeded accounts: CHIDI and ZAINAB are creators with live pieces, PLAIN looks.
 */

const PLAIN = '00000000-0000-4000-8000-000000000001';
const CHIDI = '00000000-0000-4000-8000-000000000002';
const ZAINAB = '00000000-0000-4000-8000-000000000003';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const DAY = 86_400_000;

const storageStub = {
  freshUrlFor: (s: string | null) => Promise.resolve(s),
  // CONTENT-COVER: the feed cards ask for a cover link; a piece here has no cover.
  coverUrlFor: (s: string | null | undefined) => Promise.resolve(s ?? null),
};

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
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** A response's `data`, typed by the caller (supertest bodies are `any`). */
const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

type Badge = {
  id: string;
  numbered: boolean;
  name: string;
  number: number | null;
} | null;

describe('The tier badge on profiles and cards (TIER-07, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cards: FeedCardsService;
  let mock: ChildProcess | undefined;
  let plain: string;
  let chidiToken: string;
  let proId: string;
  let listingId: string;
  const http = () => request(app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const tier = (
    wawuUserId: string,
    tierId: string,
    activeUntil: Date,
    badgeNumber: number | null = null,
  ) =>
    prisma.makerTier.upsert({
      where: { wawuUserId },
      create: {
        wawuUserId,
        tierId,
        activeFrom: new Date(Date.now() - 30 * DAY),
        activeUntil,
        productsIncluded: 10,
        pointsIncluded: 0,
        badgeNumber,
      },
      update: { tierId, activeUntil, badgeNumber },
    });
  const clear = () =>
    prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: [CHIDI, ZAINAB, proId] } },
    });
  const fieldsOf = async (id: string): Promise<Badge> =>
    (
      (
        await http()
          .get(`/api/hub/users/${id}/profile-fields`)
          .set(as(plain))
          .expect(200)
      ).body as { data: { badge: Badge } }
    ).data.badge;

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`)))
        throw new Error('mock-wawu-id did not come up');
    }
    plain = await login('user@test.wawu.dev');
    chidiToken = await login('creator-basic@test.wawu.dev');
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
        ExploreModule,
        ProfessionalModule,
        ContentPieceModule,
      ],
    })
      .overrideProvider(StorageService)
      .useValue(storageStub)
      .compile();
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
    await app.listen(0);
    prisma = app.get(PrismaService);
    cards = moduleRef.get(FeedCardsService, { strict: false });

    proId = randomUUID();
    await prisma.userProfile.create({
      data: {
        wawuUserId: proId,
        accountType: 'creator',
        handle: `t07_${proId.slice(0, 8)}`,
      },
    });
    await prisma.creatorState.create({
      data: {
        wawuUserId: proId,
        dmEnabled: true,
        dmPrice: 5000,
        dmResponseHours: 24,
      },
    });
    listingId = (
      await prisma.professionalProfile.create({
        data: {
          wawuUserId: proId,
          category: 'finance',
          headline: 'Chartered accountant',
          about: 'Tax filing and books for creators and small businesses.',
          services: ['Tax filing'],
          credentialKind: 'licence',
          licenceNumber: 'ICAN/2016/40921',
          issuingBody: 'ICAN',
          status: 'approved',
          reviewedAt: new Date(),
        },
      })
    ).id;
  }, 60000);

  afterAll(async () => {
    await clear();
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: proId },
    });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: proId } });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: proId } });
    await app?.close();
    mock?.kill();
  });

  beforeEach(clear);

  it('a Founding Maker shows the numbered badge on their profile fields, as visitor and as themselves; with no tier it is null', async () => {
    expect(await fieldsOf(CHIDI)).toBeNull();
    await tier(CHIDI, 'founding', new Date(Date.now() + 100 * DAY), 128);
    const want = {
      id: 'founding',
      numbered: true,
      name: 'Founding Maker',
      number: 128,
    };
    expect(await fieldsOf(CHIDI)).toEqual(want);
    const mine = await http()
      .get('/api/hub/users/me/profile-fields')
      .set(as(chidiToken))
      .expect(200);
    expect(dataOf<{ badge: Badge }>(mine).badge).toEqual(want);
  });

  it('the badge is gone once the tier has ended, and a Verify holder shows the plain badge', async () => {
    await tier(ZAINAB, 'verify', new Date(Date.now() + 10 * DAY));
    expect(await fieldsOf(ZAINAB)).toEqual({
      id: 'verified',
      numbered: false,
      name: 'Verify',
      number: null,
    });
    await tier(ZAINAB, 'verify', new Date(Date.now() - 1000));
    expect(await fieldsOf(ZAINAB)).toBeNull();
  });

  it('GET /users/me and the public profile gain no key, with a tier running or not', async () => {
    const read = async () => ({
      me: dataOf<Record<string, unknown>>(
        await http().get('/api/hub/users/me').set(as(chidiToken)).expect(200),
      ),
      pub: dataOf<Record<string, unknown>>(
        await http()
          .get(`/api/hub/users/${CHIDI}/public-profile`)
          .set(as(plain))
          .expect(200),
      ),
    });
    const without = await read();
    await tier(CHIDI, 'founding', new Date(Date.now() + 100 * DAY), 7);
    const withTier = await read();
    for (const r of [without, withTier]) {
      expect(r.me).not.toHaveProperty('badge');
      expect(r.pub).not.toHaveProperty('badge');
    }
    expect(Object.keys(withTier.me).sort()).toEqual(
      Object.keys(without.me).sort(),
    );
    expect(Object.keys(withTier.pub).sort()).toEqual(
      Object.keys(without.pub).sort(),
    );
  });

  it('the explore cards carry the badge, null for a person without a running tier', async () => {
    await tier(CHIDI, 'founding', new Date(Date.now() + 100 * DAY), 9);
    await tier(ZAINAB, 'verify', new Date(Date.now() - 1000));
    for (const url of [
      '/api/hub/explore/creators?page=1&perPage=50',
      '/api/hub/explore/featured-creators',
    ]) {
      const res = await http().get(url).set(as(plain)).expect(200);
      type Card = { wawuId: string; badge: Badge };
      const data = dataOf<Card[] | { items: Card[] }>(res);
      const items = Array.isArray(data) ? data : data.items;
      const byId = new Map(items.map((i) => [i.wawuId, i.badge]));
      if (url.includes('explore/creators')) {
        expect(byId.get(CHIDI)).toMatchObject({ id: 'founding', number: 9 });
        expect(byId.get(ZAINAB)).toBeNull();
      }
      for (const i of items) expect(i).toHaveProperty('badge');
    }
  });

  it('the feed creator and professional cards carry the badge', async () => {
    await tier(CHIDI, 'founding', new Date(Date.now() + 100 * DAY), 11);
    await tier(proId, 'plus', new Date(Date.now() + 100 * DAY));
    const creators = await cards.creatorCards(PLAIN, [CHIDI, ZAINAB]);
    expect(creators.get(CHIDI)?.badge).toMatchObject({
      id: 'founding',
      number: 11,
    });
    expect(creators.get(ZAINAB)?.badge).toBeNull();
    const pros = await cards.professionalCards([listingId]);
    expect(pros.get(listingId)?.badge).toMatchObject({
      id: 'verified',
      name: 'Verify Plus',
      number: null,
    });
  });

  it('the professional directory and its detail carry the badge; the web routes answer the keys they did', async () => {
    const dir = async () =>
      dataOf<Array<{ wawuId: string; badge: Badge }>>(
        await http()
          .get('/api/hub/professionals/directory')
          .query({ perPage: 50 })
          .set(as(plain))
          .expect(200),
      );
    expect((await dir()).find((i) => i.wawuId === proId)?.badge).toBeNull();
    await tier(proId, 'founding', new Date(Date.now() + 100 * DAY), 3);
    const row = (await dir()).find((i) => i.wawuId === proId);
    expect(row?.badge).toMatchObject({ id: 'founding', number: 3 });
    const detail = await http()
      .get(`/api/hub/professionals/directory/${listingId}`)
      .set(as(plain))
      .expect(200);
    expect(dataOf<{ badge: Badge }>(detail).badge).toMatchObject({ number: 3 });
    // The web's two routes: no `badge` key, with or without a tier.
    const list = await http()
      .get('/api/hub/professionals')
      .query({ category: 'finance', perPage: 50 })
      .expect(200);
    const webRow = dataOf<Array<Record<string, unknown>>>(list).find(
      (r) => r.wawuId === proId,
    );
    expect(webRow).toBeDefined();
    expect(webRow).not.toHaveProperty('badge');
    const webDetail = await http()
      .get(`/api/hub/professionals/${listingId}`)
      .expect(200);
    expect(dataOf<object>(webDetail)).not.toHaveProperty('badge');
  });
});

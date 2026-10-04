import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece.module';
import { cardSlotAfter, candidateFor } from '../feed-entries.service';

/**
 * HOME-05: creator and professional cards among the feed, who made each
 * piece, and the frames, durations and page counts of media.
 *
 * Every identity, profile, piece and listing here is created by this spec
 * with random ids and removed in afterAll. The "best" creator and the "best"
 * professional are made unbeatable (60 followers, 40 reviews, from made-up
 * follower and author ids) so which card comes first does not depend on what
 * else is in the database.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

type Row = Record<string, unknown> & { id: string };
type Who = { sub: string; token: string };

let nonceCounter = 0;
async function registerIdentity(label: string): Promise<Who> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceCounter += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Cards Spec ${label}`,
      email: `cards-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

describe('Feed cards, creator info and media details (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMock = false;

  let fan: Who;
  let friend: Who;
  let top: Who; // the unbeatable creator
  let filler: Who; // a creator who only makes the feed long enough
  let proTop: Who; // the unbeatable professional
  let proSilent: Who; // approved, but paid messages are off
  let proBlocked: Who; // would outrank everyone, but the fan blocked them
  let stranger: Who; // not a creator

  const pieceIds: string[] = [];
  const fakeIds: string[] = [];
  let topVideo: string;
  let topPdf: string;
  let topSetPaid: string;
  let topSetFree: string;
  let listingTop: string;
  let listingSilent: string;
  let listingBlocked: string;

  const auth = (t: { token: string }) => ({
    Authorization: `Bearer ${t.token}`,
  });

  async function call(
    method: 'get' | 'put',
    url: string,
    who: Who | undefined,
    status = 200,
    body?: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; list: Row[]; text: string }> {
    let req = request(app.getHttpServer() as Server)[method](url);
    if (who) req = req.set(auth(who));
    if (body) req = req.send(body);
    const res = await req.expect(status);
    const parsed = res.body as { data?: unknown; message?: unknown };
    return {
      data: Array.isArray(parsed.data)
        ? {}
        : ((parsed.data ?? {}) as Record<string, unknown>),
      list: Array.isArray(parsed.data) ? (parsed.data as Row[]) : [],
      text: JSON.stringify(res.body),
    };
  }

  async function makePiece(
    creatorWawuId: string,
    data: Partial<{
      contentType: 'video' | 'pdf' | 'image';
      accessType: 'free' | 'paid';
      price: number;
      status: 'live' | 'pending';
      ratingPct: number;
      durationLabel: string;
      pageCount: number;
      createdAt: Date;
      title: string;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.contentPiece.create({
      data: {
        id,
        slug: `cards-spec-${id}`,
        creatorWawuId,
        contentType: data.contentType ?? 'video',
        title: data.title ?? 'Cards spec piece',
        description: 'Created by feed-cards.contract.spec.',
        category: 'business_entrepreneurship',
        accessType: data.accessType ?? 'free',
        price: data.price ?? 0,
        previewAssetUrl: 'https://example.com/preview.jpg',
        fullAssetUrl: 'https://example.com/full.jpg',
        status: data.status ?? 'live',
        ...(data.ratingPct !== undefined ? { ratingPct: data.ratingPct } : {}),
        ...(data.durationLabel ? { durationLabel: data.durationLabel } : {}),
        ...(data.pageCount ? { pageCount: data.pageCount } : {}),
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });
    pieceIds.push(id);
    return id;
  }

  async function makeCreator(
    who: Who,
    label: string,
    followers = 0,
  ): Promise<void> {
    await prisma.userProfile.create({
      data: {
        wawuUserId: who.sub,
        accountType: 'creator',
        handle: `cards_${label}_${who.sub.slice(0, 6)}`,
        headline: `${label} headline`,
      },
    });
    if (followers > 0) {
      const ids = Array.from({ length: followers }, () => randomUUID());
      fakeIds.push(...ids);
      await prisma.followRelationship.createMany({
        data: ids.map((f) => ({
          followerWawuId: f,
          followingWawuId: who.sub,
        })),
      });
    }
  }

  async function makeProfessional(
    who: Who,
    label: string,
    opts: { reviews: number; messageable: boolean },
  ): Promise<string> {
    if (
      !(await prisma.userProfile.findUnique({
        where: { wawuUserId: who.sub },
      }))
    ) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: who.sub,
          accountType: 'creator',
          handle: `cards_${label}_${who.sub.slice(0, 6)}`,
        },
      });
    }
    const listing = await prisma.professionalProfile.create({
      data: {
        wawuUserId: who.sub,
        category: 'legal_services',
        headline: `${label} accountant`,
        about: 'Created by feed-cards.contract.spec.',
        services: ['Tax filing', 'Bookkeeping'],
        credentialKind: 'qualification',
        status: 'approved',
        listed: true,
      },
    });
    await prisma.creatorState.upsert({
      where: { wawuUserId: who.sub },
      update: {},
      create: {
        wawuUserId: who.sub,
        dmEnabled: opts.messageable,
        dmPrice: opts.messageable ? 1500 : null,
        dmResponseHours: 24,
      },
    });
    if (opts.reviews > 0) {
      await prisma.professionalReview.createMany({
        data: Array.from({ length: opts.reviews }, (_, i) => ({
          professionalId: listing.id,
          authorWawuId: randomUUID(),
          stars: i % 2 === 0 ? 5 : 4,
        })),
      });
    }
    return listing.id;
  }

  /** The first creator or professional card of a For you page. */
  async function firstPage(
    who: Who,
    page = 1,
    perPage = 5,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await call(
      'get',
      `/feed/entries?scope=for_you&sort=recent&page=${page}&perPage=${perPage}`,
      who,
    );
    return res.list;
  }

  /** The wawuIds of the creator cards (not the creator line on a piece). */
  const creatorCardIds = (entries: Array<Record<string, unknown>>): string[] =>
    entries
      .filter((e) => e.kind === 'creator')
      .map((e) => (e.creator as { wawuId: string }).wawuId);

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    fan = await registerIdentity('fan');
    friend = await registerIdentity('friend');
    top = await registerIdentity('top');
    filler = await registerIdentity('filler');
    proTop = await registerIdentity('protop');
    proSilent = await registerIdentity('prosilent');
    proBlocked = await registerIdentity('problocked');
    stranger = await registerIdentity('stranger');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        ContentPieceModule,
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

    await makeCreator(top, 'top', 60);
    await makeCreator(filler, 'filler');
    const now = Date.now();
    topVideo = await makePiece(top.sub, {
      contentType: 'video',
      durationLabel: '4:12',
      ratingPct: 80,
      createdAt: new Date(now - 4000),
    });
    topPdf = await makePiece(top.sub, {
      contentType: 'pdf',
      accessType: 'paid',
      price: 1500,
      pageCount: 84,
      createdAt: new Date(now - 3000),
    });
    topSetPaid = await makePiece(top.sub, {
      contentType: 'image',
      accessType: 'paid',
      price: 2500,
      createdAt: new Date(now - 2000),
    });
    topSetFree = await makePiece(top.sub, {
      contentType: 'image',
      createdAt: new Date(now - 1000),
    });
    await makePiece(top.sub, { status: 'pending' });
    for (let i = 0; i < 30; i += 1) await makePiece(filler.sub);

    listingTop = await makeProfessional(proTop, 'protop', {
      reviews: 40,
      messageable: true,
    });
    listingSilent = await makeProfessional(proSilent, 'prosilent', {
      reviews: 90,
      messageable: false,
    });
    listingBlocked = await makeProfessional(proBlocked, 'problocked', {
      reviews: 200,
      messageable: true,
    });

    // friend follows top; fan follows friend, so friend is a person fan knows.
    await prisma.followRelationship.createMany({
      data: [
        { followerWawuId: friend.sub, followingWawuId: top.sub },
        { followerWawuId: fan.sub, followingWawuId: friend.sub },
      ],
    });
    await prisma.blockedAccount.create({
      data: { userWawuId: fan.sub, blockedWawuId: proBlocked.sub },
    });
  });

  afterAll(async () => {
    const people = [
      fan,
      friend,
      top,
      filler,
      proTop,
      proSilent,
      proBlocked,
      stranger,
    ].map((p) => p.sub);
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: people } },
    });
    await prisma.followRelationship.deleteMany({
      where: {
        OR: [
          { followerWawuId: { in: [...people, ...fakeIds] } },
          { followingWawuId: { in: people } },
        ],
      },
    });
    await prisma.purchase.deleteMany({
      where: { contentId: { in: pieceIds } },
    });
    await prisma.contentPiece.deleteMany({ where: { id: { in: pieceIds } } });
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await app?.close();
    if (ownedMock && mockWawuId) mockWawuId.kill();
  });

  describe('who made each piece', () => {
    it('a user sees the creator name, avatar slot and ticks on every feed card', async () => {
      const res = await call('get', '/feed?sort=recent&perPage=100', fan);
      const mine = res.list.find((i) => i.id === topVideo);
      expect(mine).toBeDefined();
      const creator = mine?.creator as Record<string, unknown>;
      expect(creator.wawuId).toBe(top.sub);
      expect(creator.displayName).toEqual(
        expect.stringContaining('Cards Spec'),
      );
      expect(creator).toHaveProperty('avatarUrl');
      expect(creator.verification).toEqual({
        creator: { verified: false, expiresAt: null },
        professional: { verified: false, expiresAt: null },
      });
      for (const item of res.list) {
        expect(item.creator).toBeDefined();
      }
    });

    it('a user sees a verified tick on a card whose creator holds one', async () => {
      await prisma.userProfile.update({
        where: { wawuUserId: top.sub },
        data: { creatorVerifiedAt: new Date(), creatorVerifiedUntil: null },
      });
      const res = await call('get', '/feed?sort=recent&perPage=100', fan);
      const creator = res.list.find((i) => i.id === topVideo)?.creator as {
        verification: { creator: { verified: boolean } };
      };
      expect(creator.verification.creator.verified).toBe(true);
      await prisma.userProfile.update({
        where: { wawuUserId: top.sub },
        data: { creatorVerifiedAt: null },
      });
    });
  });

  describe('creator and professional cards among the content', () => {
    it('a user finds a creator card after the fifth piece, as H9 shows it', async () => {
      const entries = await firstPage(fan);
      expect(entries.map((e) => e.kind)).toEqual([
        'content',
        'content',
        'content',
        'content',
        'content',
        'creator',
      ]);
      const card = entries[5].creator as Record<string, unknown>;
      expect(card.wawuId).toBe(top.sub);
      expect(card.displayName).toEqual(expect.stringContaining('Cards Spec'));
      expect(card.headline).toBe('top headline');
      expect(card.followers).toBe(61);
      expect(card.posts).toBe(4);
      expect(card.rating).toBe(4);
      expect(card.followsCreator).toBe(false);
    });

    it('a user sees the creator card strip: newest work first, with price, lock, duration and pages', async () => {
      const card = (await firstPage(fan))[5].creator as {
        works: Array<Record<string, unknown>>;
      };
      expect(card.works.map((w) => w.id)).toEqual([
        topSetFree,
        topSetPaid,
        topPdf,
        topVideo,
      ]);
      const byId = new Map(card.works.map((w) => [w.id, w]));
      expect(byId.get(topVideo)).toMatchObject({
        contentType: 'video',
        durationLabel: '4:12',
        locked: false,
        price: 0,
      });
      expect(byId.get(topPdf)).toMatchObject({
        contentType: 'pdf',
        pageCount: 84,
        locked: true,
        price: 1500,
      });
      expect(byId.get(topSetPaid)).toMatchObject({ locked: true, price: 2500 });
      expect(byId.get(topSetFree)).toMatchObject({ locked: false });
    });

    it('a user who bought a piece sees it unlocked in the creator card strip', async () => {
      await prisma.purchase.create({
        data: {
          contentId: topPdf,
          type: 'content',
          buyerWawuId: fan.sub,
          creatorWawuId: top.sub,
          amount: 1500,
          commissionRate: 0.15,
          flutterwaveTxRef: `cards-spec-${randomUUID()}`,
          status: 'completed',
        },
      });
      const card = (await firstPage(fan))[5].creator as {
        works: Array<Record<string, unknown>>;
      };
      expect(card.works.find((w) => w.id === topPdf)?.locked).toBe(false);
      expect(card.works.find((w) => w.id === topSetPaid)?.locked).toBe(true);
    });

    it('a user sees the people they know who follow the creator', async () => {
      const card = (await firstPage(fan))[5].creator as {
        knownFollowers: { count: number; people: Array<{ wawuId: string }> };
      };
      expect(card.knownFollowers.count).toBe(1);
      expect(card.knownFollowers.people.map((p) => p.wawuId)).toEqual([
        friend.sub,
      ]);
      const forStranger = (await firstPage(stranger))[5].creator as {
        knownFollowers: { count: number };
      };
      expect(forStranger.knownFollowers.count).toBe(0);
    });

    it('a user finds a professional card on the next page, as H10 shows it, with no trust score', async () => {
      const entries = await firstPage(fan, 2);
      expect(entries.map((e) => e.kind)).toEqual([
        'content',
        'content',
        'content',
        'content',
        'content',
        'professional',
      ]);
      const card = entries[5].professional as Record<string, unknown>;
      expect(card.id).toBe(listingTop);
      expect(card.wawuId).toBe(proTop.sub);
      expect(card.displayName).toEqual(expect.stringContaining('Cards Spec'));
      expect(card.headline).toBe('protop accountant');
      expect(card.services).toEqual(['Tax filing', 'Bookkeeping']);
      expect(card.ratingAvg).toBe(4.5);
      expect(card.reviewCount).toBe(40);
      expect(card.dmPrice).toBe(1500);
      expect(card.dmResponseHours).toBe(24);
      expect(JSON.stringify(card)).not.toMatch(/trust/i);
    });

    it('a user is never offered a professional who cannot be messaged, or one they blocked', async () => {
      for (const page of [2, 4, 6, 8]) {
        const text = JSON.stringify(await firstPage(fan, page));
        expect(text).not.toContain(listingSilent);
        expect(text).not.toContain(listingBlocked);
        expect(text).not.toContain(proSilent.sub);
        expect(text).not.toContain(proBlocked.sub);
      }
    });

    it('a user does not see the same card twice across pages', async () => {
      const seen = new Set<string>();
      for (let page = 1; page <= 8; page += 1) {
        const entries = await firstPage(fan, page, 5);
        for (const e of entries) {
          if (e.kind === 'creator') {
            const id = (e.creator as { wawuId: string }).wawuId;
            expect(seen.has(`c:${id}`)).toBe(false);
            seen.add(`c:${id}`);
          } else if (e.kind === 'professional') {
            const id = (e.professional as { id: string }).id;
            expect(seen.has(`p:${id}`)).toBe(false);
            seen.add(`p:${id}`);
          }
        }
      }
      expect(seen.size).toBeGreaterThan(0);
    });

    it('a user is not offered themselves, or anyone they follow, as a creator card', async () => {
      // fan follows friend and friend has no live piece, so friend never
      // qualifies; follow top and top disappears from the cards.
      await prisma.followRelationship.create({
        data: { followerWawuId: fan.sub, followingWawuId: top.sub },
      });
      for (let page = 1; page <= 4; page += 1) {
        expect(creatorCardIds(await firstPage(fan, page))).not.toContain(
          top.sub,
        );
      }
      // top sees the other creators, never themselves.
      for (let page = 1; page <= 4; page += 1) {
        expect(creatorCardIds(await firstPage(top, page))).not.toContain(
          top.sub,
        );
      }
      await prisma.followRelationship.delete({
        where: {
          followerWawuId_followingWawuId: {
            followerWawuId: fan.sub,
            followingWawuId: top.sub,
          },
        },
      });
    });

    it('a user never sees a card from someone who blocked them', async () => {
      await prisma.blockedAccount.create({
        data: { userWawuId: top.sub, blockedWawuId: stranger.sub },
      });
      expect(creatorCardIds(await firstPage(stranger, 1))).not.toContain(
        top.sub,
      );
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: top.sub },
      });
    });

    it('the Following tab carries no cards', async () => {
      const res = await call(
        'get',
        '/feed/entries?scope=following&perPage=100',
        fan,
      );
      expect(res.list.every((e) => e.kind === 'content')).toBe(true);
    });

    it('cards sit at fixed places: every fifth piece, creators and professionals alternating', () => {
      expect([0, 1, 2, 3, 4, 5, 9].map(cardSlotAfter)).toEqual([
        null,
        null,
        null,
        null,
        0,
        null,
        1,
      ]);
      expect([0, 1, 2, 3].map(candidateFor)).toEqual([
        { kind: 'creator', index: 0 },
        { kind: 'professional', index: 0 },
        { kind: 'creator', index: 1 },
        { kind: 'professional', index: 1 },
      ]);
    });
  });

  describe('photo sets, durations and page counts', () => {
    let frames: string[] = [];
    const ownKey = (who: Who) =>
      `content/preview/${who.sub}/${randomUUID()}.jpg`;
    const upload = async (who: Who, key: string, status = 'confirmed') =>
      prisma.storageObject.create({
        data: {
          wawuUserId: who.sub,
          key,
          bytes: 1000,
          contentType: 'image/jpeg',
          folder: 'content/preview',
          status: status as 'confirmed',
        },
      });

    beforeAll(async () => {
      frames = [ownKey(top), ownKey(top), ownKey(top)];
      for (const k of frames) await upload(top, k);
    });

    afterAll(async () => {
      await prisma.storageObject.deleteMany({
        where: { wawuUserId: { in: [top.sub, filler.sub] } },
      });
    });

    it('a creator can set a photo set and a user gets its frames in order', async () => {
      const put = await call('put', `/content/${topSetFree}/media`, top, 200, {
        frames,
      });
      expect(put.data.frameCount).toBe(3);

      const got = await call('get', `/content/${topSetFree}/media`, stranger);
      const out = got.data.frames as Array<Record<string, unknown>>;
      expect(out.map((f) => f.position)).toEqual([1, 2, 3]);
      expect(out.map((f) => f.url)).toEqual(frames);
      expect(out.every((f) => f.locked === false)).toBe(true);
    });

    it('a creator who sends the frames in a new order changes the order', async () => {
      const reversed = [...frames].reverse();
      await call('put', `/content/${topSetFree}/media`, top, 200, {
        frames: reversed,
      });
      const got = await call('get', `/content/${topSetFree}/media`, fan);
      expect(
        (got.data.frames as Array<{ url: string }>).map((f) => f.url),
      ).toEqual(reversed);
      expect(
        await prisma.contentFrame.count({ where: { contentId: topSetFree } }),
      ).toBe(3);
    });

    it('a user who has not bought a paid set sees how many frames it has and only the first', async () => {
      await call('put', `/content/${topSetPaid}/media`, top, 200, { frames });
      const got = await call('get', `/content/${topSetPaid}/media`, stranger);
      expect(got.data.frameCount).toBe(3);
      const out = got.data.frames as Array<{
        position: number;
        url: string | null;
        locked: boolean;
      }>;
      expect(out[0]).toEqual({
        position: 1,
        url: 'https://example.com/preview.jpg',
        locked: false,
      });
      expect(out[1]).toEqual({ position: 2, url: null, locked: true });
      expect(out[2]).toEqual({ position: 3, url: null, locked: true });
      expect(got.text).not.toContain(frames[1]);
      expect(got.text).not.toContain(frames[2]);
    });

    it('a user who bought the paid set, and its creator, get every frame', async () => {
      await prisma.purchase.create({
        data: {
          contentId: topSetPaid,
          type: 'content',
          buyerWawuId: friend.sub,
          creatorWawuId: top.sub,
          amount: 2500,
          commissionRate: 0.15,
          flutterwaveTxRef: `cards-spec-${randomUUID()}`,
          status: 'completed',
        },
      });
      for (const who of [friend, top]) {
        const got = await call('get', `/content/${topSetPaid}/media`, who);
        const out = got.data.frames as Array<{ url: string; locked: boolean }>;
        expect(out.map((f) => f.url)).toEqual(frames);
        expect(out.every((f) => !f.locked)).toBe(true);
      }
    });

    it('a user sees the frames, the duration and the page count on the feed card', async () => {
      const res = await call('get', '/feed?sort=recent&perPage=100', friend);
      const byId = new Map(res.list.map((i) => [i.id, i]));
      const set = byId.get(topSetFree)?.media as {
        frameCount: number;
        frames: Array<{ position: number }>;
      };
      expect(set.frameCount).toBe(3);
      expect(set.frames.map((f) => f.position)).toEqual([1, 2, 3]);
      expect(byId.get(topVideo)?.media).toMatchObject({
        durationLabel: '4:12',
        frameCount: 0,
        frames: [],
      });
      expect(byId.get(topPdf)?.media).toMatchObject({ pageCount: 84 });
    });

    it('a creator can state a video length and a PDF page count', async () => {
      const v = await call('put', `/content/${topVideo}/media`, top, 200, {
        durationLabel: '1:20:05',
      });
      expect(v.data.durationLabel).toBe('1:20:05');
      const p = await call('put', `/content/${topPdf}/media`, top, 200, {
        pageCount: 120,
      });
      expect(p.data.pageCount).toBe(120);
      const stored = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: topPdf },
        select: { pageCount: true },
      });
      expect(stored.pageCount).toBe(120);
    });

    it('a creator is refused a detail that does not fit the piece, and a length in a wrong format', async () => {
      await call('put', `/content/${topPdf}/media`, top, 400, { frames });
      await call('put', `/content/${topVideo}/media`, top, 400, {
        pageCount: 3,
      });
      await call('put', `/content/${topSetFree}/media`, top, 400, {
        durationLabel: '4:12',
      });
      await call('put', `/content/${topVideo}/media`, top, 400, {
        durationLabel: 'four minutes',
      });
      await call('put', `/content/${topVideo}/media`, top, 400, {
        durationLabel: '4:75',
      });
      await call('put', `/content/${topSetFree}/media`, top, 400, {});
      await call('put', `/content/${topSetFree}/media`, top, 400, {
        frames: Array.from(
          { length: 21 },
          (_, i) => `https://example.com/${i}.jpg`,
        ),
      });
    });

    it('a creator cannot use a frame that is not their own upload', async () => {
      const other = ownKey(filler);
      await upload(filler, other);
      const mine = ownKey(top);
      await upload(top, mine);
      const unknown = ownKey(top); // right shape, never uploaded
      const abandoned = ownKey(top);
      await upload(top, abandoned, 'abandoned');
      const bad = [
        'notaurl',
        'localhost',
        'ftp://cdn.example.com/a.jpg',
        'https://example.com/f1.jpg',
        other, // another creator's key
        `https://bucket.example.com/${other}?X-Amz-Signature=x`,
        `content/preview/${top.sub}/../${filler.sub}/x.jpg`,
        'content/preview/../full/x.jpg',
        `content/full/${filler.sub}/${randomUUID()}.mp4`,
        unknown,
        abandoned,
      ];
      for (const frame of bad) {
        await call('put', `/content/${topSetFree}/media`, top, 400, {
          frames: [mine, frame],
        });
      }
      // nothing was written by any refused call
      expect(
        (
          await prisma.contentFrame.findMany({
            where: { contentId: topSetFree },
          })
        ).map((f) => f.url),
      ).not.toContain(other);
    });

    it('a creator can use their own uploaded keys, and a signed url of their own upload', async () => {
      const a = ownKey(top);
      const b = ownKey(top);
      await upload(top, a);
      await upload(top, b, 'pending');
      const res = await call('put', `/content/${topSetFree}/media`, top, 200, {
        frames: [`https://bucket.example.com/${a}?X-Amz-Signature=x`, b],
      });
      expect(
        (res.data.frames as Array<{ url: string }>).map((f) => f.url),
      ).toEqual([a, b]);
      await call('put', `/content/${topSetFree}/media`, top, 200, { frames });
    });

    it('a user is never given a signed link to a frame the piece owner does not own', async () => {
      const other = ownKey(filler);
      await prisma.contentFrame.create({
        data: { contentId: topSetFree, position: 9, url: other },
      });
      const got = await call('get', `/content/${topSetFree}/media`, stranger);
      expect(got.text).not.toContain(other);
      expect(got.data.frameCount).toBe(3);
      await prisma.contentFrame.deleteMany({
        where: { contentId: topSetFree, position: 9 },
      });
    });

    it('nobody but the piece owner can change its media', async () => {
      await call('put', `/content/${topSetFree}/media`, filler, 403, {
        frames,
      });
      await call('put', `/content/${topSetFree}/media`, stranger, 403, {
        frames,
      });
      await call('put', `/content/${topSetFree}/media`, undefined, 401, {
        frames,
      });
      expect(
        await prisma.contentFrame.count({ where: { contentId: topSetFree } }),
      ).toBe(3);
    });

    it('a user cannot read the media of a piece they cannot see', async () => {
      const pending = await makePiece(top.sub, {
        contentType: 'image',
        status: 'pending',
      });
      await call('get', `/content/${pending}/media`, stranger, 404);
      await call('get', `/content/${pending}/media`, top, 200);
      await call('get', `/content/${randomUUID()}/media`, fan, 404);
    });
  });
});

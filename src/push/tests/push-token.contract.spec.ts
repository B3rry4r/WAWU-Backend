// INBOX-03: POST and DELETE /push-tokens, over real HTTP with real RS256
// tokens from mock-wawu-id, against the FULL AppModule (the only place a route
// can be shadowed, like route-shadowing.regression.spec.ts).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import type { Server } from 'http';
import {
  ConsoleLogger,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TestingLogger } from '@nestjs/testing/services/testing-logger.service';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PUSH_MAX_TOKENS_PER_USER } from '../push-config';
import { ExpoStandIn } from './expo-stand-in';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_PRO = '00000000-0000-4000-8000-000000000003';
const MOCK = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const RUN = Date.now().toString(36);
let seq = 0;
/** Every token this spec makes starts with this, and only those are ever deleted. */
const MINE = `ExponentPushToken[http-${RUN}-`;
const newToken = () => `${MINE}${(seq += 1)}]`;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Push token routes (contract, INBOX-03)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plain: string;
  let basic: string;
  let pro: string;
  const logged: string[] = [];
  const spies: jest.SpyInstance[] = [];
  const savedEnv = { ...process.env };

  const server = () => app.getHttpServer() as Server;
  // The app's real rate limit (20 a second, 200 a minute per caller) stays on:
  // `overrideGuard` does not reach an APP_GUARD provider, so the spec paces itself.
  const pace = async <T>(p: PromiseLike<T>): Promise<T> => {
    const out = await p;
    await new Promise((r) => setTimeout(r, 75));
    return out;
  };
  const post = (token: string | null, body: unknown) => {
    const r = request(server()).post('/api/hub/push-tokens');
    return pace(
      (token ? r.set('Authorization', `Bearer ${token}`) : r).send(
        body as object,
      ),
    );
  };
  const del = (token: string | null, body: unknown) => {
    const r = request(server()).delete('/api/hub/push-tokens');
    return pace(
      (token ? r.set('Authorization', `Bearer ${token}`) : r).send(
        body as object,
      ),
    );
  };
  /** The `data` of the wrapped response, typed so a missing key is a failed assertion. */
  const dataOf = (res: { body: unknown }): unknown =>
    (res.body as { data: unknown }).data;
  const rowsOf = (t: string) =>
    prisma.pushToken.findMany({ where: { expoPushToken: t } });

  beforeAll(async () => {
    plain = await login('user@test.wawu.dev');
    basic = await login('creator-basic@test.wawu.dev');
    pro = await login('creator-pro@test.wawu.dev');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
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
    await app.init();
    prisma = app.get(PrismaService);
    for (const stream of [process.stdout, process.stderr]) {
      spies.push(
        jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          logged.push(String(chunk));
          return true;
        }),
      );
    }
    // Every level is printed (Nest's testing logger prints errors only), so a
    // token in a log or warn line is caught by the log test below.
    Logger.overrideLogger(new ConsoleLogger());
  }, 90000);

  // Specs touch only rows they create (lead ruling, 7 Oct 2026, VB-3): the
  // tokens this run made, by their prefix, and nothing else.
  afterAll(async () => {
    Logger.overrideLogger(new TestingLogger());
    for (const spy of spies) spy.mockRestore();
    await prisma.pushToken.deleteMany({
      where: { expoPushToken: { startsWith: MINE } },
    });
    process.env = savedEnv;
    await app.close();
  });

  it('is mounted in the composed app and guarded: no token and a garbage token are 401, not 404', async () => {
    const t = newToken();
    expect(
      (await post(null, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(401);
    expect((await del(null, { expoPushToken: t })).status).toBe(401);
    expect(
      (await post('garbage', { expoPushToken: t, platform: 'android' })).status,
    ).toBe(401);
    expect(await rowsOf(t)).toHaveLength(0);
  });

  it('registers a phone for the caller and answers without the token', async () => {
    const t = newToken();
    const res = await post(plain, {
      expoPushToken: t,
      platform: 'android',
      deviceId: 'pixel-8',
      deviceLabel: 'Pixel 8',
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({ registered: true });
    expect(JSON.stringify(res.body)).not.toContain(t);
    const [row] = await rowsOf(t);
    expect(row).toMatchObject({
      userWawuId: USER_PLAIN,
      platform: 'android',
      deviceId: 'pixel-8',
      deviceLabel: 'Pixel 8',
      disabledAt: null,
    });
  });

  it('takes the owner from the token, never from the body', async () => {
    const t = newToken();
    const res = await post(plain, {
      expoPushToken: t,
      platform: 'ios',
      userWawuId: USER_BASIC,
    });
    expect(res.status).toBe(400);
    expect(await rowsOf(t)).toHaveLength(0);
  });

  it('is idempotent: registering the same phone again keeps one row and moves lastSeenAt', async () => {
    const t = newToken();
    expect(
      (await post(plain, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(200);
    const [first] = await rowsOf(t);
    await new Promise((r) => setTimeout(r, 15));
    expect(
      (
        await post(plain, {
          expoPushToken: t,
          platform: 'android',
          deviceLabel: 'Renamed',
        })
      ).status,
    ).toBe(200);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(
      first.lastSeenAt.getTime(),
    );
    expect(rows[0].deviceLabel).toBe('Renamed');
  });

  it.each([
    [
      'not an Expo token',
      { expoPushToken: 'fcm:APA91bH...', platform: 'android' },
    ],
    [
      'a bare string',
      { expoPushToken: 'ExponentPushToken', platform: 'android' },
    ],
    [
      'an empty bracket',
      { expoPushToken: 'ExponentPushToken[]', platform: 'android' },
    ],
    [
      'spaces inside',
      { expoPushToken: 'ExponentPushToken[a b]', platform: 'android' },
    ],
    [
      'trailing text',
      { expoPushToken: 'ExponentPushToken[abc]x', platform: 'android' },
    ],
    ['a number', { expoPushToken: 12345, platform: 'android' }],
    ['a missing token', { platform: 'android' }],
    [
      'an unknown platform',
      { expoPushToken: 'ExponentPushToken[abc]', platform: 'windows' },
    ],
    ['a missing platform', { expoPushToken: 'ExponentPushToken[abc]' }],
    [
      'an extra key',
      { expoPushToken: 'ExponentPushToken[abc]', platform: 'ios', x: 1 },
    ],
    [
      'a long device id',
      {
        expoPushToken: 'ExponentPushToken[abc]',
        platform: 'ios',
        deviceId: 'x'.repeat(201),
      },
    ],
    [
      'a long label',
      {
        expoPushToken: 'ExponentPushToken[abc]',
        platform: 'ios',
        deviceLabel: 'x'.repeat(101),
      },
    ],
    [
      'a token over 300 characters',
      {
        expoPushToken: `ExponentPushToken[${'a'.repeat(300)}]`,
        platform: 'ios',
      },
    ],
    // D1: Postgres refuses a NUL in text; it used to answer 500.
    [
      'a NUL inside the token',
      { expoPushToken: 'ExponentPushToken[ab\u0000c]', platform: 'ios' },
    ],
    [
      'a broken character inside the token',
      { expoPushToken: 'ExponentPushToken[ab\ud800c]', platform: 'ios' },
    ],
    [
      'a NUL in the device id',
      {
        expoPushToken: 'ExponentPushToken[abc]',
        platform: 'ios',
        deviceId: 'a\u0000b',
      },
    ],
    [
      'a NUL in the device label',
      {
        expoPushToken: 'ExponentPushToken[abc]',
        platform: 'ios',
        deviceLabel: 'Pixel\u00008',
      },
    ],
  ])('refuses %s with a 400 and stores nothing', async (_name, body) => {
    const res = await post(plain, body);
    expect(res.status).toBe(400);
    expect(
      await prisma.pushToken.count({
        where: {
          userWawuId: USER_PLAIN,
          expoPushToken: { not: { startsWith: 'ExponentPushToken[http-' } },
        },
      }),
    ).toBe(0);
  });

  it('accepts both token spellings Expo issues', async () => {
    const a = `ExpoPushToken[http-${RUN}-b1]`;
    expect(
      (await post(plain, { expoPushToken: a, platform: 'android' })).status,
    ).toBe(200);
    expect(await rowsOf(a)).toHaveLength(1);
  });

  it('when another person registers the same phone, it moves: one owner, and the first person is no longer its owner', async () => {
    const t = newToken();
    expect(
      (await post(plain, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(200);
    const [before] = await rowsOf(t);
    await new Promise((r) => setTimeout(r, 15));
    expect(
      (await post(basic, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(200);
    const rows = await rowsOf(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].userWawuId).toBe(USER_BASIC);
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(
      before.createdAt.getTime(),
    );
    // the first person removing it now removes nothing
    const gone = await del(plain, { expoPushToken: t });
    expect(gone.status).toBe(200);
    expect(dataOf(gone)).toEqual({ removed: false });
    expect(await rowsOf(t)).toHaveLength(1);
  });

  it("removes the caller's own token (sign-out) and removing it again, or one never registered, is a 200 with removed:false", async () => {
    const t = newToken();
    expect(
      (await post(plain, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(200);
    const one = await del(plain, { expoPushToken: t });
    expect(one.status).toBe(200);
    expect(dataOf(one)).toEqual({ removed: true });
    expect(await rowsOf(t)).toHaveLength(0);
    const again = await del(plain, { expoPushToken: t });
    expect(dataOf(again)).toEqual({ removed: false });
    const never = await del(plain, { expoPushToken: newToken() });
    expect(dataOf(never)).toEqual({ removed: false });
  });

  it('refuses a malformed removal with a 400', async () => {
    expect((await del(plain, { expoPushToken: 'nope' })).status).toBe(400);
    expect((await del(plain, {})).status).toBe(400);
    expect(
      (await del(plain, { expoPushToken: 'ExponentPushToken[a\u0000b]' }))
        .status,
    ).toBe(400);
  });

  it('stores nothing for an account whose deletion was asked for, and says so', async () => {
    // a mark this test makes and removes; skipped if one was there before it
    const had = await prisma.pushStoppedAccount.count({
      where: { userWawuId: USER_PRO },
    });
    if (had === 0) {
      await prisma.pushStoppedAccount.create({
        data: { userWawuId: USER_PRO },
      });
    }
    try {
      const t = newToken();
      const res = await post(pro, { expoPushToken: t, platform: 'android' });
      expect(res.status).toBe(200);
      expect(dataOf(res)).toEqual({ registered: false });
      expect(await rowsOf(t)).toHaveLength(0);
    } finally {
      if (had === 0) {
        await prisma.pushStoppedAccount.delete({
          where: { userWawuId: USER_PRO },
        });
      }
    }
  });

  it('keeps a person to the cap, pushing out the phone seen longest ago', async () => {
    // only this run's tokens are cleared; the seed gives nobody a phone
    await prisma.pushToken.deleteMany({
      where: { userWawuId: USER_BASIC, expoPushToken: { startsWith: MINE } },
    });
    const made: string[] = [];
    for (let i = 0; i < PUSH_MAX_TOKENS_PER_USER + 1; i += 1) {
      const t = newToken();
      made.push(t);
      expect(
        (await post(basic, { expoPushToken: t, platform: 'android' })).status,
      ).toBe(200);
      await new Promise((r) => setTimeout(r, 3));
    }
    const left = (
      await prisma.pushToken.findMany({ where: { userWawuId: USER_BASIC } })
    ).map((r) => r.expoPushToken);
    expect(left).toHaveLength(PUSH_MAX_TOKENS_PER_USER);
    expect(left).not.toContain(made[0]);
    expect(left).toContain(made[made.length - 1]);
  });

  it('a token is never in a log line, whether the request was accepted, refused or removed', async () => {
    const t = newToken();
    const bad = `ExponentPushToken[bad token ${RUN}]`;
    await post(plain, { expoPushToken: t, platform: 'android' });
    await post(plain, { expoPushToken: bad, platform: 'android' });
    await post(null, { expoPushToken: t, platform: 'android' });
    await del(plain, { expoPushToken: t });
    const all = logged.join('\n');
    expect(all).not.toContain(t);
    expect(all).not.toContain(`bad token ${RUN}`);
    expect(all).not.toContain(`http-${RUN}`);
  });

  // The follow is basic -> pro, which the seed does not have (it has plain ->
  // basic and plain -> pro), so the spec creates the edge and the notification
  // and deletes exactly those two rows, by id (VB-3: it used to delete the
  // seeded plain -> basic edge).
  it('the REST request that writes a notification is unaffected by a broken push: Expo refusing connections and push on', async () => {
    const edge = {
      followerWawuId: USER_BASIC,
      followingWawuId: USER_PRO,
    };
    expect(await prisma.followRelationship.count({ where: edge })).toBe(0);
    const closed = new ExpoStandIn();
    await closed.start();
    process.env.PUSH_ENABLED = 'true';
    process.env.EXPO_PUSH_BASE_URL = closed.baseUrl;
    await closed.stop();
    const t = newToken();
    expect(
      (await post(pro, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(200);
    const before = new Set(
      (
        await prisma.notification.findMany({
          where: { userWawuId: USER_PRO, kind: 'new_follower' },
          select: { id: true },
        })
      ).map((n) => n.id),
    );
    try {
      const res = await pace(
        request(server())
          .post(`/api/hub/creators/${USER_PRO}/follow`)
          .set('Authorization', `Bearer ${basic}`)
          .send(),
      );
      expect([200, 201]).toContain(res.status);
    } finally {
      const made = (
        await prisma.notification.findMany({
          where: { userWawuId: USER_PRO, kind: 'new_follower' },
          select: { id: true },
        })
      ).filter((n) => !before.has(n.id));
      expect(made).toHaveLength(1);
      await prisma.notification.deleteMany({
        where: { id: { in: made.map((n) => n.id) } },
      });
      await prisma.followRelationship.deleteMany({ where: edge });
      delete process.env.PUSH_ENABLED;
      delete process.env.EXPO_PUSH_BASE_URL;
    }
  });
});

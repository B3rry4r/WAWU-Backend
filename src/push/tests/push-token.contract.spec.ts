// INBOX-03: POST and DELETE /push-tokens, over real HTTP with real RS256
// tokens from mock-wawu-id, against the FULL AppModule (the only place a route
// can be shadowed, like route-shadowing.regression.spec.ts).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import type { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
const USERS = [USER_PLAIN, USER_BASIC];
const MOCK = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const RUN = Date.now().toString(36);
let seq = 0;
const newToken = () => `ExponentPushToken[http-${RUN}-${(seq += 1)}]`;

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
    await prisma.pushToken.deleteMany({ where: { userWawuId: { in: USERS } } });
    for (const stream of [process.stdout, process.stderr]) {
      spies.push(
        jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          logged.push(String(chunk));
          return true;
        }),
      );
    }
  }, 90000);

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await prisma.pushToken.deleteMany({ where: { userWawuId: { in: USERS } } });
    await prisma.notification.deleteMany({
      where: {
        userWawuId: { in: USERS },
        id: {
          notIn: [
            'a0000000-0000-4000-8000-000000000001',
            'a0000000-0000-4000-8000-000000000002',
          ],
        },
        kind: 'new_follower',
        title: 'New follower',
      },
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
  });

  it('keeps a person to the cap, pushing out the phone seen longest ago', async () => {
    await prisma.pushToken.deleteMany({ where: { userWawuId: USER_BASIC } });
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

  it('the REST request that writes a notification is unaffected by a broken push: Expo refusing connections and push on', async () => {
    const closed = new ExpoStandIn();
    await closed.start();
    process.env.PUSH_ENABLED = 'true';
    process.env.EXPO_PUSH_BASE_URL = closed.baseUrl;
    await closed.stop();
    const t = newToken();
    expect(
      (await post(basic, { expoPushToken: t, platform: 'android' })).status,
    ).toBe(200);
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_BASIC },
    });
    const before = await prisma.notification.count({
      where: { userWawuId: USER_BASIC, kind: 'new_follower' },
    });
    const res = await pace(
      request(server())
        .post(`/api/hub/creators/${USER_BASIC}/follow`)
        .set('Authorization', `Bearer ${plain}`)
        .send(),
    );
    expect([200, 201]).toContain(res.status);
    expect(
      await prisma.notification.count({
        where: { userWawuId: USER_BASIC, kind: 'new_follower' },
      }),
    ).toBe(before + 1);
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_BASIC },
    });
    delete process.env.PUSH_ENABLED;
    delete process.env.EXPO_PUSH_BASE_URL;
  });
});

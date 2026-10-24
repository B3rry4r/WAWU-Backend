// SIGNUP-NAMES (R-82): is a username free, and saving the name and username a person gives at sign-up.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { StorageService } from '../../storage/storage.service';
import { UserProfileModule } from '../user-profile.module';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

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

/** A brand-new person, as WAWU ID makes one: a token for a sub the Hub has never seen. */
async function newPerson(tag: string): Promise<{ token: string; sub: string }> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Auth Six ${tag}`,
      email: `auth06-${tag}-${unique}@test.wawu.dev`,
      phone: `+23480${unique.slice(-8)}`,
      country: 'Nigeria',
      password: 'a-test-password-1',
    }),
  });
  if (res.status !== 201)
    throw new Error(`mock register failed: ${res.status}`);
  const token = ((await res.json()) as { accessToken: string }).accessToken;
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as { sub: string };
  const sub = claims.sub;
  return { token, sub };
}

type Reply = { body: unknown };
/** The Hub's envelope: `{ statusCode, message, data }`; these read the two parts a check needs. */
const dataOf = <T = Record<string, unknown>>(res: Reply): T =>
  (res.body as { data: T }).data;
const messageOf = (res: Reply): string =>
  (res.body as { message: string }).message;

describe('Username and name at sign-up (SIGNUP-NAMES, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let renamed: jest.SpyInstance;
  const made: string[] = [];
  const handles: string[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const stamp = `${Date.now()}`.slice(-7);
  const free = (tag: string) => `sgn_${tag}_${stamp}`;
  const person = async (tag: string) => {
    const p = await newPerson(tag);
    made.push(p.sub);
    return p;
  };

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not come up');
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
      ],
    })
      .overrideProvider(StorageService)
      .useValue({ freshUrlFor: (s: string | null) => Promise.resolve(s) })
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
    // The mock WAWU ID has no name route: the Hub's call to WAWU ID's `PATCH /internal/users/:id/name` is recorded here.
    // The real route is walked on the stack (README, "Local test stack").
    renamed = jest
      .spyOn(app.get(WawuIdClient), 'updateName')
      .mockResolvedValue(undefined);
  }, 60_000);

  afterAll(async () => {
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: made } },
    });
    await app.close();
    mock?.kill();
  });

  const available = (handle: string | undefined, signedIn?: string) =>
    http()
      .get('/api/hub/users/handle-available')
      .query(handle === undefined ? {} : { handle })
      .set(signedIn ? bearer(signedIn) : {});

  it("a signed-out person can ask whether a username is free, and is told in the server's words", async () => {
    const name = free('free');
    const out = await available(name).expect(200);
    expect(dataOf(out)).toEqual({
      handle: name,
      available: true,
      message: null,
    });
    expect(
      dataOf<{ handle: string }>(await available(`@${name}`).expect(200))
        .handle,
    ).toBe(name);
  });

  it('a name that is not well formed or is held back says why, and is never available', async () => {
    const say = async (typed: string | undefined) =>
      dataOf<{ available: boolean; message: string }>(
        await available(typed).expect(200),
      );
    expect(await say('')).toMatchObject({
      available: false,
      message: 'Choose a username.',
    });
    expect(await say(undefined)).toMatchObject({
      available: false,
      message: 'Choose a username.',
    });
    expect(await say('ada lovelace')).toMatchObject({
      available: false,
      message: 'Use letters, numbers, dots and underscores.',
    });
    expect(await say('ada-l')).toMatchObject({ available: false });
    expect(await say('a'.repeat(31))).toMatchObject({
      available: false,
      message: 'A username can be at most 30 characters.',
    });
    expect(await say('a'.repeat(30))).toMatchObject({ available: true });
    expect(await say('Admin')).toMatchObject({
      available: false,
      message: 'That username is not available. Try another.',
    });
  });

  it('a username another account holds is taken, whatever its case', async () => {
    const owner = await person('holder');
    const name = free('Held');
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(owner.token))
      .send({ handle: name })
      .expect(200);
    handles.push(name);
    for (const typed of [
      name,
      name.toLowerCase(),
      name.toUpperCase(),
      `@${name}`,
    ]) {
      const out = await available(typed).expect(200);
      expect(dataOf(out)).toMatchObject({
        available: false,
        message: 'That username is taken. Try another.',
      });
    }
  });

  it('saving takes the username and the name, and a first name needs a last name', async () => {
    const p = await person('save');
    const name = free('save');
    const out = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ firstName: ' Ada ', lastName: 'Obi', handle: `@${name}` })
      .expect(200);
    expect(dataOf(out)).toMatchObject({
      firstName: 'Ada',
      lastName: 'Obi',
      handle: name,
    });
    expect(renamed).toHaveBeenCalledWith(p.sub, {
      firstName: 'Ada',
      lastName: 'Obi',
    });
    const me = await http()
      .get('/api/hub/users/me')
      .set(bearer(p.token))
      .expect(200);
    expect(dataOf(me).handle).toBe(name);
    expect(dataOf(me).accountType).toBe('user');

    const lone = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ firstName: 'Ada' })
      .expect(400);
    expect(messageOf(lone)).toBe('Enter your first name and your last name.');
    const blank = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ firstName: '  ', lastName: 'Obi' })
      .expect(400);
    expect(messageOf(blank)).toBe('Enter your first name and your last name.');
    const nothing = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({})
      .expect(400);
    expect(messageOf(nothing)).toBe('Send a name or a username to save.');
  });

  it("a taken username is refused with the server's words, ignoring case, and nothing else is saved", async () => {
    const a = await person('first');
    const b = await person('second');
    const name = free('Race');
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(a.token))
      .send({ handle: name })
      .expect(200);
    renamed.mockClear();
    const out = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(b.token))
      .send({ firstName: 'Bola', lastName: 'Ade', handle: name.toLowerCase() })
      .expect(409);
    expect(messageOf(out)).toBe('That username is taken. Try another.');
    expect(renamed).not.toHaveBeenCalled();
    expect(
      await prisma.userProfile.findUnique({ where: { wawuUserId: b.sub } }),
    ).toBeNull();
  });

  it('two people asking for the same name at once: one gets it, the other is told it is taken', async () => {
    const a = await person('twin-a');
    const b = await person('twin-b');
    const name = free('Twin');
    const [x, y] = await Promise.all([
      http()
        .put('/api/hub/users/me/identity')
        .set(bearer(a.token))
        .send({ handle: name }),
      http()
        .put('/api/hub/users/me/identity')
        .set(bearer(b.token))
        .send({ handle: name.toUpperCase() }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const held = await prisma.userProfile.findMany({
      where: { handle: { equals: name, mode: 'insensitive' } },
    });
    expect(held).toHaveLength(1);
  });

  it('the same person asking again is fine, and a person who has a username is sent to Edit profile to change it', async () => {
    const p = await person('again');
    const name = free('again');
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: name })
      .expect(200);
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: name })
      .expect(200);
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: name.toUpperCase() })
      .expect(200);
    const other = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: free('other') })
      .expect(409);
    expect(messageOf(other)).toBe(
      'You already have a username. Change it in Edit profile.',
    );
  });

  it('names only: the profile is left alone, and a name that WAWU ID refuses fails the call', async () => {
    const p = await person('names');
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ firstName: 'Ife', lastName: 'Eze' })
      .expect(200);
    expect(
      await prisma.userProfile.findUnique({ where: { wawuUserId: p.sub } }),
    ).toBeNull();
    renamed.mockRejectedValueOnce(new Error('WAWU ID is down'));
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ firstName: 'Ife', lastName: 'Eze' })
      .expect(500);
  });

  it('the route needs a signed-in person, and an unknown field is refused', async () => {
    await http()
      .put('/api/hub/users/me/identity')
      .send({ handle: free('anon') })
      .expect(401);
    const p = await person('extra');
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: free('x'), accountType: 'creator' })
      .expect(400);
  });
});

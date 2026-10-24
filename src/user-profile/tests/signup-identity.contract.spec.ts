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

  // ---- Round 3 (verifier M1): an underscore in a typed name is a character, not a wildcard ----

  it('M1: an underscore is only an underscore, so a name that differs from a held one by a character is free and claimable', async () => {
    const holder = await person('under-a');
    const base = `sgu${stamp}`;
    const held = `${base}_wXild`;
    const lookalike = `${base}_wXil_`;
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(holder.token))
      .send({ handle: held })
      .expect(200);
    // The held name is taken, in any case ...
    for (const typed of [held, held.toUpperCase(), held.toLowerCase()]) {
      expect(dataOf(await available(typed).expect(200))).toMatchObject({
        available: false,
      });
    }
    // ... and the name that only an underscore-as-wildcard would match is free.
    expect(dataOf(await available(lookalike).expect(200))).toEqual({
      handle: lookalike,
      available: true,
      message: null,
    });
    const other = await person('under-b');
    const claimed = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(other.token))
      .send({ handle: lookalike })
      .expect(200);
    expect(dataOf(claimed)).toMatchObject({ handle: lookalike });
    // Both are held now, and each is still taken for a third person, in any case.
    for (const typed of [held, lookalike, lookalike.toUpperCase()]) {
      expect(dataOf(await available(typed).expect(200))).toMatchObject({
        available: false,
        message: 'That username is taken. Try another.',
      });
    }
    // The other direction: the name with the underscore is not "held" by a name with a letter there.
    const holds = `${base}_pQrs`;
    const probe = `${base}_pQr_`;
    const third = await person('under-c');
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(third.token))
      .send({ handle: probe })
      .expect(200);
    expect(dataOf(await available(holds).expect(200))).toMatchObject({
      available: true,
    });
  });

  it('M1: Ada and ada still collide, on the check and on the claim', async () => {
    const a = await person('case-a');
    const b = await person('case-b');
    const name = `Ada${stamp}`;
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(a.token))
      .send({ handle: name })
      .expect(200);
    expect(
      dataOf(await available(name.toLowerCase()).expect(200)),
    ).toMatchObject({ available: false });
    const refused = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(b.token))
      .send({ handle: name.toLowerCase() })
      .expect(409);
    expect(messageOf(refused)).toBe('That username is taken. Try another.');
  });

  // ---- Round 3 (verifier M2, lead ruling): Edit profile changes the username on the new rules ----

  const changeTo = (token: string, handle: unknown) =>
    http().put('/api/hub/users/me/handle').set(bearer(token)).send({ handle });
  const hold = async (tag: string, name: string) => {
    const p = await person(tag);
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: name })
      .expect(200);
    return p;
  };

  it('M2: the app path refuses pat1 while Pat1 is held, in the server words, and keeps what the person had', async () => {
    const holder = await hold('chg-holder', `Pat${stamp}`);
    const mine = await hold('chg-mine', free('chgmine'));
    expect(holder.sub).not.toBe(mine.sub);
    const out = await changeTo(mine.token, `pat${stamp}`).expect(409);
    expect(messageOf(out)).toBe('That username is taken. Try another.');
    const me = await http()
      .get('/api/hub/users/me')
      .set(bearer(mine.token))
      .expect(200);
    expect(dataOf(me).handle).toBe(free('chgmine'));
  });

  it('M2: the app path refuses a reserved word, a name with nothing to read, and a bad shape', async () => {
    const mine = await hold('chg-bad', free('chgbad'));
    for (const word of ['wawu', 'Admin', 'ME', '@Support', 'www']) {
      const out = await changeTo(mine.token, word).expect(400);
      expect(messageOf(out)).toBe(
        'That username is not available. Try another.',
      );
    }
    for (const typed of ['.', '..', '_', '@.']) {
      const out = await changeTo(mine.token, typed).expect(400);
      expect(messageOf(out)).toBe(
        'A username needs at least one letter or number.',
      );
    }
    expect(messageOf(await changeTo(mine.token, 'a b').expect(400))).toBe(
      'Use letters, numbers, dots and underscores.',
    );
    expect(messageOf(await changeTo(mine.token, '').expect(400))).toBe(
      'Choose a username.',
    );
    expect(
      messageOf(await changeTo(mine.token, 'a'.repeat(31)).expect(400)),
    ).toBe('A username can be at most 30 characters.');
    const me = await http()
      .get('/api/hub/users/me')
      .set(bearer(mine.token))
      .expect(200);
    expect(dataOf(me).handle).toBe(free('chgbad'));
  });

  it('M2: the app path changes the username, frees the old one, and takes the same name in another case', async () => {
    const first = free('chgold');
    const mine = await hold('chg-ok', first);
    const next = free('chgnew');
    const out = await changeTo(mine.token, `@${next}`).expect(200);
    expect(dataOf(out)).toEqual({ handle: next });
    const me = await http()
      .get('/api/hub/users/me')
      .set(bearer(mine.token))
      .expect(200);
    expect(dataOf(me).handle).toBe(next);
    expect(dataOf(await available(first).expect(200))).toMatchObject({
      available: true,
    });
    expect(dataOf(await available(next).expect(200))).toMatchObject({
      available: false,
    });
    // Again with the same name is fine, and so is a change of case on the person's own name.
    await changeTo(mine.token, next).expect(200);
    expect(
      dataOf(await changeTo(mine.token, next.toUpperCase()).expect(200)),
    ).toEqual({ handle: next.toUpperCase() });
  });

  it('M2: two people changing to one name at once: one gets it, the other is told it is taken', async () => {
    const a = await hold('chg-twin-a', free('twina'));
    const b = await hold('chg-twin-b', free('twinb'));
    const name = free('Twinchg');
    const [x, y] = await Promise.all([
      changeTo(a.token, name),
      changeTo(b.token, name.toUpperCase()),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const held = await prisma.$queryRaw<
      { wawuUserId: string }[]
    >`SELECT "wawuUserId" FROM "UserProfile" WHERE lower("handle") = lower(${name})`;
    expect(held).toHaveLength(1);
  });

  it('M2: the route needs a signed-in person and takes a username only', async () => {
    await http()
      .put('/api/hub/users/me/handle')
      .send({ handle: free('anon2') })
      .expect(401);
    const p = await person('chg-extra');
    await http()
      .put('/api/hub/users/me/handle')
      .set(bearer(p.token))
      .send({ handle: free('x2'), accountType: 'creator' })
      .expect(400);
    await http()
      .put('/api/hub/users/me/handle')
      .set(bearer(p.token))
      .send({})
      .expect(400);
  });

  // ---- Round 3 (verifier lows) ----

  it('lows: the words kept back include the company names and the plain site pages, in any case', async () => {
    const words = [
      'me',
      'root',
      'login',
      'logout',
      'signup',
      'settings',
      'admin',
      'support',
      'help',
      'wawu',
      'wawuafrica',
      'whomadethis',
      'api',
      'www',
    ];
    for (const word of words) {
      for (const typed of [word, word.toUpperCase(), `@${word}`]) {
        expect(dataOf(await available(typed).expect(200))).toMatchObject({
          available: false,
          message: 'That username is not available. Try another.',
        });
      }
    }
    // A word that only contains one of them is fine.
    expect(dataOf(await available(`me${stamp}`).expect(200))).toMatchObject({
      available: true,
    });
    const p = await person('reserved');
    const out = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: 'WhoMadeThis' })
      .expect(400);
    expect(messageOf(out)).toBe('That username is not available. Try another.');
  });

  it('lows: a username needs a letter or a number, so ".", ".." and "_" are refused and "a." and "_1" are fine', async () => {
    for (const typed of ['.', '..', '_', '___', '._.']) {
      expect(dataOf(await available(typed).expect(200))).toMatchObject({
        available: false,
        message: 'A username needs at least one letter or number.',
      });
    }
    const p = await person('dots');
    const out = await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ handle: '..' })
      .expect(400);
    expect(messageOf(out)).toBe(
      'A username needs at least one letter or number.',
    );
    for (const ok of [`${stamp}.`, `_${stamp}`, `.a${stamp}`]) {
      expect(dataOf(await available(ok).expect(200))).toMatchObject({
        available: true,
      });
    }
  });

  it('lows: a name with a control character is a 400 in plain words, never a 502, and nothing is saved', async () => {
    const p = await person('control');
    renamed.mockClear();
    for (const bad of [
      'Ada\u0000',
      'A\u0000da',
      'Ada\u0007',
      'Ada\nObi',
      'Ada\tObi',
      'Ada\u007f',
    ]) {
      const first = await http()
        .put('/api/hub/users/me/identity')
        .set(bearer(p.token))
        .send({ firstName: bad, lastName: 'Obi', handle: free('ctl') })
        .expect(400);
      expect(messageOf(first)).toBe(
        'Your name has a character that cannot be saved. Remove it and try again.',
      );
      const last = await http()
        .put('/api/hub/users/me/identity')
        .set(bearer(p.token))
        .send({ firstName: 'Ada', lastName: bad })
        .expect(400);
      expect(messageOf(last)).toBe(
        'Your name has a character that cannot be saved. Remove it and try again.',
      );
    }
    expect(renamed).not.toHaveBeenCalled();
    // The username in the refused calls was not claimed either.
    expect(
      await prisma.userProfile.findUnique({ where: { wawuUserId: p.sub } }),
    ).toBeNull();
    // A name with an accent, an apostrophe or a hyphen is still a name.
    await http()
      .put('/api/hub/users/me/identity')
      .set(bearer(p.token))
      .send({ firstName: 'Chidi-Nkem', lastName: "O'Brien Okafor" })
      .expect(200);
    expect(renamed).toHaveBeenCalledWith(p.sub, {
      firstName: 'Chidi-Nkem',
      lastName: "O'Brien Okafor",
    });
  });
});

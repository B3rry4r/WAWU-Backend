// TIER-OFFER round 2 (F1): the first writes to a new person's profile race, and none of them may lose.
//
// Right after the email code the app makes several first writes for one new person at about the same moment: the account type
// (`PUT /users/me/account-type`), the username claim (`PUT /users/me/identity`), the interests, and the profile read/patch. Each is
// "create the profile row, or update it". Two of them can both find no row and both insert; the loser got a Prisma P2002. For the
// account type that left a new creator stored as a fan (`user`), so `GET /me/tier-offer` answered `show: false` and the tiers were
// never offered (8 of 14 fresh creator sign-ups in the verifier's walk). The account type now retries on P2002 and reads the row the
// winner made.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Prisma } from '../../../generated/prisma/client';
import { AccountType } from '../../../generated/prisma/enums';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPLORE_CATEGORY_IDS } from '../../explore/explore-categories';
import { ExploreModule } from '../../explore/explore.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { StorageService } from '../../storage/storage.service';
import { SignupProfileService } from '../signup-profile.service';
import { MIN_SIGNUP_INTERESTS } from '../signup-interests';
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

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`wawuUserId`)',
    { code: 'P2002', clientVersion: 'test' },
  );
}

type Row = { accountType: AccountType };

/** A profile table that behaves as the database does for one row, with the loser's P2002 scripted by the test. */
function fakePrisma(script: {
  /** What each upsert does, in order: throw P2002, or answer with the row it wrote. The last entry repeats. */
  upserts: ('p2002' | 'ok')[];
  /** The row another writer has already made when the loser looks again; null = none yet. */
  winnerRow: Row | null;
}) {
  let stored: Row | null = null;
  let upsertCalls = 0;
  const userProfile = {
    upsert: jest.fn((args: { create: Row }) => {
      const step =
        script.upserts[Math.min(upsertCalls, script.upserts.length - 1)];
      upsertCalls += 1;
      if (step === 'p2002') {
        // The winner's insert landed between this writer's look and its insert.
        stored = script.winnerRow ?? stored;
        return Promise.reject(p2002());
      }
      stored = stored ?? { accountType: args.create.accountType };
      return Promise.resolve({ accountType: stored.accountType });
    }),
    findUnique: jest.fn(() => Promise.resolve(stored)),
    updateMany: jest.fn((args: { data: Row }) => {
      if (stored && stored.accountType === AccountType.user)
        stored = { accountType: args.data.accountType };
      return Promise.resolve({ count: 1 });
    }),
  };
  return {
    prisma: { userProfile } as unknown as PrismaService,
    userProfile,
    stored: () => stored,
    upsertCalls: () => upsertCalls,
  };
}

describe('SignupProfileService.setAccountType loses no race (unit)', () => {
  it('a creator whose upsert lost to a fan row ends as a creator', async () => {
    const f = fakePrisma({
      upserts: ['p2002'],
      winnerRow: { accountType: AccountType.user },
    });
    const out = await new SignupProfileService(f.prisma).setAccountType(
      'w1',
      'creator',
    );
    expect(out).toEqual({ accountType: AccountType.creator });
    expect(f.stored()).toEqual({ accountType: AccountType.creator });
  });

  it('a fan whose upsert lost to a creator row stays a creator and is told so', async () => {
    const f = fakePrisma({
      upserts: ['p2002'],
      winnerRow: { accountType: AccountType.creator },
    });
    const out = await new SignupProfileService(f.prisma).setAccountType(
      'w2',
      'user',
    );
    expect(out).toEqual({ accountType: AccountType.creator });
  });

  it('a lost upsert whose winner row is not there yet tries the upsert again', async () => {
    const f = fakePrisma({ upserts: ['p2002', 'ok'], winnerRow: null });
    const out = await new SignupProfileService(f.prisma).setAccountType(
      'w3',
      'creator',
    );
    expect(out).toEqual({ accountType: AccountType.creator });
    expect(f.upsertCalls()).toBe(2);
  });

  it('keeps trying a bounded number of times, then fails loudly instead of looping', async () => {
    const f = fakePrisma({ upserts: ['p2002'], winnerRow: null });
    await expect(
      new SignupProfileService(f.prisma).setAccountType('w4', 'creator'),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(f.upsertCalls()).toBeGreaterThanOrEqual(2);
    expect(f.upsertCalls()).toBeLessThanOrEqual(5);
  });

  it('any other error is not retried', async () => {
    const f = fakePrisma({ upserts: ['ok'], winnerRow: null });
    f.userProfile.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      new SignupProfileService(f.prisma).setAccountType('w5', 'creator'),
    ).rejects.toThrow('connection lost');
    expect(f.upsertCalls()).toBe(0);
    expect(f.userProfile.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('Concurrent first writes for one new person (TIER-OFFER F1, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  const made: string[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function newPerson(
    tag: string,
  ): Promise<{ token: string; sub: string }> {
    const unique = `${Date.now()}${Math.floor(Math.random() * 1e8)}`;
    const res = await fetch(`${MOCK_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: `Tof Race ${tag}`,
        email: `tof2-${tag}-${unique}@test.wawu.dev`,
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
    return { token, sub: claims.sub };
  }

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
        ExploreModule,
        FollowRelationshipModule,
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
  }, 60_000);

  afterAll(async () => {
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: made } },
    });
    await app.close();
    mock?.kill();
  });

  it('every first write of a brand-new creator succeeds, and the profile ends as a creator, in every one of 60 sign-ups', async () => {
    const people = await Promise.all(
      Array.from({ length: 60 }, (_, i) => newPerson(`c${i}`)),
    );
    for (const p of people) made.push(p.sub);
    const picks = EXPLORE_CATEGORY_IDS.slice(0, MIN_SIGNUP_INTERESTS);
    const failures: string[] = [];
    // Inside each sign-up every first write is sent at the same moment, and five sign-ups run side by side: enough for the writes to
    // interleave, few enough that the connection pool is never the thing that fails (all sixty at once starved it).
    const signUp = async (p: { token: string; sub: string }, i: number) => {
      const handle = `tof2race${Date.now().toString(36)}${i}`;
      const calls: [string, request.Test][] = [
        [
          'account-type',
          http()
            .put('/api/hub/users/me/account-type')
            .set(bearer(p.token))
            .send({ accountType: 'creator' }),
        ],
        [
          'identity',
          http()
            .put('/api/hub/users/me/identity')
            .set(bearer(p.token))
            .send({ handle }),
        ],
        [
          'interests',
          http()
            .put('/api/hub/users/me/interests')
            .set(bearer(p.token))
            .send({ interests: picks }),
        ],
        [
          'patch-me',
          http()
            .patch('/api/hub/users/me')
            .set(bearer(p.token))
            .send({ bio: 'Hello' }),
        ],
        [
          'patch-me-empty',
          http().patch('/api/hub/users/me').set(bearer(p.token)).send({}),
        ],
        ['get-me', http().get('/api/hub/users/me').set(bearer(p.token))],
      ];
      const results = await Promise.all(
        calls.map(async ([name, req]) => {
          const res = await req;
          return { name, status: res.status, body: res.body as unknown };
        }),
      );
      for (const r of results) {
        if (r.status >= 400)
          failures.push(
            `${p.sub} ${r.name} ${r.status} ${JSON.stringify(r.body)}`,
          );
      }
    };
    for (let from = 0; from < people.length; from += 5) {
      await Promise.all(
        people.slice(from, from + 5).map((p, j) => signUp(p, from + j)),
      );
    }
    expect(failures).toEqual([]);
    const rows = await prisma.userProfile.findMany({
      where: { wawuUserId: { in: people.map((p) => p.sub) } },
      select: { wawuUserId: true, accountType: true },
    });
    expect(rows).toHaveLength(60);
    expect(rows.filter((r) => r.accountType !== AccountType.creator)).toEqual(
      [],
    );
  }, 120_000);
});

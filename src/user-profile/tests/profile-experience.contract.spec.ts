import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { UserProfileModule } from '../user-profile.module';
import { MAX_EXPERIENCE_ROWS } from '../dto/profile-experience.dto';

/**
 * The experience list on a profile, and the company line beside it.
 *
 * What this suite is here to prove:
 *  - a role written by one account CANNOT be edited or deleted by another,
 *    and the attempt is indistinguishable from the row not existing;
 *  - the month on the wire is the month that comes back, in every timezone
 *    the server might run in;
 *  - the current role sorts above a finished one that started later;
 *  - a role cannot end before it begins, including when only one end of the
 *    range is being PATCHed;
 *  - the cap is enforced against the database, not against a count the
 *    client sent.
 *
 * Fixtures: the seeded accounts, with every row this suite creates swept in
 * `beforeEach` and `afterAll`, and the seeded `company` column snapshotted
 * and written back (README § Test hygiene).
 */

const MOCK_WAWU_ID_BASE =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const OWNER_EMAIL = 'creator-pro@test.wawu.dev';
const OWNER_SUB = '00000000-0000-4000-8000-000000000003';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER_SUB = '00000000-0000-4000-8000-000000000002';
const ALL_SUBS = [OWNER_SUB, OTHER_SUB];

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Profile experience (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let otherToken: string;

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const companySnapshot = new Map<string, string | null>();

  async function sweep(): Promise<void> {
    await prisma.profileExperience.deleteMany({
      where: { wawuUserId: { in: ALL_SUBS } },
    });
  }

  /** Creates a role for `token` and returns its id. */
  async function add(
    token: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await http()
      .post('/users/me/experience')
      .set(auth(token))
      .send(body)
      .expect(201);
    return (res.body as { data: { id: string } }).data.id;
  }

  beforeAll(async () => {
    [ownerToken, otherToken] = await Promise.all([
      login(OWNER_EMAIL),
      login(OTHER_EMAIL),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
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

    for (const sub of ALL_SUBS) {
      const row = await prisma.userProfile.findUnique({
        where: { wawuUserId: sub },
        select: { company: true },
      });
      if (row) companySnapshot.set(sub, row.company);
    }
  }, 30000);

  beforeEach(async () => {
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    for (const [sub, company] of companySnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: sub },
        data: { company },
      });
    }
    await app.close();
  });

  /* ---------------------------- the happy path --------------------------- */

  it('creates a role and returns it in the month format it was sent in', async () => {
    const res = await http()
      .post('/users/me/experience')
      .set(auth(ownerToken))
      .send({
        title: 'Chief Steward',
        company: 'WAWU Africa',
        location: 'Lagos, Nigeria',
        startedOn: '2023-03',
        description: 'Building a creator economy for Africa.',
      })
      .expect(201);

    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      title: 'Chief Steward',
      company: 'WAWU Africa',
      location: 'Lagos, Nigeria',
      startedOn: '2023-03',
      endedOn: null,
      // Derived from endedOn being null, never stored.
      current: true,
    });
  });

  /**
   * THE TIMEZONE TRAP, as a test.
   *
   * `new Date("2023-03-01")` is UTC but `new Date(2023, 2, 1)` is local, and
   * a server west of Greenwich turns the second into the 28th of February.
   * A month written in and read back unchanged is the only assertion that
   * catches a regression to the local-time constructor, because every other
   * behaviour here looks identical until it crosses a month boundary.
   */
  it('round-trips a January month without slipping into the previous December', async () => {
    const id = await add(ownerToken, {
      title: 'Analyst',
      company: 'First Bank',
      startedOn: '2021-01',
      endedOn: '2022-01',
    });

    const row = await prisma.profileExperience.findUniqueOrThrow({
      where: { id },
    });
    // Asserted against the stored column, not only the response: a matching
    // pair of broken conversions would cancel out on a round trip.
    expect(row.startedOn.toISOString().slice(0, 10)).toBe('2021-01-01');
    expect(row.endedOn?.toISOString().slice(0, 10)).toBe('2022-01-01');

    const res = await http().get('/users/me').set(auth(ownerToken)).expect(200);
    const list = (res.body as { data: { experience: { startedOn: string }[] } })
      .data.experience;
    expect(list[0].startedOn).toBe('2021-01');
  });

  it('puts the role held now above a finished role that started later', async () => {
    // The finished one starts LATER, so a single sort on startedOn would put
    // it first. The current role still belongs at the top.
    await add(ownerToken, {
      title: 'Current role',
      company: 'WAWU Africa',
      startedOn: '2019-01',
    });
    await add(ownerToken, {
      title: 'Older finished role',
      company: 'Elsewhere',
      startedOn: '2022-06',
      endedOn: '2023-06',
    });

    const res = await http().get('/users/me').set(auth(ownerToken)).expect(200);
    const list = (res.body as { data: { experience: { title: string }[] } })
      .data.experience;
    expect(list.map((r) => r.title)).toEqual([
      'Current role',
      'Older finished role',
    ]);
  });

  /* ------------------------------ ownership ------------------------------ */

  it("will not let one account edit another account's role", async () => {
    const id = await add(ownerToken, {
      title: 'Chief Steward',
      company: 'WAWU Africa',
      startedOn: '2023-03',
    });

    // 404, not 403: a stranger learns nothing about whether the id exists.
    await http()
      .patch(`/users/me/experience/${id}`)
      .set(auth(otherToken))
      .send({ title: 'Hijacked' })
      .expect(404);

    const row = await prisma.profileExperience.findUniqueOrThrow({
      where: { id },
    });
    expect(row.title).toBe('Chief Steward');
  });

  it("will not let one account delete another account's role", async () => {
    const id = await add(ownerToken, {
      title: 'Chief Steward',
      company: 'WAWU Africa',
      startedOn: '2023-03',
    });

    await http()
      .delete(`/users/me/experience/${id}`)
      .set(auth(otherToken))
      .expect(404);

    expect(await prisma.profileExperience.count({ where: { id } })).toBe(1);
  });

  it('refuses every experience route without a token', async () => {
    await http().post('/users/me/experience').send({}).expect(401);
    await http().patch('/users/me/experience/whatever').send({}).expect(401);
    await http().delete('/users/me/experience/whatever').expect(401);
  });

  /* ------------------------------ validation ----------------------------- */

  it('rejects a role that ends before it begins', async () => {
    await http()
      .post('/users/me/experience')
      .set(auth(ownerToken))
      .send({
        title: 'Backwards',
        company: 'Nowhere',
        startedOn: '2023-06',
        endedOn: '2022-01',
      })
      .expect(400);
  });

  /**
   * The case a DTO-only check misses: the PATCH carries just an end date, so
   * there is nothing in the body to compare it against. The comparison has to
   * be made against the start date already in the row.
   */
  it('rejects a PATCH whose end date lands before the stored start date', async () => {
    const id = await add(ownerToken, {
      title: 'Chief Steward',
      company: 'WAWU Africa',
      startedOn: '2023-03',
    });

    await http()
      .patch(`/users/me/experience/${id}`)
      .set(auth(ownerToken))
      .send({ endedOn: '2020-01' })
      .expect(400);

    const row = await prisma.profileExperience.findUniqueOrThrow({
      where: { id },
    });
    expect(row.endedOn).toBeNull();
  });

  it('rejects a month that is not YYYY-MM', async () => {
    for (const startedOn of [
      '2023-3',
      '2023-13',
      '2023',
      'March 2023',
      '2023-03-15',
    ]) {
      await http()
        .post('/users/me/experience')
        .set(auth(ownerToken))
        .send({ title: 'T', company: 'C', startedOn })
        .expect(400);
    }
  });

  it('clears an end date back to null, which is how a role becomes current again', async () => {
    const id = await add(ownerToken, {
      title: 'Chief Steward',
      company: 'WAWU Africa',
      startedOn: '2023-03',
      endedOn: '2024-03',
    });

    const res = await http()
      .patch(`/users/me/experience/${id}`)
      .set(auth(ownerToken))
      .send({ endedOn: null })
      .expect(200);

    expect((res.body as { data: Record<string, unknown> }).data).toMatchObject({
      endedOn: null,
      current: true,
    });
  });

  /* -------------------------------- the cap ------------------------------ */

  it('enforces the row cap against the database', async () => {
    for (let i = 0; i < MAX_EXPERIENCE_ROWS; i += 1) {
      await add(ownerToken, {
        title: `Role ${i}`,
        company: 'Somewhere',
        startedOn: '2020-01',
      });
    }

    await http()
      .post('/users/me/experience')
      .set(auth(ownerToken))
      .send({
        title: 'One too many',
        company: 'Somewhere',
        startedOn: '2020-01',
      })
      .expect(400);

    expect(
      await prisma.profileExperience.count({
        where: { wawuUserId: OWNER_SUB },
      }),
    ).toBe(MAX_EXPERIENCE_ROWS);
  });

  /* ------------------------- company, and the public read ---------------- */

  it('saves the company line and serves it on the public profile', async () => {
    await http()
      .patch('/users/me')
      .set(auth(ownerToken))
      .send({ company: 'WAWU Africa' })
      .expect(200);

    const res = await http()
      .get(`/users/${OWNER_SUB}/public-profile`)
      .set(auth(otherToken))
      .expect(200);

    expect((res.body as { data: { company: string } }).data.company).toBe(
      'WAWU Africa',
    );
  });

  it('serves the experience list to a visitor, not only to the owner', async () => {
    await add(ownerToken, {
      title: 'Chief Steward',
      company: 'WAWU Africa',
      startedOn: '2023-03',
    });

    const res = await http()
      .get(`/users/${OWNER_SUB}/public-profile`)
      .set(auth(otherToken))
      .expect(200);

    const list = (res.body as { data: { experience: { title: string }[] } })
      .data.experience;
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Chief Steward');
  });

  it('deletes a role, and the profile stops carrying it', async () => {
    const id = await add(ownerToken, {
      title: 'Chief Steward',
      company: 'WAWU Africa',
      startedOn: '2023-03',
    });

    await http()
      .delete(`/users/me/experience/${id}`)
      .set(auth(ownerToken))
      .expect(200);

    const res = await http().get('/users/me').set(auth(ownerToken)).expect(200);
    expect(
      (res.body as { data: { experience: unknown[] } }).data.experience,
    ).toHaveLength(0);
  });
});

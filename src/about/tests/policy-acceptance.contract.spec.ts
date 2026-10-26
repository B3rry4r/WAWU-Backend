import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ACCOUNT_DATA_MAP } from '../../account-purge/account-data-map';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { AboutModule } from '../about.module';

/**
 * LEGAL-DOCS: what a person agreed to at sign-up, kept by the Hub. The app writes it once after sign-up
 * (POST /policies/accept); each published document's slug and effective date go in, with the time. A second call
 * (a retry) adds nothing; a document the owner republished with a new date adds one more row for that document.
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** The `data` of the Hub's envelope, typed by the test that reads it. */
const dataOf = <T = unknown>(res: { body: unknown }): T =>
  (res.body as { data: T }).data;

const SLUGS = [
  'privacy',
  'terms',
  'cookies',
  'creator-monetization',
  'verification-refund',
  'acceptable-use',
  'partner-dpa',
  'community-guidelines',
  'disclaimer',
];

describe('LEGAL-DOCS: the record of what a person agreed to at sign-up', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenA: string;
  let tokenB: string;
  const post = (token: string | null, body: unknown) => {
    const r = request(app.getHttpServer()).post('/api/hub/policies/accept');
    return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(
      body as object,
    );
  };
  const publish = (slugs: string[], date = '2026-10-26') =>
    prisma.legalDocument.createMany({
      data: slugs.map((slug) => ({
        slug,
        title: `Title of ${slug}`,
        effectiveDate: new Date(`${date}T00:00:00.000Z`),
        sections: [{ heading: '1. ONE', body: 'Text.' }],
      })),
    });
  const rowsOf = (user: string) =>
    prisma.legalAcceptance.findMany({
      where: { userWawuId: user },
      orderBy: [{ slug: 'asc' }, { effectiveDate: 'asc' }],
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        AboutModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    tokenA = await loginAs('user@test.wawu.dev');
    tokenB = await loginAs('creator-basic@test.wawu.dev');
  });

  beforeEach(async () => {
    await prisma.legalAcceptance.deleteMany({
      where: { userWawuId: { in: [USER_A, USER_B] } },
    });
    await prisma.legalDocument.deleteMany({});
  });

  afterAll(async () => {
    await prisma.legalAcceptance.deleteMany({
      where: { userWawuId: { in: [USER_A, USER_B] } },
    });
    await prisma.legalDocument.deleteMany({});
    await app.close();
  });

  it('a signed-out caller cannot write a record', async () => {
    await publish(SLUGS);
    await post(null, { how: 'signup' }).expect(401);
    expect(await prisma.legalAcceptance.count()).toBe(0);
  });

  it('a new person can agree to all nine, and the Hub keeps each slug with its effective date and the time', async () => {
    await publish(SLUGS);
    const res = await post(tokenA, { how: 'signup' });
    expect([200, 201]).toContain(res.status);
    expect(
      dataOf<{ items: { slug: string }[] }>(res)
        .items.map((i) => i.slug)
        .sort(),
    ).toEqual([...SLUGS].sort());
    const first = dataOf<{ items: Record<string, string>[] }>(res).items[0];
    expect(Object.keys(first).sort()).toEqual([
      'acceptedAt',
      'effectiveDate',
      'slug',
    ]);
    expect(first.effectiveDate).toBe('2026-10-26');
    expect(Number.isNaN(Date.parse(first.acceptedAt))).toBe(false);
    const rows = await rowsOf(USER_A);
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.how).toBe('signup');
      expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-10-26');
      expect(Math.abs(Date.now() - row.acceptedAt.getTime())).toBeLessThan(
        60_000,
      );
    }
  });

  it('a retry adds nothing and keeps the first time', async () => {
    await publish(SLUGS);
    await post(tokenA, { how: 'signup' });
    const first = await rowsOf(USER_A);
    await post(tokenA, { how: 'signup' });
    await Promise.all([
      post(tokenA, { how: 'signup' }),
      post(tokenA, { how: 'signup' }),
    ]);
    const again = await rowsOf(USER_A);
    expect(again).toHaveLength(9);
    expect(again.map((r) => r.acceptedAt.getTime())).toEqual(
      first.map((r) => r.acceptedAt.getTime()),
    );
  });

  it('a document the owner republished with a new date adds a row for that document, and the old row stays', async () => {
    await publish(SLUGS);
    await post(tokenA, { how: 'signup' });
    await prisma.legalDocument.update({
      where: { slug: 'terms' },
      data: { effectiveDate: new Date('2026-12-01T00:00:00.000Z') },
    });
    await post(tokenA, { how: 'signup' });
    const rows = await rowsOf(USER_A);
    expect(rows).toHaveLength(10);
    expect(
      rows
        .filter((r) => r.slug === 'terms')
        .map((r) => r.effectiveDate.toISOString().slice(0, 10)),
    ).toEqual(['2026-10-26', '2026-12-01']);
  });

  it('only published documents are kept: nothing for a document the owner has not filled in', async () => {
    await publish(['privacy', 'terms']);
    await prisma.legalDocument.create({
      data: {
        slug: 'cookies',
        title: 'Empty',
        effectiveDate: new Date('2026-10-26T00:00:00.000Z'),
        sections: [],
      },
    });
    const res = await post(tokenA, { how: 'signup' });
    expect(
      dataOf<{ items: { slug: string }[] }>(res).items.map((i) => i.slug),
    ).toEqual(['privacy', 'terms']);
    expect(await rowsOf(USER_A)).toHaveLength(2);
  });

  it('with nothing published there is nothing to keep, and the answer says so', async () => {
    const res = await post(tokenA, { how: 'signup' });
    expect([200, 201]).toContain(res.status);
    expect(dataOf(res)).toEqual({ items: [] });
  });

  it("one person's record is theirs alone", async () => {
    await publish(['privacy']);
    await post(tokenA, { how: 'signup' });
    expect(await rowsOf(USER_A)).toHaveLength(1);
    expect(await rowsOf(USER_B)).toHaveLength(0);
    await post(tokenB, { how: 'signup' });
    expect(await rowsOf(USER_B)).toHaveLength(1);
  });

  it('refuses a body that does not say how the person agreed', async () => {
    await publish(SLUGS);
    await post(tokenA, {}).expect(400);
    await post(tokenA, { how: 'somewhere' }).expect(400);
    await post(tokenA, { how: 'signup', slugs: ['terms'] }).expect(400);
    expect(await rowsOf(USER_A)).toHaveLength(0);
  });

  it('is part of the account purge and the data export, so a person can see and delete it', async () => {
    expect(
      ACCOUNT_DATA_MAP.find(
        (r) => r.model === 'LegalAcceptance' && r.column === 'userWawuId',
      )?.disposition,
    ).toBe('OWNED');
    await publish(['terms']);
    await post(tokenA, { how: 'signup' });
    const section = EXPORT_SECTIONS.find((s) =>
      s.models.includes('LegalAcceptance'),
    )!;
    const exported = (await section.load(prisma, USER_A)) as {
      acceptances: {
        slug: string;
        effectiveDate: unknown;
        acceptedAt: unknown;
        how: string;
      }[];
    };
    expect(exported.acceptances).toHaveLength(1);
    expect(exported.acceptances[0]).toMatchObject({
      slug: 'terms',
      how: 'signup',
    });
  });
});

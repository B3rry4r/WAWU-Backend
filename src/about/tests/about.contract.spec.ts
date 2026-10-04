import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminLegalDocumentsModule } from '../../admin/legal-documents/admin-legal-documents.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AboutModule } from '../about.module';

/**
 * SETTINGS-02: About, Terms and Privacy policy. Proves that nothing is served
 * until the owner fills it in (never invented text), that what the owner puts
 * in comes back to anyone, signed in or not, with its date, that only a
 * superadmin can write it, and that About reads the bank and licence from
 * config.
 */
const SUPER_ID = 'ad020000-0000-4000-8000-000000000001';
const REVIEWER_ID = 'ad020000-0000-4000-8000-000000000002';
const SUPER_EMAIL = 's02-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 's02-reviewer@admin.test.wawu.dev';
const PASSWORD = 'about-contract-password';
const KEYS = [
  'ADMIN_JWT_SECRET',
  'ADMIN_JWT_REFRESH_SECRET',
  'WALLET_BANK_NAME',
  'WALLET_LICENCE_LINE',
  'SUPPORT_EMAIL',
];

const DOC = {
  title: 'Terms',
  effectiveDate: '2026-09-01',
  sections: [
    { heading: 'One', body: 'First paragraph.\n\nSecond paragraph.' },
    { heading: 'Two', body: 'Text two.' },
  ],
};

describe('About and policies contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superToken: string;
  let reviewerToken: string;
  const snapshot: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());

  async function login(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function build(): Promise<void> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AboutModule,
        AdminLegalDocumentsModule,
      ],
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
    await app.init();
    prisma = app.get(PrismaService);
  }

  beforeAll(async () => {
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'about-access-secret-0123456789abcdef0123';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'about-refresh-secret-0123456789abcdef012';
    delete process.env.WALLET_BANK_NAME;
    delete process.env.WALLET_LICENCE_LINE;
    delete process.env.SUPPORT_EMAIL;
    await build();
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({
      where: { email: { in: [SUPER_EMAIL, REVIEWER_EMAIL] } },
    });
    await prisma.adminUser.createMany({
      data: [
        {
          id: SUPER_ID,
          email: SUPER_EMAIL,
          passwordHash,
          name: 'S02 Super',
          role: 'superadmin',
        },
        {
          id: REVIEWER_ID,
          email: REVIEWER_EMAIL,
          passwordHash,
          name: 'S02 Reviewer',
          role: 'reviewer',
        },
      ],
    });
    superToken = await login(SUPER_EMAIL);
    reviewerToken = await login(REVIEWER_EMAIL);
    await prisma.legalDocument.deleteMany({});
  }, 60_000);

  afterAll(async () => {
    await prisma.legalDocument.deleteMany({});
    await prisma.adminUser.deleteMany({
      where: { id: { in: [SUPER_ID, REVIEWER_ID] } },
    });
    await app.close();
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('serves nothing for a policy the owner has not filled in', async () => {
    for (const slug of ['terms', 'privacy']) {
      const res = await http().get(`/api/hub/policies/${slug}`).expect(200);
      expect(res.body.data).toEqual({
        slug,
        available: false,
        title: null,
        effectiveDate: null,
        sections: [],
      });
    }
  });

  it('refuses a slug that is not a policy', async () => {
    await http().get('/api/hub/policies/cookies').expect(404);
  });

  it('About has no licence line and no support address until the owner fills them in', async () => {
    const res = await http().get('/api/hub/about').expect(200);
    expect(res.body.data.licenceLine).toBeNull();
    expect(res.body.data.supportEmail).toBeNull();
    expect(res.body.data.bankName).toBe('Loma Bank');
  });

  it('only a superadmin can write a policy, and nothing is written without one', async () => {
    await http().put('/api/hub/admin/policies/terms').send(DOC).expect(401);
    await http()
      .put('/api/hub/admin/policies/terms')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send(DOC)
      .expect(403);
    const res = await http().get('/api/hub/policies/terms').expect(200);
    expect(res.body.data.available).toBe(false);
  });

  it('rejects a malformed document', async () => {
    const put = (body: object) =>
      http()
        .put('/api/hub/admin/policies/terms')
        .set('Authorization', `Bearer ${superToken}`)
        .send(body);
    await put({ ...DOC, effectiveDate: '1 September 2026' }).expect(400);
    await put({ ...DOC, sections: [] }).expect(400);
    await put({ ...DOC, sections: [{ heading: 'x' }] }).expect(400);
    await http()
      .put('/api/hub/admin/policies/cookies')
      .set('Authorization', `Bearer ${superToken}`)
      .send(DOC)
      .expect(404);
  });

  it('what the owner puts in comes back to anyone, with its date, and a rewrite replaces it', async () => {
    const put = await http()
      .put('/api/hub/admin/policies/terms')
      .set('Authorization', `Bearer ${superToken}`)
      .send(DOC)
      .expect(200);
    expect(put.body.data.available).toBe(true);
    const res = await http().get('/api/hub/policies/terms').expect(200);
    expect(res.body.data).toEqual({ slug: 'terms', available: true, ...DOC });
    const other = await http().get('/api/hub/policies/privacy').expect(200);
    expect(other.body.data.available).toBe(false);

    await http()
      .put('/api/hub/admin/policies/terms')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        ...DOC,
        effectiveDate: '2026-10-01',
        sections: [{ heading: 'Only', body: 'x' }],
      })
      .expect(200);
    const again = await http().get('/api/hub/policies/terms').expect(200);
    expect(again.body.data.effectiveDate).toBe('2026-10-01');
    expect(again.body.data.sections).toEqual([{ heading: 'Only', body: 'x' }]);
  });

  it('About reads the bank, the licence line and the support address from config', async () => {
    process.env.WALLET_BANK_NAME = 'Test Bank';
    process.env.WALLET_LICENCE_LINE = 'Licensed line from config';
    process.env.SUPPORT_EMAIL = 'help@example.test';
    await app.close();
    await build();
    const res = await http().get('/api/hub/about').expect(200);
    expect(res.body.data).toEqual({
      bankName: 'Test Bank',
      licenceLine: 'Licensed line from config',
      supportEmail: 'help@example.test',
    });
  });

  describe('round 2: strict input', () => {
    const put = (body: object | string) =>
      http()
        .put('/api/hub/admin/policies/terms')
        .set('Authorization', `Bearer ${superToken}`)
        .set('Content-Type', 'application/json')
        .send(body);

    it.each([
      '2026-13-45',
      '0000-00-00',
      '2026-02-30',
      '2027-02-29',
      '2026-00-10',
      '1999-12-31',
      '2101-01-01',
    ])(
      'a superadmin cannot save a document dated %s (400, nothing stored)',
      async (date) => {
        const res = await put({ ...DOC, effectiveDate: date }).expect(400);
        expect(res.body.data).toBeNull();
        const got = await http().get('/api/hub/policies/terms').expect(200);
        expect(got.body.data.effectiveDate).not.toBe(date);
      },
    );

    it('a superadmin can save a real date, including 29 February of a leap year, and it reads back unchanged', async () => {
      for (const date of ['2028-02-29', '2000-01-01', '2100-12-31']) {
        await put({ ...DOC, effectiveDate: date }).expect(200);
        const got = await http().get('/api/hub/policies/terms').expect(200);
        expect(got.body.data.effectiveDate).toBe(date);
      }
    });

    it('a superadmin cannot save text with a NUL character (400, not 500)', async () => {
      await put({ ...DOC, title: 'Te\u0000rms' }).expect(400);
      await put({
        ...DOC,
        sections: [{ heading: 'One', body: 'bad \u0000 text' }],
      }).expect(400);
    });

    it('a superadmin cannot save a title, heading or body that is empty after trimming', async () => {
      await put({ ...DOC, title: '   ' }).expect(400);
      await put({ ...DOC, sections: [{ heading: ' \n ', body: 'x' }] }).expect(
        400,
      );
      await put({
        ...DOC,
        sections: [{ heading: 'x', body: '\n\t  ' }],
      }).expect(400);
    });

    it('a superadmin cannot save more than 60000 bytes of text (400), and a body over the parser limit is 413 in the usual shape', async () => {
      const chunk = 'a'.repeat(20000);
      const big = {
        ...DOC,
        sections: [0, 1, 2, 3].map((i) => ({ heading: `H${i}`, body: chunk })),
      };
      const tooLong = await put(big).expect(400);
      expect(tooLong.body.message).toMatch(/too long/);
      const raw = await put(
        JSON.stringify({ ...DOC, junk: 'x'.repeat(150_000) }),
      ).expect(413);
      expect(raw.body).toEqual({
        statusCode: 413,
        message: 'The request is too large.',
        data: null,
      });
    });

    it('a document just under the limit is accepted', async () => {
      const body = 'b'.repeat(19900);
      await put({
        ...DOC,
        sections: [0, 1, 2].map((i) => ({ heading: `H${i}`, body })),
      }).expect(200);
    });
  });
});

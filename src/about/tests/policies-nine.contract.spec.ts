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
 * LEGAL-DOCS: the owner's nine legal documents. The slug list grows from
 * terms and privacy to nine; GET /policies/:slug keeps its exact shape (the
 * web calls it), and GET /policies lists the published documents in the
 * owner's order, public like the single one.
 */
const SUPER_ID = 'ad020000-0000-4000-8000-0000000000a1';
const SUPER_EMAIL = 'lgd-super@admin.test.wawu.dev';
const PASSWORD = 'legal-docs-contract-password';
const KEYS = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];

/** The owner's order (26 Oct 2026, documents 1 to 9). */
const OWNER_ORDER = [
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

/** The `data` of the Hub's envelope, typed by the test that reads it. */
const dataOf = <T = unknown>(res: { body: unknown }): T =>
  (res.body as { data: T }).data;

const doc = (title: string, date = '2026-10-26') => ({
  title,
  effectiveDate: date,
  sections: [{ heading: '1. ONE', body: 'First.\n\nSecond.' }],
});

describe('LEGAL-DOCS: the nine documents and their list', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superToken: string;
  const snapshot: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const put = (slug: string, body: object) =>
    http()
      .put(`/api/hub/admin/policies/${slug}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send(body);

  beforeAll(async () => {
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'lgd-access-secret-0123456789abcdef0123456';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'lgd-refresh-secret-0123456789abcdef01234';
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
    const argon2 = await import('argon2');
    await prisma.adminUser.deleteMany({ where: { email: SUPER_EMAIL } });
    await prisma.adminUser.create({
      data: {
        id: SUPER_ID,
        email: SUPER_EMAIL,
        passwordHash: await argon2.hash(PASSWORD),
        name: 'LGD Super',
        role: 'superadmin',
      },
    });
    const login = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: SUPER_EMAIL, password: PASSWORD })
      .expect(200);
    superToken = dataOf<{ accessToken: string }>(login).accessToken;
  }, 60_000);

  beforeEach(async () => {
    await prisma.legalDocument.deleteMany({});
  });

  afterAll(async () => {
    await prisma.legalDocument.deleteMany({});
    await prisma.adminUser.deleteMany({ where: { id: SUPER_ID } });
    await app.close();
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('a person can read each of the nine slugs, and an unfilled one says "not available" with no text', async () => {
    for (const slug of OWNER_ORDER) {
      const res = await http().get(`/api/hub/policies/${slug}`).expect(200);
      expect(dataOf(res)).toEqual({
        slug,
        available: false,
        title: null,
        effectiveDate: null,
        sections: [],
      });
    }
  });

  it('a person cannot read a slug outside the nine', async () => {
    await http().get('/api/hub/policies/imprint').expect(404);
    await http().get('/api/hub/policies/Privacy').expect(404);
  });

  it('a superadmin can save any of the nine, and not a tenth', async () => {
    for (const slug of OWNER_ORDER) {
      await put(slug, doc(`Title of ${slug}`)).expect(200);
    }
    const one = await http().get('/api/hub/policies/partner-dpa').expect(200);
    expect(dataOf(one)).toEqual({
      slug: 'partner-dpa',
      available: true,
      ...doc('Title of partner-dpa'),
    });
    await put('imprint', doc('x')).expect(404);
  });

  it('a signed-out person gets an empty list while nothing is published', async () => {
    const res = await http().get('/api/hub/policies').expect(200);
    expect(dataOf(res)).toEqual({ items: [] });
  });

  it('a signed-out person gets the published documents in the owner order, however they were saved', async () => {
    for (const slug of ['disclaimer', 'terms', 'cookies', 'privacy']) {
      await put(slug, doc(`Title of ${slug}`)).expect(200);
    }
    const res = await http().get('/api/hub/policies').expect(200);
    expect(dataOf(res)).toEqual({
      items: [
        {
          slug: 'privacy',
          title: 'Title of privacy',
          effectiveDate: '2026-10-26',
        },
        { slug: 'terms', title: 'Title of terms', effectiveDate: '2026-10-26' },
        {
          slug: 'cookies',
          title: 'Title of cookies',
          effectiveDate: '2026-10-26',
        },
        {
          slug: 'disclaimer',
          title: 'Title of disclaimer',
          effectiveDate: '2026-10-26',
        },
      ],
    });
  });

  it('the list names every one of the nine once they are all published', async () => {
    for (const slug of OWNER_ORDER) await put(slug, doc(slug)).expect(200);
    const res = await http().get('/api/hub/policies').expect(200);
    expect(
      dataOf<{ items: { slug: string }[] }>(res).items.map((i) => i.slug),
    ).toEqual(OWNER_ORDER);
  });

  it('the list leaves out a document with no usable sections (not published), and anything outside the nine', async () => {
    await put('terms', doc('Terms')).expect(200);
    await prisma.legalDocument.create({
      data: {
        slug: 'cookies',
        title: 'Empty',
        effectiveDate: new Date('2026-10-26T00:00:00.000Z'),
        sections: [],
      },
    });
    await prisma.legalDocument.create({
      data: {
        slug: 'imprint',
        title: 'Not one of the nine',
        effectiveDate: new Date('2026-10-26T00:00:00.000Z'),
        sections: [{ heading: 'a', body: 'b' }],
      },
    });
    const res = await http().get('/api/hub/policies').expect(200);
    expect(
      dataOf<{ items: { slug: string }[] }>(res).items.map((i) => i.slug),
    ).toEqual(['terms']);
  });

  it('the list carries a slug, a title and a date and nothing else (no text)', async () => {
    await put('terms', doc('Terms')).expect(200);
    const res = await http().get('/api/hub/policies').expect(200);
    expect(
      Object.keys(dataOf<{ items: object[] }>(res).items[0]).sort(),
    ).toEqual(['effectiveDate', 'slug', 'title']);
  });

  it('a person reading the old two slugs gets exactly the shape the web has always had', async () => {
    await put('terms', {
      title: 'Terms',
      effectiveDate: '2026-09-01',
      sections: [{ heading: 'One', body: 'Text.' }],
    }).expect(200);
    const res = await http().get('/api/hub/policies/terms').expect(200);
    expect(dataOf(res)).toEqual({
      slug: 'terms',
      available: true,
      title: 'Terms',
      effectiveDate: '2026-09-01',
      sections: [{ heading: 'One', body: 'Text.' }],
    });
  });
});

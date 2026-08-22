import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LearnGuideModule } from '../learn-guide.module';

// Seeded in prisma/seed.ts (LEARN_GUIDE_NIGERIA / LEARN_GUIDE_PRICING) —
// distinctive "SEEDED: ..." title asserted against, per task brief.
const SEEDED_COUNTRY_GUIDE_ID = '60000000-0000-4000-8000-000000000001';
const SEEDED_ARTICLE_GUIDE_ID = '60000000-0000-4000-8000-000000000002';
const NON_EXISTENT_UUID = '60000000-0000-4000-8000-00000000ffff';

const ADMIN_KEY = 'learn-guide-contract-spec-key';

describe('LearnGuide (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let previousAdminKey: string | undefined;
  const createdIds: string[] = [];

  beforeAll(async () => {
    previousAdminKey = process.env.WAWU_ADMIN_KEY;
    process.env.WAWU_ADMIN_KEY = ADMIN_KEY;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, LearnGuideModule],
    }).compile();

    // Mirrors main.ts bootstrap exactly (conventions.md § Error envelope /
    // § Validation) so these tests exercise the real wire contract, not a
    // bare controller.
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma && createdIds.length) {
      await prisma.learnGuide.deleteMany({ where: { id: { in: createdIds } } });
    }
    await app.close();
    if (previousAdminKey === undefined) delete process.env.WAWU_ADMIN_KEY;
    else process.env.WAWU_ADMIN_KEY = previousAdminKey;
  });

  describe('GET /api/hub/learn/guides', () => {
    // roles: ["any"] per registry.json — public, no WawuAuthGuard, so there
    // is no 401/403 case for this endpoint.

    it('valid request -> 200 with the envelope + seeded LearnGuide[] shape', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/guides').expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);

      const ids = res.body.data.map((g: { id: string }) => g.id);
      expect(ids).toEqual(expect.arrayContaining([SEEDED_COUNTRY_GUIDE_ID, SEEDED_ARTICLE_GUIDE_ID]));

      const countryGuide = res.body.data.find((g: { id: string }) => g.id === SEEDED_COUNTRY_GUIDE_ID);
      expect(countryGuide).toMatchObject({
        kind: 'country',
        title: 'SEEDED: Nigeria Business Registration Guide',
        country: 'Nigeria',
        subtitle: expect.any(String),
        readMinutes: 12,
        fileCount: 3,
      });
      expect(Array.isArray(countryGuide.sections)).toBe(true);
      expect(countryGuide.sections[0]).toEqual(
        expect.objectContaining({ heading: expect.any(String), body: expect.any(String) }),
      );

      const articleGuide = res.body.data.find((g: { id: string }) => g.id === SEEDED_ARTICLE_GUIDE_ID);
      expect(articleGuide).toMatchObject({ kind: 'article', country: null, fileCount: null });
    });

    it('valid ?kind= filter narrows the result set', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/guides?kind=article').expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((g: { kind: string }) => g.kind === 'article')).toBe(true);
      expect(res.body.data.some((g: { id: string }) => g.id === SEEDED_ARTICLE_GUIDE_ID)).toBe(true);
    });

    it('invalid payload (bad ?kind= value) -> 400', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/guides?kind=not-a-real-kind').expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });
  });

  describe('GET /api/hub/learn/guides/:id', () => {
    // roles: ["any"] per registry.json — public, no WawuAuthGuard, so there
    // is no 401/403 case for this endpoint.

    it('valid request -> 200 with the envelope + seeded LearnGuide shape', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/learn/guides/${SEEDED_COUNTRY_GUIDE_ID}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        id: SEEDED_COUNTRY_GUIDE_ID,
        kind: 'country',
        title: 'SEEDED: Nigeria Business Registration Guide',
        country: 'Nigeria',
        readMinutes: 12,
      });
    });

    it('404s on a well-formed id that does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/learn/guides/${NON_EXISTENT_UUID}`)
        .expect(404);
      expect(res.body.statusCode).toBe(404);
      expect(res.body.data).toBeNull();
    });

    it('invalid payload (malformed, non-UUID id) -> 400', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/guides/not-a-uuid').expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });
  });

  /**
   * POST /learn/guides could never succeed. The DTO allowed
   * `guide | playbook | export | compliance`; the `GuideKind` column accepts
   * `country | article | template`. The two sets are disjoint, so every value
   * that passed validation was rejected by Postgres and every value Postgres
   * accepts was rejected by validation — and the service hid the mismatch
   * behind `as never`. The enum is the side that matches the app
   * (WAWU-Web `LearnGuideKind`), the read-side filter and the seed data, so
   * the DTO was corrected to it.
   */
  describe('POST /api/hub/learn/guides', () => {
    it('401s without the operator key', async () => {
      await request(app.getHttpServer())
        .post('/api/hub/learn/guides')
        .send({ title: 'No key', kind: 'article' })
        .expect(401);
    });

    it.each(['country', 'article', 'template'])(
      'creates a guide of kind %s — all three were unreachable',
      async (kind) => {
        const res = await request(app.getHttpServer())
          .post('/api/hub/learn/guides')
          .set('x-wawu-admin-key', ADMIN_KEY)
          .send({
            title: `SPEC: ${kind} guide`,
            subtitle: 'Written by the contract spec.',
            kind,
            readMinutes: 4,
          })
          .expect(201);

        expect(res.body.data).toMatchObject({ kind, title: `SPEC: ${kind} guide` });
        createdIds.push(res.body.data.id);

        // Really in the database with that kind, not just echoed back.
        const stored = await prisma.learnGuide.findUnique({ where: { id: res.body.data.id } });
        expect(stored?.kind).toBe(kind);
      },
    );

    it.each(['guide', 'playbook', 'export', 'compliance'])(
      'rejects the old, non-existent kind %s',
      async (kind) => {
        await request(app.getHttpServer())
          .post('/api/hub/learn/guides')
          .set('x-wawu-admin-key', ADMIN_KEY)
          .send({ title: 'SPEC: bad kind', kind })
          .expect(400);
      },
    );

    it('defaults to a kind the column actually accepts', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/learn/guides')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ title: 'SPEC: default kind' })
        .expect(201);
      createdIds.push(res.body.data.id);
      expect(['country', 'article', 'template']).toContain(res.body.data.kind);
    });

    it('the created guide is then readable through the public list', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/hub/learn/guides')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ title: 'SPEC: readable guide', kind: 'template' })
        .expect(201);
      createdIds.push(created.body.data.id);

      const res = await request(app.getHttpServer())
        .get('/api/hub/learn/guides?kind=template')
        .expect(200);
      expect(res.body.data.map((g: { id: string }) => g.id)).toContain(created.body.data.id);
    });
  });

  describe('PATCH /api/hub/learn/guides/:id', () => {
    it('changes a guide kind to another real one', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/hub/learn/guides')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ title: 'SPEC: patchable', kind: 'article' })
        .expect(201);
      createdIds.push(created.body.data.id);

      const res = await request(app.getHttpServer())
        .patch(`/api/hub/learn/guides/${created.body.data.id}`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ kind: 'country', country: 'Ghana' })
        .expect(200);

      expect(res.body.data).toMatchObject({ kind: 'country', country: 'Ghana' });
    });

    it('400s on a kind that is not in the enum', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/hub/learn/guides')
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ title: 'SPEC: patch bad kind', kind: 'article' })
        .expect(201);
      createdIds.push(created.body.data.id);

      await request(app.getHttpServer())
        .patch(`/api/hub/learn/guides/${created.body.data.id}`)
        .set('x-wawu-admin-key', ADMIN_KEY)
        .send({ kind: 'compliance' })
        .expect(400);
    });
  });
});

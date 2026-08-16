import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { LearnGuideModule } from '../learn-guide.module';

// Seeded in prisma/seed.ts (LEARN_GUIDE_NIGERIA / LEARN_GUIDE_PRICING) —
// distinctive "SEEDED: ..." title asserted against, per task brief.
const SEEDED_COUNTRY_GUIDE_ID = '60000000-0000-4000-8000-000000000001';
const SEEDED_ARTICLE_GUIDE_ID = '60000000-0000-4000-8000-000000000002';
const NON_EXISTENT_UUID = '60000000-0000-4000-8000-00000000ffff';

describe('LearnGuide (contract)', () => {
  let app: INestApplication;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await app.close();
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
});

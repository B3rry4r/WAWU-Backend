import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PartnerServiceModule } from '../partner-service.module';

/**
 * The Marketplace "Featured Services" rail.
 *
 * The approved Marketplace screen draws each service as an image, a name, a
 * category label and a floor price ("From ₦10,000"). None of those four was
 * answerable: `icon` is a glyph name rather than a picture, `priceFrom` is
 * free text a client cannot format or compare, and there was no way to ask
 * which services are on the rail at all.
 *
 * What this suite proves:
 *  - all four are served, and are nullable-safe on a row that has none of
 *    them (which is every row that existed before the column);
 *  - `priceFrom` still says exactly what it always said, so the existing
 *    service detail screen is untouched;
 *  - `?featured=true` narrows the list, and sending nothing still returns
 *    the whole catalogue.
 *
 * Fixtures live under this suite's own `3f……` id prefix and are swept in
 * afterAll (README § Test hygiene). No seeded row is read or mutated.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const SVC_FEATURED = '3f000000-0000-4000-8000-000000000001';
const SVC_PLAIN = '3f000000-0000-4000-8000-000000000002';

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Marketplace service cards (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const ids = [SVC_FEATURED, SVC_PLAIN];

  async function sweep(): Promise<void> {
    await prisma.partnerService.deleteMany({ where: { id: { in: ids } } });
  }

  async function resetFixtures(): Promise<void> {
    await sweep();
    await prisma.partnerService.createMany({
      data: [
        {
          id: SVC_FEATURED,
          slug: 'fixture-cover-art',
          name: 'Fixture: Cover Art Design',
          tagline: 'Artwork that sells the record.',
          blurb: 'A fixture service for the marketplace card contract suite.',
          icon: 'palette',
          status: 'live',
          priceFrom: '₦10,000',
          imageUrl: 'https://example.test/cover-art.jpg',
          category: 'Design',
          priceFromNaira: 10000,
          featured: true,
        },
        {
          id: SVC_PLAIN,
          slug: 'fixture-nothing-filled-in',
          name: 'Fixture: nothing filled in',
          tagline: 'A service from before the card existed.',
          blurb: 'A fixture service for the marketplace card contract suite.',
          icon: 'building-office',
          status: 'live',
        },
      ],
    });
  }

  beforeAll(async () => {
    token = await loginToWawuId('user@test.wawu.dev');

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        PartnerServiceModule,
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

    prisma = moduleRef.get(PrismaService);
    await resetFixtures();
  });

  afterAll(async () => {
    await sweep();
    await app.close();
  });

  /** One fixture row out of the list response. */
  function pick(body: unknown, id: string): Record<string, unknown> {
    const data = (body as { data: Record<string, unknown>[] }).data;
    const found = data.find((s) => s.id === id);
    expect(found).toBeDefined();
    return found as Record<string, unknown>;
  }

  it('serves the image, the category and the numeric floor price', async () => {
    const res = await http().get('/api/hub/services').set(auth()).expect(200);
    expect(pick(res.body, SVC_FEATURED)).toEqual(
      expect.objectContaining({
        imageUrl: 'https://example.test/cover-art.jpg',
        category: 'Design',
        priceFromNaira: 10000,
        featured: true,
      }),
    );
  });

  it('leaves the free-text priceFrom exactly as it was', async () => {
    // The detail screen already prints this string. A numeric column arriving
    // beside it must not rewrite or replace it.
    const res = await http()
      .get(`/api/hub/services/${SVC_FEATURED}`)
      .set(auth())
      .expect(200);
    expect(res.body.data.priceFrom).toBe('₦10,000');
    expect(res.body.data.priceFromNaira).toBe(10000);
  });

  it('reports nulls rather than omitting them on a service that has none', async () => {
    const res = await http().get('/api/hub/services').set(auth()).expect(200);
    const plain = pick(res.body, SVC_PLAIN);

    // Present and null, not missing: the card has to be able to tell "no
    // price published" from "the API forgot to send it", and draw nothing
    // rather than a ₦0.
    expect(plain).toHaveProperty('imageUrl', null);
    expect(plain).toHaveProperty('category', null);
    expect(plain).toHaveProperty('priceFromNaira', null);
    // Defaulted, so nothing lands on the rail without somebody deciding.
    expect(plain).toHaveProperty('featured', false);
  });

  it('narrows to the rail on ?featured=true, and returns everything without it', async () => {
    const rail = await http()
      .get('/api/hub/services?featured=true')
      .set(auth())
      .expect(200);
    const railIds = (rail.body.data as { id: string }[]).map((s) => s.id);
    expect(railIds).toContain(SVC_FEATURED);
    expect(railIds).not.toContain(SVC_PLAIN);

    const all = await http().get('/api/hub/services').set(auth()).expect(200);
    const allIds = (all.body.data as { id: string }[]).map((s) => s.id);
    expect(allIds).toEqual(expect.arrayContaining(ids));
  });

  it('filters by category, and 400s a parameter nobody implements', async () => {
    const res = await http()
      .get('/api/hub/services?category=Design')
      .set(auth())
      .expect(200);
    const found = (res.body.data as { id: string }[]).map((s) => s.id);
    expect(found).toContain(SVC_FEATURED);
    expect(found).not.toContain(SVC_PLAIN);

    await http()
      .get('/api/hub/services?sortBy=whatever')
      .set(auth())
      .expect(400);
  });
});

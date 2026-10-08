import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SearchResponseModule } from '../../search-response/search-response.module';

/**
 * SCHOOLS-04 round 4 (finding F1): the keyset on (name, id) must hold when
 * ids run AGAINST name order. The earlier paging spec gives ids that rise
 * with the names, so a stray id-only branch in the keyset OR (or a reversed
 * id comparison) still passed. Here the ids of distinct names fall as the
 * names rise, and tied names get ids in a scrambled order.
 */
const MARK = 'S04rv';
const uid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('Schools paging with ids against name order (SCHOOLS-04 round 4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  type Page = {
    items: { id: string; name: string }[];
    nextCursor: string | null;
  };
  const page = async (qs: string): Promise<Page> => {
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get(`/api/hub/schools?${qs}`)
      .expect(200);
    return (res.body as { data: Page }).data;
  };
  const cleanUp = () =>
    prisma.school.deleteMany({ where: { name: { startsWith: MARK } } });
  const mk = (name: string, id: string) =>
    prisma.school.create({
      data: {
        id,
        name,
        category: 'tech',
        location: 'Yaba, Lagos',
        about: 'About',
        reportEmail: 'report@school.example.com',
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        SearchResponseModule,
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
    await cleanUp();
    // Group A: 20 distinct names whose ids FALL as the names rise.
    for (let i = 0; i < 20; i++)
      await mk(`${MARK} A${String(i).padStart(2, '0')}`, uid(0x9000 - i));
    // Group B: 10 names tied three ways, the ids scrambled (neither rising
    // nor falling with the name, and not in insertion order inside a tie).
    for (let k = 0; k < 10; k++)
      for (let j = 0; j < 3; j++) {
        const n = (k * 3 + j) * 37 + 11; // 37 is coprime with 4096
        await mk(
          `${MARK} B${String(k).padStart(2, '0')}`,
          uid(0x5000 + (n % 4096)),
        );
      }
  }, 120_000);

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  it('every walk equals ORDER BY name, id exactly, with no duplicate or miss', async () => {
    const expected = (
      await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "School" WHERE name LIKE ${`${MARK}%`} ORDER BY name, id`
    ).map((r) => r.id);
    expect(expected).toHaveLength(50);
    // the setup really does run against name order
    expect(expected.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, i) => uid(0x9000 - i)),
    );
    for (const limit of [1, 2, 3, 4, 7, 10, 19, 20, 49, 50]) {
      const seen: string[] = [];
      let c: string | null = null;
      do {
        const p: Page = await page(
          `q=${MARK}&limit=${limit}${c ? `&cursor=${c}` : ''}`,
        );
        expect(p.items.length).toBeLessThanOrEqual(limit);
        seen.push(...p.items.map((s) => s.id));
        c = p.nextCursor;
      } while (c);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expected);
    }
  });
});

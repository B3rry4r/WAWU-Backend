import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { SearchResponseModule } from '../../search-response/search-response.module';

/**
 * SCHOOLS-04 round 2: keyset paging on (name, id) and the boundaries the
 * first spec left open. Rows are made for the run (names start with MARK).
 */
const MARK = 'S04pg';
const SCHOOLS = 62; // 31 name pairs, each pair a tie on name
const uid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const cur = (name: string, id: string) =>
  Buffer.from(JSON.stringify([name, id])).toString('base64url');

describe('Public schools paging and boundaries (SCHOOLS-04 round 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const get = (p: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0]).get(
      `/api/hub${p}`,
    );
  /** The `data` of a response, typed by the caller. */
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  type Item = { id: string; name: string; category: string };
  type Page = { items: Item[]; nextCursor: string | null };
  const page = async (qs: string): Promise<Page> =>
    data<Page>(await get(`/schools?${qs}`).expect(200));
  const cleanUp = () =>
    prisma.school.deleteMany({ where: { name: { startsWith: MARK } } });
  const mk = (
    name: string,
    extra: Partial<Prisma.SchoolUncheckedCreateInput> = {},
  ) =>
    prisma.school.create({
      data: {
        name,
        category: 'tech',
        location: 'Yaba, Lagos',
        about: 'About',
        reportEmail: 'report@school.example.com',
        ...extra,
      },
    });
  const mkCourse = (
    schoolId: string,
    title: string,
    priceKobo: number,
    x = {},
  ) =>
    prisma.schoolCourse.create({
      data: {
        schoolId,
        title,
        weeks: 4,
        mode: 'online',
        syllabus: ['a'],
        outcomes: ['b'],
        priceKobo,
        ...x,
      },
    });

  /** Every shown MARK school in the order the API promises. */
  const everyone = async (extra = ''): Promise<Item[]> => {
    const out: Item[] = [];
    let c: string | null = null;
    do {
      const p: Page = await page(
        `q=${MARK}&limit=50${extra}${c ? `&cursor=${c}` : ''}`,
      );
      out.push(...p.items);
      c = p.nextCursor;
    } while (c);
    return out;
  };

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
    // Pair k shares a name; the higher id is inserted first, so only an
    // explicit id tiebreak (not row order) gives the promised order.
    for (let k = 0; k < SCHOOLS / 2; k++) {
      for (const n of [2 * k + 1, 2 * k]) {
        await mk(`${MARK} N${String(k).padStart(2, '0')}`, {
          id: uid(n),
          category: n % 3 === 0 ? 'creative' : 'tech',
        });
      }
    }
  }, 120_000);

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  it('ties on name come out by id, in every page size', async () => {
    const all = await everyone();
    expect(all.map((s) => s.id)).toEqual(
      Array.from({ length: SCHOOLS }, (_, n) => uid(n)),
    );
    for (const limit of [1, 3, 7]) {
      const seen: string[] = [];
      let c: string | null = null;
      do {
        const p: Page = await page(
          `q=${MARK}&limit=${limit}${c ? `&cursor=${c}` : ''}`,
        );
        seen.push(...p.items.map((s) => s.id));
        c = p.nextCursor;
      } while (c);
      expect(seen).toEqual(all.map((s) => s.id));
    }
  });

  it('hiding the school a page ended on skips nobody', async () => {
    const p1 = await page(`q=${MARK}&limit=3`);
    const cursorSchool = p1.items[2].id;
    await prisma.school.update({
      where: { id: cursorSchool },
      data: { hiddenAt: new Date() },
    });
    try {
      const p2 = await page(`q=${MARK}&limit=3&cursor=${p1.nextCursor}`);
      expect(p2.items.map((s) => s.id)).toEqual([uid(3), uid(4), uid(5)]);
    } finally {
      await prisma.school.update({
        where: { id: cursorSchool },
        data: { hiddenAt: null },
      });
    }
  });

  it('a cursor school that the category or the search does not match skips nobody', async () => {
    // Ids 0..3 are the first four; uid(3) is 'creative' (n % 3 === 0).
    const p1 = await page(`q=${MARK}&limit=4`);
    expect(p1.items[3]).toMatchObject({ id: uid(3), category: 'creative' });
    const byCat = await page(
      `q=${MARK}&limit=5&category=tech&cursor=${p1.nextCursor}`,
    );
    expect(byCat.items.map((s) => s.id)).toEqual(
      [4, 5, 7, 8, 10].map((n) => uid(n)),
    );
    // The page ends on uid(10), named N05; the narrower search 'N1' does
    // not match it, and must still start at N10 (uid 20).
    const p2 = await page(`q=${MARK}&limit=11`);
    expect(p2.items[10]).toMatchObject({ id: uid(10), name: `${MARK} N05` });
    const byQ = await page(
      `q=${encodeURIComponent(`${MARK} N1`)}&limit=50&cursor=${p2.nextCursor}`,
    );
    expect(byQ.items.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, n) => uid(20 + n)),
    );
    expect(byQ.nextCursor).toBeNull();
  });

  it('a full walk with hide and show toggled mid-walk visits every visible row once', async () => {
    const all = (await everyone()).map((s) => s.id);
    const ahead = all[40]; // hidden at the start, shown before the walk reaches it
    const toggled: string[] = [];
    await prisma.school.update({
      where: { id: ahead },
      data: { hiddenAt: new Date() },
    });
    const seen: string[] = [];
    let c: string | null = null;
    let n = 0;
    try {
      do {
        const p: Page = await page(
          `q=${MARK}&limit=6${c ? `&cursor=${c}` : ''}`,
        );
        seen.push(...p.items.map((s) => s.id));
        c = p.nextCursor;
        n++;
        if (n === 2)
          await prisma.school.update({
            where: { id: ahead },
            data: { hiddenAt: null },
          });
        if (c) {
          // hide the school each page ended on, after the page was read
          const lastId = p.items[p.items.length - 1].id;
          toggled.push(lastId);
          await prisma.school.update({
            where: { id: lastId },
            data: { hiddenAt: new Date() },
          });
        }
      } while (c);
    } finally {
      await prisma.school.updateMany({
        where: { name: { startsWith: MARK } },
        data: { hiddenAt: null },
      });
    }
    expect(new Set(seen).size).toBe(seen.length); // none twice
    expect(seen).toEqual(all); // none missed, same order
  });

  it('a forged, stale, foreign or broken cursor is 400 or a plain page, never 500', async () => {
    const hidden = await mk(`${MARK} Zhidden`, { hiddenAt: new Date() });
    const cases = [
      uid(5), // the old form: a bare school id
      hidden.id,
      'abc',
      'A'.repeat(1498), // the longest cursor length (round 3, D2)
      'A'.repeat(1499),
      '%00',
      'a%00b',
      '%ED%A0%80',
      '....',
      cur('x', 'not-a-uuid'),
      cur(`${MARK}\u0000`, uid(1)),
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from('null').toString('base64url'),
      Buffer.from('["a","b","c"]').toString('base64url'),
      Buffer.from(JSON.stringify(['x'.repeat(361), uid(1)])).toString(
        'base64url',
      ),
      `${cur(`${MARK} N03`, uid(7))}=`,
      cur(`${MARK} N03`, uid(7)).toUpperCase(),
      cur('', uid(7)),
    ];
    for (const c of cases) {
      const res = await get(`/schools?cursor=${c}`);
      expect([200, 400]).toContain(res.status);
    }
    for (const c of ['abc', uid(5), cur('x', 'nope'), 'A'.repeat(1499)])
      await get(`/schools?cursor=${c}`).expect(400);
    await get('/schools?cursor=a&cursor=b').expect(400);
    // a well-formed position never reveals the hidden school
    const p = await page(
      `q=${MARK}&limit=50&cursor=${cur(`${MARK} Z`, hidden.id)}`,
    );
    expect(p.items.map((s) => s.id)).not.toContain(hidden.id);
    const all = (await page(`q=${MARK}&limit=50`)).items;
    expect(all.map((s) => s.id)).not.toContain(hidden.id);
    await prisma.school.delete({ where: { id: hidden.id } });
  });

  it('q of 100 characters is accepted and 101 is refused', async () => {
    await get(`/schools?q=${'a'.repeat(100)}`).expect(200);
    await get(`/schools?q=${'a'.repeat(101)}`).expect(400);
    await get(`/search?q=${'a'.repeat(100)}&tab=schools`).expect(200);
  });

  it('nextCursor is null when the rest is exactly the limit, set when one more remains', async () => {
    const exact = await page(`q=${MARK}&limit=50&category=tech`);
    const total = exact.items.length;
    expect(exact.nextCursor).toBeNull();
    expect(total).toBeLessThanOrEqual(50);
    const atLimit = await page(`q=${MARK}&category=tech&limit=${total}`);
    expect(atLimit.items.length).toBe(total);
    expect(atLimit.nextCursor).toBeNull();
    const short = await page(`q=${MARK}&category=tech&limit=${total - 1}`);
    expect(short.nextCursor).not.toBeNull();
    const next = await page(
      `q=${MARK}&category=tech&limit=${total - 1}&cursor=${short.nextCursor}`,
    );
    expect(next.items.length).toBe(1);
    expect(next.nextCursor).toBeNull();
  });

  it('the page is 20 schools by default', async () => {
    const p = await page(`q=${MARK}`);
    expect(p.items.length).toBe(20);
    expect(p.nextCursor).not.toBeNull();
    const t = await get(`/search?q=${MARK}&tab=schools`).expect(200);
    expect(data<{ schools: unknown[] }>(t).schools.length).toBe(20);
  });

  describe('the card and the course page', () => {
    let sid: string;
    beforeAll(async () => {
      const s = await mk(`${MARK} Zcard`);
      sid = s.id;
      await mkCourse(sid, 'Logo Design 1', 30_000_00);
      await mkCourse(sid, 'Logo Design 2', 10_000_00);
      await mkCourse(sid, 'Logo Design 3', 20_000_00);
      await mkCourse(sid, 'Logo Design 4', 40_000_00);
      await mkCourse(sid, 'Logo Design 5', 50_000_00);
      await mkCourse(sid, 'Logo Design Cheap Hidden', 100_00, {
        hiddenAt: new Date(),
      });
    });

    it('at most 3 matched courses, and fromPriceKobo is the lowest shown fee', async () => {
      const res = await get(
        `/schools?q=${encodeURIComponent('Logo Design')}`,
      ).expect(200);
      const card = data<{
        items: {
          id: string;
          matchedCourses: string[];
          fromPriceKobo: number;
          courseCount: number;
        }[];
      }>(res).items.find((i) => i.id === sid)!;
      expect(card.matchedCourses).toHaveLength(3);
      expect(card.courseCount).toBe(5);
      expect(card.fromPriceKobo).toBe(10_000_00);
    });

    it('one seat left is not full; none left is', async () => {
      const c = await prisma.schoolCourse.findFirstOrThrow({
        where: { schoolId: sid, title: 'Logo Design 1' },
      });
      const mkI = (day: string, taken: number) =>
        prisma.courseIntake.create({
          data: {
            courseId: c.id,
            startDate: new Date(`2027-${day}T00:00:00Z`),
            schedule: 'Mon',
            location: 'Yaba',
            capacity: 5,
            seatsTaken: taken,
          },
        });
      await mkI('01-10', 4);
      await mkI('02-10', 5);
      await mkI('03-10', 3);
      const res = await get(`/schools/courses/${c.id}`).expect(200);
      expect(data<{ intakes: unknown[] }>(res).intakes).toMatchObject([
        { seatsLeft: 1, full: false },
        { seatsLeft: 0, full: true },
        { seatsLeft: 2, full: false },
      ]);
    });
  });
});

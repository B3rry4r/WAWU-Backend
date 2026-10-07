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
 * SCHOOLS-04: the public schools reads. Rows are made for the run (names start
 * with MARK) so the spec holds on a database other suites have used.
 */
const MARK = 'S04spec';
const NONE = '00000000-0000-4000-8000-0000000000ff';

describe('Public schools: browse, search, course page (SCHOOLS-04)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const get = (p: string) => http().get(`/api/hub${p}`);
  const names = (res: request.Response) =>
    (res.body.data.items as { name: string }[]).map((i) => i.name);

  let design: string; // school with a "Product Design" course
  let other: string; // school with an unrelated course
  let course: string;
  let hiddenCourse: string;
  let i1: string;
  let i2: string;
  let iHidden: string;

  async function cleanUp() {
    await prisma.school.deleteMany({ where: { name: { startsWith: MARK } } });
  }
  const school = (name: string, extra: object = {}) =>
    prisma.school.create({
      data: {
        name: `${MARK} ${name}`,
        category: 'tech',
        location: 'Yaba, Lagos',
        about: 'About text',
        reportEmail: 'secret@school.example.com',
        applyUrl: 'https://school.example.com/apply',
        ...extra,
      },
    });
  const mkCourse = (schoolId: string, title: string, extra: object = {}) =>
    prisma.schoolCourse.create({
      data: {
        schoolId,
        title,
        weeks: 12,
        mode: 'hybrid',
        syllabus: ['One', 'Two'],
        outcomes: ['Certificate'],
        priceKobo: 15_000_000,
        ...extra,
      },
    });
  const mkIntake = (courseId: string, date: string, extra: object = {}) =>
    prisma.courseIntake.create({
      data: {
        courseId,
        startDate: new Date(`${date}T00:00:00Z`),
        schedule: 'Saturdays',
        location: 'Yaba',
        capacity: 20,
        ...extra,
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

    const a = await school('Alpha Academy');
    const b = await school('Beta House', {
      category: 'creative',
      location: '100% Lekki_Phase',
    });
    design = a.id;
    other = b.id;
    const c1 = await mkCourse(a.id, 'Product Design');
    course = c1.id;
    await mkCourse(a.id, 'Hidden Design Secret', { hiddenAt: new Date() }).then(
      (c) => (hiddenCourse = c.id),
    );
    await mkCourse(b.id, 'Pottery', { priceKobo: 9_000_000 });
    i2 = (await mkIntake(c1.id, '2026-12-01', { capacity: 10, seatsTaken: 10 }))
      .id;
    i1 = (await mkIntake(c1.id, '2026-11-03', { capacity: 20, seatsTaken: 7 }))
      .id;
    iHidden = (await mkIntake(c1.id, '2026-10-01', { hiddenAt: new Date() }))
      .id;
  }, 60_000);

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  it('a user can search "design" and get the schools whose courses match, with the matching course', async () => {
    const res = await get('/schools?q=DESIGN').expect(200);
    const mine = (
      res.body.data.items as { id: string; matchedCourses: string[] }[]
    ).find((i) => i.id === design);
    expect(mine?.matchedCourses).toEqual(['Product Design']);
    expect(names(res)).not.toContain(`${MARK} Beta House`);
  });

  it('a hidden course never matches a search or counts', async () => {
    const res = await get('/schools?q=Secret').expect(200);
    expect(names(res)).not.toContain(`${MARK} Alpha Academy`);
    const list = await get('/schools?q=Alpha').expect(200);
    const alpha = list.body.data.items.find(
      (i: { id: string }) => i.id === design,
    );
    expect(alpha.courseCount).toBe(1);
    expect(alpha.fromPriceKobo).toBe(15_000_000);
  });

  it('a course page shows each intake with seats left from capacity minus seats taken, soonest first, hidden intake dropped', async () => {
    const res = await get(`/schools/courses/${course}`).expect(200);
    const d = res.body.data;
    expect(d.intakes.map((i: { id: string }) => i.id)).toEqual([i1, i2]);
    expect(d.intakes[0]).toMatchObject({
      startDate: '2026-11-03',
      capacity: 20,
      seatsLeft: 13,
      full: false,
    });
    expect(d.intakes[1]).toMatchObject({ seatsLeft: 0, full: true });
    expect(d.intakes.some((i: { id: string }) => i.id === iHidden)).toBe(false);
    expect(d.school.id).toBe(design);
    expect(d.priceKobo).toBe(15_000_000);
    expect(JSON.stringify(d)).not.toMatch(
      /reportEmail|secret@|rating|hiddenAt/,
    );
  });

  it('seats left follows the count: one more taken, one fewer left', async () => {
    await prisma.courseIntake.update({
      where: { id: i1 },
      data: { seatsTaken: 19 },
    });
    const res = await get(`/schools/courses/${course}`).expect(200);
    expect(res.body.data.intakes[0].seatsLeft).toBe(1);
    await prisma.courseIntake.update({
      where: { id: i1 },
      data: { seatsTaken: 7 },
    });
  });

  it('the school page lists shown courses with the next shown intake', async () => {
    const res = await get(`/schools/${design}`).expect(200);
    const d = res.body.data;
    expect(d.courses.map((c: { id: string }) => c.id)).toEqual([course]);
    expect(d.courses[0].nextIntake).toMatchObject({ id: i1, seatsLeft: 13 });
    expect(d.about).toBe('About text');
    expect(JSON.stringify(d)).not.toMatch(/reportEmail|secret@|rating/);
  });

  it('hidden at each level: course, intake, school disappear and return on unhide', async () => {
    await get(`/schools/courses/${hiddenCourse}`).expect(404);

    await prisma.courseIntake.update({
      where: { id: i1 },
      data: { hiddenAt: new Date() },
    });
    let r = await get(`/schools/courses/${course}`).expect(200);
    expect(r.body.data.intakes.map((i: { id: string }) => i.id)).toEqual([i2]);
    await prisma.courseIntake.update({
      where: { id: i1 },
      data: { hiddenAt: null },
    });
    r = await get(`/schools/courses/${course}`).expect(200);
    expect(r.body.data.intakes).toHaveLength(2);

    await prisma.school.update({
      where: { id: design },
      data: { hiddenAt: new Date() },
    });
    await get(`/schools/${design}`).expect(404);
    await get(`/schools/courses/${course}`).expect(404);
    expect(names(await get('/schools?q=Alpha').expect(200))).toEqual([]);
    expect(names(await get('/schools?q=Product').expect(200))).toEqual([]);
    const tab = await get('/search?q=Alpha&tab=schools').expect(200);
    expect(tab.body.data.schools).toEqual([]);
    await prisma.school.update({
      where: { id: design },
      data: { hiddenAt: null },
    });
    await get(`/schools/${design}`).expect(200);
    await get(`/schools/courses/${course}`).expect(200);
  });

  it('category filters; an unknown category is 400', async () => {
    const res = await get(`/schools?category=creative&q=${MARK}`).expect(200);
    expect(names(res)).toEqual([`${MARK} Beta House`]);
    await get('/schools?category=nope').expect(400);
    await get('/schools?category=tech&category=creative').expect(400);
  });

  it('wildcards and regex characters in q mean themselves', async () => {
    for (const q of ['%', '_', '.*', '(', '[', '\\', '100%', 'Lekki_P']) {
      const res = await get(`/schools?q=${encodeURIComponent(q)}`).expect(200);
      const ours = names(res).filter((n) => n.startsWith(MARK));
      if (q === '100%' || q === 'Lekki_P' || q === '%' || q === '_')
        expect(ours).toEqual([`${MARK} Beta House`]);
      else expect(ours).toEqual([]);
    }
    const res = await get('/schools?q=Lekk_').expect(200);
    expect(names(res)).toEqual([]); // "_" is not a one-character wildcard
  });

  it('cursor pages: no repeat, no gap, ends with a null cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 5; n++) {
      const res: request.Response = await get(
        `/schools?q=${MARK}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      seen.push(...names(res));
      cursor = res.body.data.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(seen).toEqual([`${MARK} Alpha Academy`, `${MARK} Beta House`]);
    expect(cursor).toBeNull();
    await get(`/schools?cursor=${NONE}`).expect(400);
    await get('/schools?cursor=abc').expect(400);
  });

  it('odd inputs answer 4xx, never 500', async () => {
    const bad = [
      '/schools?q=a%00b',
      `/schools?q=${'x'.repeat(5000)}`,
      '/schools?q=a&q=b',
      '/schools?q[a]=1',
      '/schools?limit=0',
      '/schools?limit=51',
      '/schools?limit=99999999999999999999',
      '/schools?limit=abc',
      '/schools?limit=1&limit=2',
      '/schools?cursor=a%00b',
      '/schools?cursor=%ED%A0%80',
      '/schools/abc',
      '/schools/courses/abc',
      '/schools/%00',
      `/schools/${NONE}`,
      `/schools/courses/${NONE}`,
      '/schools?unknown=1',
      '/search?q=a%00b&tab=schools',
    ];
    for (const p of bad) {
      const res = await get(p);
      expect([p, res.status]).toEqual([p, expect.any(Number)]);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    const ok = await get('/schools?q=').expect(200);
    expect(ok.body.data.items).toBeInstanceOf(Array);
    await get('/search?q=%20%20&tab=schools').expect(200);
    await get('/schools?q=a%ED%A0%80').expect(200); // not UTF-8: plain text
    await get('/schools?q=%ff%fe').expect(200);
    await get('/search?q=%ED%A0%80&tab=schools').expect(200);
    await get('/schools').send([]).expect(200);
  });

  it('the schools tab of search returns schools; other tabs keep their exact keys', async () => {
    const tab = await get('/search?q=design&tab=schools').expect(200);
    expect(
      tab.body.data.schools.some((s: { id: string }) => s.id === design),
    ).toBe(true);
    expect(tab.body.data.content).toEqual([]);
    for (const t of ['all', 'content', 'creators', 'communities']) {
      const r = await get(`/search?q=design&tab=${t}`).expect(200);
      expect(Object.keys(r.body.data).sort()).toEqual([
        'communities',
        'content',
        'creators',
      ]);
    }
    await get('/search?q=design&tab=bogus').expect(400);
  });
});

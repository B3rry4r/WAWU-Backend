import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminSchoolsModule } from '../../admin/schools/admin-schools.module';
import { SearchResponseModule } from '../../search-response/search-response.module';
import { UNSEARCHABLE_QUERY_MESSAGE } from '../../search-response/searchable-query';
import {
  CURSOR_MAX_LENGTH,
  CURSOR_NAME_MAX_UNITS,
  decodeCursor,
} from '../schools-cursor';

/**
 * SCHOOLS-04 round 3. Schools, courses and intakes are written through the
 * real admin routes (SCHOOLS-02) wherever a route writes them, then read
 * through the public routes:
 * - D2: every name the admin accepts gives a cursor the list accepts, at the
 *   admin's maximum of the worst characters, and nothing longer is a cursor;
 * - D3: the school page's next intake is the course page's first intake, on
 *   one day, before and after edits;
 * - the cursor's exact text, the name match in any case, `matchedCourses`
 *   (only matching courses, in course creation order) and no `seatsTaken`
 *   in any public answer.
 * Every school here has its place starting with PLACE, so `q=PLACE` lists
 * exactly them, and clean-up finds them whatever their names are.
 */
const PLACE = 'S04r3spec';
const LOC = `${PLACE}, Yaba`;
const ADMIN_ID = 'ad040400-0000-4000-8000-000000000003';
const ADMIN_EMAIL = 's0404-r3@admin.test.wawu.dev';
const PASSWORD = 'schools-04-round-3-password';
const KEYS = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];
const REFUSED_CURSOR = 'cursor is not one this server gave out';

/** Counts as one character to the admin; 9 bytes of JSON (\u0001 + U+FE0F). */
const WORST_BYTES = '\u0001️';
/** Counts as one character to the admin; 3 UTF-16 units (a flag). */
const WORST_UNITS = '\u{1F3F3}️';
/** A Han ideograph past U+1F3F3: after both in byte order and in ICU's. */
const LATER = '\u{20000}';

const COURSE = {
  title: 'Product Design',
  weeks: 12,
  mode: 'hybrid',
  syllabus: ['Research', 'Prototypes'],
  outcomes: ['Certificate'],
  priceKobo: 21_500_000,
};
const INTAKE = {
  startDate: '2027-03-01',
  schedule: 'Saturdays',
  location: 'Yaba',
  capacity: 5,
};

const cur = (name: string, id: string) =>
  Buffer.from(JSON.stringify([name, id])).toString('base64url');
const raw = (json: string) => Buffer.from(json).toString('base64url');
/** Every key anywhere in a JSON value. */
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
};

type Item = { id: string; name: string; matchedCourses: string[] };
type Page = { items: Item[]; nextCursor: string | null };
type Intake = { id: string; seatsLeft: number };

describe('Public schools on rows the admin wrote (SCHOOLS-04 round 3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const snapshot: Record<string, string | undefined> = {};
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const get = (p: string) => http().get(`/api/hub${p}`);
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  const message = (res: { body: unknown }) =>
    (res.body as { message: string }).message;
  const page = async (qs: string): Promise<Page> =>
    data<Page>(await get(`/schools?${qs}`).expect(200));
  const admin = (method: 'post' | 'patch', path: string, body: object) =>
    http()
      [method](`/api/hub/admin${path}`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body);
  const addSchool = async (name: string, extra: object = {}) =>
    data<{ id: string; name: string }>(
      await admin('post', '/schools', {
        name,
        category: 'vocational',
        location: LOC,
        about: 'A school this spec creates and removes.',
        reportEmail: 'enrolments@school.example.com',
        ...extra,
      }).expect(201),
    );
  const addCourse = async (schoolId: string, extra: object = {}) =>
    data<{ id: string }>(
      await admin('post', `/schools/${schoolId}/courses`, {
        ...COURSE,
        ...extra,
      }).expect(201),
    );
  const addIntake = async (courseId: string, extra: object = {}) =>
    data<{ id: string }>(
      await admin('post', `/school-courses/${courseId}/intakes`, {
        ...INTAKE,
        ...extra,
      }).expect(201),
    );
  const cleanUp = () =>
    prisma.school.deleteMany({ where: { location: { startsWith: PLACE } } });

  beforeAll(async () => {
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'schools04-access-secret-0123456789abcdef';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'schools04-refresh-secret-0123456789abcde';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminSchoolsModule,
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
    const argon2 = await import('argon2');
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.adminUser.create({
      data: {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        passwordHash: await argon2.hash(PASSWORD),
        name: 'S0404 round 3',
        role: 'superadmin',
      },
    });
    token = data<{ accessToken: string }>(
      await http()
        .post('/api/hub/admin/auth/login')
        .send({ email: ADMIN_EMAIL, password: PASSWORD })
        .expect(200),
    ).accessToken;
  }, 60_000);

  afterAll(async () => {
    await cleanUp();
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await app.close();
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  describe('D2: a cursor for every name the admin accepts', () => {
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      // The admin's maximum of each worst character, and one more refused.
      for (const [key, c] of [
        ['bytes', WORST_BYTES],
        ['units', WORST_UNITS],
      ] as const) {
        const refused = await admin('post', '/schools', {
          name: c.repeat(121),
          category: 'vocational',
          location: LOC,
          about: 'Refused: one character over the admin maximum.',
          reportEmail: 'enrolments@school.example.com',
        }).expect(400);
        expect(message(refused)).toBe(
          'name must be shorter than or equal to 120 characters',
        );
        ids[key] = (await addSchool(c.repeat(120))).id;
        // A second school after it in the same list, also at the maximum.
        ids[`${key}-next`] = (await addSchool(c.repeat(119) + LATER)).id;
      }
    });

    it('a walk at limit 1 passes both longest names and reaches the school after each', async () => {
      const all = (await page(`q=${PLACE}&limit=50`)).items.map((s) => s.id);
      expect(all).toHaveLength(4);
      const seen: string[] = [];
      const cursorAfter: Record<string, string> = {};
      let c: string | null = null;
      do {
        const p: Page = await page(
          `q=${PLACE}&limit=1${c ? `&cursor=${c}` : ''}`,
        );
        seen.push(...p.items.map((s) => s.id));
        c = p.nextCursor;
        if (c) cursorAfter[p.items[0].id] = c;
      } while (c);
      expect(seen).toEqual(all);
      for (const key of ['bytes', 'units']) {
        // the longest name comes before its neighbour, so a page ends on it
        // and the next page is asked for with its cursor
        expect(seen.indexOf(ids[key])).toBeLessThan(
          seen.indexOf(ids[`${key}-next`]),
        );
        expect(cursorAfter[ids[key]]).toEqual(expect.any(String));
      }
      // The worst case the bounds are derived from, reached through the
      // real admin route: 1498 characters of cursor, 360 units of name.
      expect(cursorAfter[ids.bytes]).toHaveLength(1498);
      expect(CURSOR_MAX_LENGTH).toBe(1498);
      expect(decodeCursor(cursorAfter[ids.units]).name).toHaveLength(360);
      expect(CURSOR_NAME_MAX_UNITS).toBe(360);
    });

    it('the name in a cursor may be as long as the admin allows, and no longer', async () => {
      const at = cur(WORST_UNITS.repeat(120), ids.units);
      const p = await page(`q=${PLACE}&limit=50&cursor=${at}`);
      expect(p.items.map((s) => s.id)).toContain(ids['units-next']);
      // 361 units: no name the admin accepts is that long
      const over = cur(`${WORST_UNITS.repeat(120)}a`, ids.units);
      const res = await get(`/schools?cursor=${over}`).expect(400);
      expect(message(res)).toBe(REFUSED_CURSOR);
    });

    it('a cursor longer than the longest one this server gives out is a 400', async () => {
      // 1080 bytes of name: the longest cursor, a clean name, accepted
      const longest = cur('\u0001'.repeat(180), ids.bytes);
      expect(longest).toHaveLength(1498);
      await get(`/schools?q=${PLACE}&cursor=${longest}`).expect(200);
      // one byte more: 1499 characters, refused before it is read
      const over = cur(`${'\u0001'.repeat(180)}a`, ids.bytes);
      expect(over).toHaveLength(1499);
      const res = await get(`/schools?cursor=${over}`).expect(400);
      expect(message(res)).toBe(
        'cursor must be shorter than or equal to 1498 characters',
      );
      expect(() => decodeCursor(over)).toThrow(BadRequestException);
      expect(() => decodeCursor(longest)).not.toThrow();
    });
  });

  it('only the exact text this server writes is a cursor: no re-encoding, no upper-case id', async () => {
    const s = await addSchool(`${PLACE} Cursor Text`);
    const name = `${PLACE} Cursor Text`;
    const id = 'abcdef12-3456-4789-8abc-def12345678f';
    await get(`/schools?q=${PLACE}&cursor=${cur(name, id)}`).expect(200);
    for (const forged of [
      raw(`["${name}", "${id}"]`), // a space the server never writes
      raw(`[ "${name}","${id}"]`),
      raw(`["\\u0053${name.slice(1)}","${id}"]`), // an escape for "S"
      cur(name, id.toUpperCase()), // the same id, upper case
      cur(name, `${id.slice(0, 35)}${id[35].toUpperCase()}`),
    ]) {
      const res = await get(`/schools?cursor=${forged}`).expect(400);
      expect(message(res)).toBe(REFUSED_CURSOR);
    }
    await prisma.school.delete({ where: { id: s.id } });
  });

  it('D3: two intakes on one day, the school page and the course page agree before and after edits', async () => {
    const s = await addSchool(`${PLACE} Same Day`);
    const c = await addCourse(s.id);
    const a = await addIntake(c.id, { capacity: 5 });
    const b = await addIntake(c.id, { capacity: 9 });
    const [low, high] = [a.id, b.id].sort();
    const agree = async () => {
      const intakes = data<{ intakes: Intake[] }>(
        await get(`/schools/courses/${c.id}`).expect(200),
      ).intakes;
      const next = data<{ courses: { nextIntake: Intake }[] }>(
        await get(`/schools/${s.id}`).expect(200),
      ).courses[0].nextIntake;
      expect(intakes.map((i) => i.id)).toEqual([low, high]);
      expect(next).toEqual(intakes[0]);
    };
    await agree();
    for (const [id, schedule] of [
      [low, 'Sundays'],
      [high, 'Mondays'],
      [low, 'Tuesdays'],
      [high, 'Fridays'],
    ]) {
      await admin('patch', `/school-intakes/${id}`, { schedule }).expect(200);
      await agree();
    }
  });

  it("a school's name matches the search in any case", async () => {
    const s = await addSchool(`${PLACE} Kudirat Lyceum`);
    await addCourse(s.id, { title: 'Pottery' });
    for (const q of ['kudirat lyceum', 'KUDIRAT LYCEUM', 'kUdIrAt']) {
      const p = await page(`q=${encodeURIComponent(q)}`);
      expect(p.items.map((i) => i.id)).toContain(s.id);
    }
  });

  it('matchedCourses names only the courses that match', async () => {
    const s = await addSchool(`${PLACE} Gamma Works`);
    await addCourse(s.id, { title: 'Accounting Basics' });
    await addCourse(s.id, { title: 'Brand Design' });
    await addCourse(s.id, { title: 'Welding' });
    const p = await page(`q=${encodeURIComponent('design')}&limit=50`);
    const card = p.items.find((i) => i.id === s.id);
    expect(card?.matchedCourses).toEqual(['Brand Design']);
  });

  it('matchedCourses lists courses in creation order, then id, whatever order the rows sit in', async () => {
    const s = await addSchool(`${PLACE} Order House`);
    const t0 = Date.UTC(2026, 0, 1);
    const at = (sec: number) => new Date(t0 + sec * 1000);
    // Inserted latest first, and the tie on createdAt with the higher id
    // first, so neither row order nor createdAt alone gives the answer.
    const rows: [string, number, string?][] = [
      ['Order Design D', 3],
      ['Order Design C', 2],
      ['Order Design B2', 1, '5c040403-0000-4000-8000-0000000000b2'],
      ['Order Design B1', 1, '5c040403-0000-4000-8000-0000000000b1'],
      ['Order Design A', 0],
    ];
    for (const [title, sec, id] of rows)
      await prisma.schoolCourse.create({
        data: {
          ...(id ? { id } : {}),
          schoolId: s.id,
          title,
          weeks: 4,
          mode: 'online',
          syllabus: ['a'],
          outcomes: ['b'],
          priceKobo: 1_000_000,
          createdAt: at(sec),
        },
      });
    const p = await page(`q=${encodeURIComponent('Order Design')}&limit=50`);
    expect(p.items.find((i) => i.id === s.id)?.matchedCourses).toEqual([
      'Order Design A',
      'Order Design B1',
      'Order Design B2',
    ]);
    const school = data<{ courses: { title: string }[] }>(
      await get(`/schools/${s.id}`).expect(200),
    );
    expect(school.courses.map((c) => c.title)).toEqual([
      'Order Design A',
      'Order Design B1',
      'Order Design B2',
      'Order Design C',
      'Order Design D',
    ]);
  });

  it('no public answer carries seatsTaken, hiddenAt or reportEmail', async () => {
    const s = await addSchool(`${PLACE} Seats Hall`);
    const c = await addCourse(s.id, { title: 'Seats Design' });
    const i = await addIntake(c.id, { capacity: 10 });
    await prisma.courseIntake.update({
      where: { id: i.id },
      data: { seatsTaken: 4 },
    });
    const answers = [
      await get(`/schools?q=${PLACE}&limit=50`).expect(200),
      await get(`/search?q=${PLACE}&tab=schools`).expect(200),
      await get(`/schools/${s.id}`).expect(200),
      await get(`/schools/courses/${c.id}`).expect(200),
    ];
    // the seats are read: 10 less 4 taken
    expect(data<{ intakes: Intake[] }>(answers[3]).intakes[0].seatsLeft).toBe(
      6,
    );
    for (const res of answers) {
      const keys = keysOf(res.body);
      for (const k of ['seatsTaken', 'hiddenAt', 'hidden', 'reportEmail'])
        expect([k, keys.has(k)]).toEqual([k, false]);
    }
  });

  it('the schools tab refuses an unsearchable term with the one sentence every tab uses (FIX-07)', async () => {
    const res = await get('/search?q=a%00b&tab=schools').expect(400);
    expect(res.text).toBe(
      JSON.stringify({
        statusCode: 400,
        message: UNSEARCHABLE_QUERY_MESSAGE,
        data: null,
      }),
    );
  });
});

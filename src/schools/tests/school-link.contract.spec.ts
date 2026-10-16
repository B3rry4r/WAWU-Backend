import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import * as linkHelpers from '../school-link';
import { LINK_CODE_ALPHABET, newLinkCode, trackedUrl } from '../school-link';
import { SchoolsPublicModule } from '../schools-public.module';

/**
 * SCHOOLS-10: "Apply on their site" (SC9). The link a school's course gives,
 * and the tap that records one click and answers with it. Rows are made for
 * the run (school names start with MARK) so the spec holds on a database
 * other suites have used.
 */
const MARK = 'S10spec';
const NONE = '00000000-0000-4000-8000-0000000000ff';
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const USER_EMAIL = 'user@test.wawu.dev';
const USER_SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER_SUB = '00000000-0000-4000-8000-000000000002';
/** Owns click rows and nothing else, for the purge and export checks. */
const GHOST_SUB = '00000000-0000-4000-8000-0000000510ff';
const CODE_SHAPE = /^wawu-[A-HJ-NP-Z2-9]{4}$/;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Apply on their site: the link and the recorded click (SCHOOLS-10)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let otherToken: string;
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const link = (courseId: string) =>
    http().get(`/api/hub/schools/courses/${courseId}/apply-link`);
  const tap = (courseId: string, token?: string) => {
    const r = http().post(`/api/hub/schools/courses/${courseId}/apply-click`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  type LinkView = { courseId: string; code: string; url: string };
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  const clicks = (where: object) => prisma.schoolLinkClick.count({ where });

  async function cleanUp() {
    // SchoolLink and SchoolLinkClick go with the school (cascade).
    await prisma.school.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.schoolLinkClick.deleteMany({
      where: { userWawuId: GHOST_SUB },
    });
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
  const course = (schoolId: string, title: string, extra: object = {}) =>
    prisma.schoolCourse.create({
      data: {
        schoolId,
        title,
        weeks: 12,
        mode: 'online',
        syllabus: ['One'],
        outcomes: ['Certificate'],
        priceKobo: 15_000_000,
        ...extra,
      },
    });

  beforeAll(async () => {
    [userToken, otherToken] = await Promise.all([
      login(USER_EMAIL),
      login(OTHER_EMAIL),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SchoolsPublicModule,
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
    await cleanUp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  describe('the code and the link (pure)', () => {
    it('a code is wawu- and four of the letters and digits that read clearly', () => {
      for (let i = 0; i < 500; i += 1) {
        expect(newLinkCode()).toMatch(CODE_SHAPE);
      }
      expect(LINK_CODE_ALPHABET).not.toMatch(/[01OI]/);
      expect(LINK_CODE_ALPHABET).toHaveLength(32);
    });

    it('adds ref to the address, keeps the rest, replaces a ref already there', () => {
      expect(trackedUrl('https://greenfield.ng/apply', 'wawu-7KQ2')).toBe(
        'https://greenfield.ng/apply?ref=wawu-7KQ2',
      );
      expect(
        trackedUrl('https://greenfield.ng/apply?src=x#form', 'wawu-7KQ2'),
      ).toBe('https://greenfield.ng/apply?src=x&ref=wawu-7KQ2#form');
      expect(
        trackedUrl('https://greenfield.ng/apply?ref=theirs', 'wawu-7KQ2'),
      ).toBe('https://greenfield.ng/apply?ref=wawu-7KQ2');
      expect(trackedUrl('http://greenfield.ng', 'wawu-7KQ2')).toBe(
        'http://greenfield.ng/?ref=wawu-7KQ2',
      );
    });

    it('refuses an address that is not a web address', () => {
      for (const bad of [
        'javascript:alert(1)',
        'ftp://greenfield.ng/apply',
        'data:text/html,hi',
        'greenfield.ng/apply',
        '',
        'not a url',
      ]) {
        expect(trackedUrl(bad, 'wawu-7KQ2')).toBeNull();
      }
    });
  });

  describe('GET /schools/courses/{id}/apply-link', () => {
    it('answers the school address with the WAWU code, to anyone, and records nothing', async () => {
      const s = await school('Greenfield');
      const c = await course(s.id, 'Product Design');
      const res = await link(c.id).expect(200);
      const v = data<LinkView>(res);
      expect(v.courseId).toBe(c.id);
      expect(v.code).toMatch(CODE_SHAPE);
      expect(v.url).toBe(`https://school.example.com/apply?ref=${v.code}`);
      expect(await clicks({ schoolId: s.id })).toBe(0);
      expect(
        await prisma.schoolLink.findUnique({ where: { schoolId: s.id } }),
      ).toMatchObject({ code: v.code });
    });

    it('gives a school one code, however many courses and however often it is asked', async () => {
      const s = await school('One code');
      const c1 = await course(s.id, 'Course one');
      const c2 = await course(s.id, 'Course two');
      const a = data<LinkView>(await link(c1.id).expect(200));
      const b = data<LinkView>(await link(c2.id).expect(200));
      const again = data<LinkView>(await link(c1.id).expect(200));
      expect(b.code).toBe(a.code);
      expect(again.code).toBe(a.code);
      expect(await prisma.schoolLink.count({ where: { schoolId: s.id } })).toBe(
        1,
      );
    });

    it('gives two schools two codes', async () => {
      const s1 = await school('Code A');
      const s2 = await school('Code B');
      const c1 = await course(s1.id, 'A course');
      const c2 = await course(s2.id, 'B course');
      const a = data<LinkView>(await link(c1.id).expect(200));
      const b = data<LinkView>(await link(c2.id).expect(200));
      expect(a.code).not.toBe(b.code);
    });

    it('makes one code when ten people ask at the same moment', async () => {
      const s = await school('Race');
      const c = await course(s.id, 'Race course');
      const all = await Promise.all(
        Array.from({ length: 10 }, () => link(c.id)),
      );
      const codes = new Set(all.map((r) => data<LinkView>(r).code));
      expect(all.every((r) => r.status === 200)).toBe(true);
      expect(codes.size).toBe(1);
      expect(await prisma.schoolLink.count({ where: { schoolId: s.id } })).toBe(
        1,
      );
    });

    it("tries another code when the one it drew is another school's", async () => {
      const taken = await school('Holds AAAA');
      await prisma.schoolLink.create({
        data: { schoolId: taken.id, code: 'wawu-AAAA' },
      });
      const s = await school('Collides');
      const c = await course(s.id, 'Collide course');
      const spy = jest
        .spyOn(linkHelpers, 'newLinkCode')
        .mockReturnValueOnce('wawu-AAAA')
        .mockReturnValueOnce('wawu-AAAA')
        .mockReturnValue('wawu-BBBB');
      const v = data<LinkView>(await link(c.id).expect(200));
      expect(v.code).toBe('wawu-BBBB');
      expect(spy).toHaveBeenCalledTimes(3);
      // The first school keeps its code.
      expect(
        (await prisma.schoolLink.findUnique({ where: { schoolId: taken.id } }))
          ?.code,
      ).toBe('wawu-AAAA');
    });

    it('keeps the query and the fragment the school already had', async () => {
      const s = await school('Has query', {
        applyUrl: 'https://school.example.com/apply?src=x#form',
      });
      const c = await course(s.id, 'Query course');
      const v = data<LinkView>(await link(c.id).expect(200));
      expect(v.url).toBe(
        `https://school.example.com/apply?src=x&ref=${v.code}#form`,
      );
    });

    it('is 404 for a course that is not there, hidden, or whose school or school address is not usable', async () => {
      const none = await link(NONE).expect(404);
      expect((none.body as { message: string }).message).toBe(
        'Course not found',
      );

      const s = await school('Hidden things');
      const shownCourse = await course(s.id, 'Shown');
      const hiddenCourse = await course(s.id, 'Hidden', {
        hiddenAt: new Date(),
      });
      await link(hiddenCourse.id).expect(404);
      await link(shownCourse.id).expect(200);
      await prisma.school.update({
        where: { id: s.id },
        data: { hiddenAt: new Date() },
      });
      await link(shownCourse.id).expect(404);

      const noUrl = await school('No address', { applyUrl: null });
      const c1 = await course(noUrl.id, 'No address course');
      const res = await link(c1.id).expect(404);
      expect((res.body as { message: string }).message).toBe(
        'This school does not take sign-ups on its own site',
      );
      for (const bad of ['javascript:alert(1)', 'ftp://x.example.com', 'abc']) {
        const b = await school(`Bad ${bad.slice(0, 4)}`, { applyUrl: bad });
        const c2 = await course(b.id, 'Bad course');
        await link(c2.id).expect(404);
        await tap(c2.id, userToken).expect(404);
        expect(await clicks({ schoolId: b.id })).toBe(0);
      }
    });

    it('is 400, not 500, for an id that is not an id', async () => {
      await http()
        .get('/api/hub/schools/courses/not-an-id/apply-link')
        .expect(400);
      await http().get('/api/hub/schools/courses/%00/apply-link').expect(400);
    });
  });

  describe('POST /schools/courses/{id}/apply-click', () => {
    it('records one click and lands on the school address with the WAWU code', async () => {
      const s = await school('Tapped');
      const c = await course(s.id, 'Tapped course');
      const before = Date.now();
      const res = await tap(c.id, userToken).expect(200);
      const v = data<LinkView>(res);
      expect(v.url).toBe(`https://school.example.com/apply?ref=${v.code}`);
      expect(v.code).toMatch(CODE_SHAPE);

      const rows = await prisma.schoolLinkClick.findMany({
        where: { schoolId: s.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        schoolId: s.id,
        courseId: c.id,
        userWawuId: USER_SUB,
      });
      expect(rows[0].clickedAt.getTime()).toBeGreaterThanOrEqual(before - 5000);
      expect(rows[0].clickedAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 5000,
      );

      // The link the sheet printed is the link the tap answers with.
      const printed = data<LinkView>(await link(c.id).expect(200));
      expect(printed).toEqual(v);
    });

    it('counts each tap, by each person, as its own click', async () => {
      const s = await school('Many taps');
      const c1 = await course(s.id, 'First');
      const c2 = await course(s.id, 'Second');
      await tap(c1.id, userToken).expect(200);
      await tap(c1.id, userToken).expect(200);
      await tap(c1.id, otherToken).expect(200);
      await tap(c2.id, userToken).expect(200);
      expect(await clicks({ courseId: c1.id, userWawuId: USER_SUB })).toBe(2);
      expect(await clicks({ courseId: c1.id, userWawuId: OTHER_SUB })).toBe(1);
      expect(await clicks({ courseId: c2.id })).toBe(1);
      expect(await clicks({ schoolId: s.id })).toBe(4);
    });

    it('needs an account: no token, a bad token and a link read all record nothing', async () => {
      const s = await school('Needs account');
      const c = await course(s.id, 'Needs account course');
      await tap(c.id).expect(401);
      await tap(c.id, 'not.a.token').expect(401);
      await link(c.id).expect(200);
      expect(await clicks({ schoolId: s.id })).toBe(0);
    });

    it('records nothing when the course is hidden, missing or the id is bad', async () => {
      const s = await school('No record');
      const hidden = await course(s.id, 'Hidden', { hiddenAt: new Date() });
      await tap(hidden.id, userToken).expect(404);
      await tap(NONE, userToken).expect(404);
      await http()
        .post('/api/hub/schools/courses/not-an-id/apply-click')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
      expect(await clicks({ schoolId: s.id })).toBe(0);
    });

    it('puts nothing about the person in the link', async () => {
      const s = await school('No person');
      const c = await course(s.id, 'No person course');
      const res = await tap(c.id, userToken).expect(200);
      const v = data<LinkView>(res);
      const url = new URL(v.url);
      expect([...url.searchParams.keys()]).toEqual(['ref']);
      expect(url.searchParams.get('ref')).toBe(v.code);
      expect(url.hash).toBe('');
      const everything = JSON.stringify(res.body).toLowerCase();
      expect(everything).not.toContain(USER_SUB);
      expect(everything).not.toContain('test.wawu.dev');
      expect(Object.keys(v).sort()).toEqual(['code', 'courseId', 'url']);
    });

    it('keeps the click and drops the course when the course is removed', async () => {
      const s = await school('Course removed');
      const c = await course(s.id, 'Soon gone');
      await tap(c.id, userToken).expect(200);
      await prisma.schoolCourse.delete({ where: { id: c.id } });
      const rows = await prisma.schoolLinkClick.findMany({
        where: { schoolId: s.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].courseId).toBeNull();
    });
  });

  describe("the person's data (purge and export)", () => {
    it("a deleted account loses its clicks and nobody else's, and the export lists them", async () => {
      const s = await school('Purge');
      const c = await course(s.id, 'Purge course');
      await prisma.schoolLinkClick.createMany({
        data: [
          { schoolId: s.id, courseId: c.id, userWawuId: GHOST_SUB },
          { schoolId: s.id, courseId: c.id, userWawuId: GHOST_SUB },
          { schoolId: s.id, courseId: c.id, userWawuId: OTHER_SUB },
        ],
      });

      const section = EXPORT_SECTIONS.find((x) => x.key === 'schoolLinkClicks');
      expect(section?.models).toEqual(['SchoolLinkClick']);
      const exported = (await section?.load(prisma, GHOST_SUB)) as Array<{
        schoolId: string;
        courseId: string;
      }>;
      expect(exported).toHaveLength(2);
      expect(exported[0]).toMatchObject({ schoolId: s.id, courseId: c.id });
      expect(Object.keys(exported[0]).sort()).toEqual([
        'clickedAt',
        'courseId',
        'schoolId',
      ]);

      const out = await new AccountPurgeService(prisma).purge(GHOST_SUB);
      expect(out.deleted['SchoolLinkClick.userWawuId']).toBe(2);
      expect(await clicks({ userWawuId: GHOST_SUB })).toBe(0);
      expect(await clicks({ userWawuId: OTHER_SUB, schoolId: s.id })).toBe(1);
      // The school's code needs no person and stays.
      await link(c.id).expect(200);
      expect(await prisma.schoolLink.count({ where: { schoolId: s.id } })).toBe(
        1,
      );
    });
  });
});

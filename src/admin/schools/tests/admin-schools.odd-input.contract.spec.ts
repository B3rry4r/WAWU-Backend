import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminSchoolsModule } from '../admin-schools.module';

/**
 * SCHOOLS-02 fix round 3: input Postgres or the validator library cannot take
 * is a 400 naming the field, never a 500 (a NUL, a lone UTF-16 surrogate, a
 * body that is not an object), on create and on edit at all three levels, and
 * nothing is written by a refused request.
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const SUPER_ID = 'ad020300-0000-4000-8000-000000000001';
const REVIEWER_ID = 'ad020300-0000-4000-8000-000000000002';
const SUPPORT_ID = 'ad020300-0000-4000-8000-000000000003';
const FINANCE_ID = 'ad020300-0000-4000-8000-000000000004';
const ADMINS = [
  [SUPER_ID, 'superadmin'],
  [REVIEWER_ID, 'reviewer'],
  [SUPPORT_ID, 'support'],
  [FINANCE_ID, 'finance'],
] as const;
const email = (role: string) => `s0203-${role}@admin.test.wawu.dev`;
const PASSWORD = 'schools-admin-contract-password';
const MARK = 'SCHOOLS-02 r3 spec';
const KEYS = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];

const SCHOOL = {
  name: `${MARK} Academy`,
  category: 'tech',
  location: 'Yaba, Lagos',
  foundedYear: 2016,
  expertise: ['Product design', 'Software'],
  about: 'A school this spec creates and removes.',
  logo: 'https://cdn.example.com/logo.png',
  applyUrl: 'https://school.example.com/apply',
  reportEmail: 'enrolments@school.example.com',
};
const COURSE = {
  title: 'Product Design',
  weeks: 12,
  mode: 'hybrid',
  syllabus: ['Research', 'Wireframes', 'Prototypes'],
  outcomes: ['Certificate', 'Portfolio'],
  priceKobo: 21_500_000,
};
const INTAKE = {
  startDate: '2026-11-03',
  schedule: 'Saturdays',
  location: 'Yaba',
  capacity: 20,
};

const BAD = {
  nul: 'a\u0000b',
  hiSurrogate: 'a\ud800b',
  loSurrogate: 'a\udc00b',
};

describe('Admin schools odd input (SCHOOLS-02 round 3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const snapshot: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function cleanUp(): Promise<void> {
    await prisma.school.deleteMany({ where: { name: { startsWith: MARK } } });
  }
  const counts = async () =>
    JSON.stringify([
      await prisma.school.count({ where: { name: { startsWith: MARK } } }),
      await prisma.schoolCourse.count(),
      await prisma.courseIntake.count(),
    ]);

  beforeAll(async () => {
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'schools-access-secret-0123456789abcdef01';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'schools-refresh-secret-0123456789abcdef0';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminSchoolsModule,
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
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({
      where: { id: { in: ADMINS.map((a) => a[0]) } },
    });
    await prisma.adminUser.createMany({
      data: ADMINS.map(([id, role]) => ({
        id,
        email: email(role),
        passwordHash,
        name: `S0203 ${role}`,
        role,
      })),
    });
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: email('superadmin'), password: PASSWORD })
      .expect(200);
    token = res.body.data.accessToken as string;
    await cleanUp();
  }, 60_000);

  afterAll(async () => {
    await cleanUp();
    await prisma.adminUser.deleteMany({
      where: { id: { in: ADMINS.map((a) => a[0]) } },
    });
    await app.close();
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  async function make() {
    const school = (
      await http()
        .post('/api/hub/admin/schools')
        .set(auth())
        .send(SCHOOL)
        .expect(201)
    ).body.data;
    const course = (
      await http()
        .post(`/api/hub/admin/schools/${school.id}/courses`)
        .set(auth())
        .send(COURSE)
        .expect(201)
    ).body.data;
    const intake = (
      await http()
        .post(`/api/hub/admin/school-courses/${course.id}/intakes`)
        .set(auth())
        .send(INTAKE)
        .expect(201)
    ).body.data;
    return { school, course, intake };
  }

  /** Every string field on the three levels, create and edit. */
  const STRING_FIELDS: [string, 'school' | 'course' | 'intake', string][] = [
    ['name', 'school', 'name'],
    ['location', 'school', 'location'],
    ['about', 'school', 'about'],
    ['logo', 'school', 'logo'],
    ['applyUrl', 'school', 'applyUrl'],
    ['reportEmail', 'school', 'reportEmail'],
    ['expertise', 'school', 'expertise'],
    ['title', 'course', 'title'],
    ['syllabus', 'course', 'syllabus'],
    ['outcomes', 'course', 'outcomes'],
    ['schedule', 'intake', 'schedule'],
    ['location', 'intake', 'location'],
    ['startDate', 'intake', 'startDate'],
    ['category', 'school', 'category'],
    ['mode', 'course', 'mode'],
  ];
  const LISTS = ['expertise', 'syllabus', 'outcomes'];

  for (const [badName, bad] of Object.entries(BAD)) {
    it(`a ${badName} in any string field is a 400 naming the field, on create and edit, and nothing is written`, async () => {
      const { school, course, intake } = await make();
      const before = await counts();
      const base = { school: SCHOOL, course: COURSE, intake: INTAKE };
      const create = {
        school: '/api/hub/admin/schools',
        course: `/api/hub/admin/schools/${school.id}/courses`,
        intake: `/api/hub/admin/school-courses/${course.id}/intakes`,
      };
      const edit = {
        school: `/api/hub/admin/schools/${school.id}`,
        course: `/api/hub/admin/school-courses/${course.id}`,
        intake: `/api/hub/admin/school-intakes/${intake.id}`,
      };
      const readBefore = JSON.stringify(
        (await http().get(edit.school).set(auth())).body.data,
      );
      for (const [field, level] of STRING_FIELDS) {
        let value: string | string[] = bad;
        if (field === 'logo' || field === 'applyUrl')
          value = `https://e.com/${bad}x`;
        if (field === 'reportEmail') value = `${bad}@c.co`;
        if (LISTS.includes(field)) value = [bad];
        const body = { ...base[level], [field]: value };
        const made = await http().post(create[level]).set(auth()).send(body);
        expect([field, level, 'create', made.status]).toEqual([
          field,
          level,
          'create',
          400,
        ]);
        expect(JSON.stringify(made.body)).toContain(field);
        const patched = await http()
          .patch(edit[level])
          .set(auth())
          .send({ [field]: value });
        expect([field, level, 'edit', patched.status]).toEqual([
          field,
          level,
          'edit',
          400,
        ]);
        expect(JSON.stringify(patched.body)).toContain(field);
      }
      expect(await counts()).toBe(before);
      expect(
        JSON.stringify((await http().get(edit.school).set(auth())).body.data),
      ).toBe(readBefore);
    });
  }

  it('a lone surrogate or NUL in reportEmail is 400, never a URIError 500', async () => {
    const { school } = await make();
    for (const v of [
      'a\ud800b@c.co',
      '\udc00@b.co',
      'a@b\ud800.co',
      'a@b\u0000.co',
    ]) {
      await http()
        .post('/api/hub/admin/schools')
        .set(auth())
        .send({ ...SCHOOL, reportEmail: v })
        .expect(400);
      await http()
        .patch(`/api/hub/admin/schools/${school.id}`)
        .set(auth())
        .send({ reportEmail: v })
        .expect(400);
    }
  });

  it('a body that is not an object is 400 on every write route and changes nothing', async () => {
    const { school, course, intake } = await make();
    const updatedAt = async () =>
      JSON.stringify([
        (await prisma.school.findUnique({ where: { id: school.id } }))
          ?.updatedAt,
        (await prisma.schoolCourse.findUnique({ where: { id: course.id } }))
          ?.updatedAt,
        (await prisma.courseIntake.findUnique({ where: { id: intake.id } }))
          ?.updatedAt,
      ]);
    const before = await updatedAt();
    const routes: [string, string][] = [
      ['patch', `/api/hub/admin/schools/${school.id}`],
      ['patch', `/api/hub/admin/school-courses/${course.id}`],
      ['patch', `/api/hub/admin/school-intakes/${intake.id}`],
      ['post', '/api/hub/admin/schools'],
      ['post', `/api/hub/admin/schools/${school.id}/courses`],
      ['post', `/api/hub/admin/school-courses/${course.id}/intakes`],
    ];
    for (const [method, url] of routes) {
      for (const raw of [
        '[]',
        '[{}]',
        '[1]',
        '[[]]',
        'null',
        '7',
        '"x"',
        'true',
      ]) {
        const res = await http()
          [method as 'patch' | 'post'](url)
          .set(auth())
          .set('Content-Type', 'application/json')
          .send(raw);
        expect([method, url, raw, res.status]).toEqual([method, url, raw, 400]);
      }
    }
    expect(await updatedAt()).toBe(before);
  });
});

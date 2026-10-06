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
 * SCHOOLS-02: the dashboard's school routes. Proves an admin can add a school
 * with a course and an intake and read it back, that every field the model
 * has is written and read, that hiding and showing work at each level, that
 * the seats already taken bound the capacity, that bad input is refused, and
 * that a user token (and each role the matrix excludes) is refused on every
 * route.
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const SUPER_ID = 'ad020200-0000-4000-8000-000000000001';
const REVIEWER_ID = 'ad020200-0000-4000-8000-000000000002';
const SUPPORT_ID = 'ad020200-0000-4000-8000-000000000003';
const FINANCE_ID = 'ad020200-0000-4000-8000-000000000004';
const ADMINS = [
  [SUPER_ID, 'superadmin'],
  [REVIEWER_ID, 'reviewer'],
  [SUPPORT_ID, 'support'],
  [FINANCE_ID, 'finance'],
] as const;
const email = (role: string) => `s0202-${role}@admin.test.wawu.dev`;
const PASSWORD = 'schools-admin-contract-password';
const MARK = 'SCHOOLS-02 spec';
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

describe('Admin schools contract (SCHOOLS-02)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  let userToken: string;
  const snapshot: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

  async function login(role: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: email(role), password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function cleanUp(): Promise<void> {
    await prisma.school.deleteMany({ where: { name: { startsWith: MARK } } });
  }

  async function addSchool() {
    const res = await http()
      .post('/api/hub/admin/schools')
      .set(as('superadmin'))
      .send(SCHOOL)
      .expect(201);
    const school = res.body.data;
    const course = (
      await http()
        .post(`/api/hub/admin/schools/${school.id}/courses`)
        .set(as('superadmin'))
        .send(COURSE)
        .expect(201)
    ).body.data;
    const intake = (
      await http()
        .post(`/api/hub/admin/school-courses/${course.id}/intakes`)
        .set(as('superadmin'))
        .send(INTAKE)
        .expect(201)
    ).body.data;
    return { school, course, intake };
  }

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
        name: `S0202 ${role}`,
        role,
      })),
    });
    for (const [, role] of ADMINS) tokens[role] = await login(role);
    const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
    });
    userToken = ((await res.json()) as { accessToken: string }).accessToken;
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

  it('an admin can add a school with a course and an intake and read it back from the admin route', async () => {
    const { school, course, intake } = await addSchool();
    const read = (
      await http()
        .get(`/api/hub/admin/schools/${school.id}`)
        .set(as('superadmin'))
        .expect(200)
    ).body.data;
    expect(read).toMatchObject({ ...SCHOOL, hidden: false, id: school.id });
    expect(read.courses).toHaveLength(1);
    expect(read.courses[0]).toMatchObject({
      ...COURSE,
      id: course.id,
      schoolId: school.id,
      hidden: false,
    });
    expect(read.courses[0].intakes).toEqual([
      expect.objectContaining({
        ...INTAKE,
        id: intake.id,
        courseId: course.id,
        seatsTaken: 0,
        hidden: false,
      }),
    ]);
    const list = (
      await http()
        .get('/api/hub/admin/schools?category=tech&limit=100')
        .set(as('support'))
        .expect(200)
    ).body.data;
    expect(
      list.items.find((s: { id: string }) => s.id === school.id),
    ).toMatchObject({
      name: SCHOOL.name,
      courseCount: 1,
      hidden: false,
    });
  });

  it('an admin can edit every field of a school, a course and an intake', async () => {
    const { school, course, intake } = await addSchool();
    const s = (
      await http()
        .patch(`/api/hub/admin/schools/${school.id}`)
        .set(as('reviewer'))
        .send({
          name: `${MARK} Renamed`,
          category: 'creative',
          location: 'Lekki, Lagos',
          foundedYear: null,
          expertise: ['Brand'],
          about: 'New blurb.',
          logo: null,
          applyUrl: '',
          reportEmail: 'new@school.example.com',
        })
        .expect(200)
    ).body.data;
    expect(s).toMatchObject({
      name: `${MARK} Renamed`,
      category: 'creative',
      location: 'Lekki, Lagos',
      foundedYear: null,
      expertise: ['Brand'],
      about: 'New blurb.',
      logo: null,
      applyUrl: null,
      reportEmail: 'new@school.example.com',
    });
    const c = (
      await http()
        .patch(`/api/hub/admin/school-courses/${course.id}`)
        .set(as('reviewer'))
        .send({
          title: 'Brand Design',
          weeks: 8,
          mode: 'online',
          syllabus: ['One'],
          outcomes: [],
          priceKobo: 0,
        })
        .expect(200)
    ).body.data;
    expect(c).toMatchObject({
      title: 'Brand Design',
      weeks: 8,
      mode: 'online',
      syllabus: ['One'],
      outcomes: [],
      priceKobo: 0,
    });
    const i = (
      await http()
        .patch(`/api/hub/admin/school-intakes/${intake.id}`)
        .set(as('reviewer'))
        .send({
          startDate: '2026-12-01',
          schedule: 'Weekdays',
          location: null,
          capacity: 30,
        })
        .expect(200)
    ).body.data;
    expect(i).toMatchObject({
      startDate: '2026-12-01',
      schedule: 'Weekdays',
      location: null,
      capacity: 30,
    });
  });

  it('an admin can hide and show a school, a course and an intake, and filter by hidden', async () => {
    const { school, course, intake } = await addSchool();
    const patch = (path: string, body: object) =>
      http()
        .patch(`/api/hub/admin/${path}`)
        .set(as('superadmin'))
        .send(body)
        .expect(200);
    await patch(`school-intakes/${intake.id}`, { hidden: true });
    await patch(`school-courses/${course.id}`, { hidden: true });
    await patch(`schools/${school.id}`, { hidden: true });
    const hiddenRead = (
      await http()
        .get(`/api/hub/admin/schools/${school.id}`)
        .set(as('superadmin'))
        .expect(200)
    ).body.data;
    expect(hiddenRead.hidden).toBe(true);
    expect(hiddenRead.courses[0].hidden).toBe(true);
    expect(hiddenRead.courses[0].intakes[0].hidden).toBe(true);
    const onlyHidden = (
      await http()
        .get('/api/hub/admin/schools?hidden=true&limit=100')
        .set(as('superadmin'))
        .expect(200)
    ).body.data.items.map((x: { id: string }) => x.id);
    const onlyShown = (
      await http()
        .get('/api/hub/admin/schools?hidden=false&limit=100')
        .set(as('superadmin'))
        .expect(200)
    ).body.data.items.map((x: { id: string }) => x.id);
    expect(onlyHidden).toContain(school.id);
    expect(onlyShown).not.toContain(school.id);
    await patch(`schools/${school.id}`, { hidden: false });
    expect(
      (
        await http()
          .get(`/api/hub/admin/schools/${school.id}`)
          .set(as('superadmin'))
          .expect(200)
      ).body.data.hidden,
    ).toBe(false);
    // a edit that does not say `hidden` leaves it alone
    await patch(`school-courses/${course.id}`, { title: 'Still hidden' });
    expect(
      (
        await http()
          .get(`/api/hub/admin/school-courses/${course.id}`)
          .set(as('superadmin'))
          .expect(200)
      ).body.data.hidden,
    ).toBe(true);
  });

  it('refuses a capacity below the seats already taken and leaves the intake as it was', async () => {
    const { intake } = await addSchool();
    await prisma.courseIntake.update({
      where: { id: intake.id },
      data: { seatsTaken: 7 },
    });
    const refused = await http()
      .patch(`/api/hub/admin/school-intakes/${intake.id}`)
      .set(as('superadmin'))
      .send({ capacity: 6, schedule: 'Changed' })
      .expect(409);
    expect(JSON.stringify(refused.body)).not.toContain('—');
    const same = (
      await http()
        .get(`/api/hub/admin/school-intakes/${intake.id}`)
        .set(as('superadmin'))
        .expect(200)
    ).body.data;
    expect(same).toMatchObject({
      capacity: 20,
      seatsTaken: 7,
      schedule: 'Saturdays',
    });
    await http()
      .patch(`/api/hub/admin/school-intakes/${intake.id}`)
      .set(as('superadmin'))
      .send({ capacity: 7 })
      .expect(200);
    // seatsTaken is not writable from here
    await http()
      .patch(`/api/hub/admin/school-intakes/${intake.id}`)
      .set(as('superadmin'))
      .send({ seatsTaken: 0 })
      .expect(400);
  });

  it('refuses bad input and unknown ids', async () => {
    const post = (path: string, body: object) =>
      http().post(`/api/hub/admin/${path}`).set(as('superadmin')).send(body);
    await post('schools', { ...SCHOOL, category: 'arts' }).expect(400);
    await post('schools', { ...SCHOOL, name: '   ' }).expect(400);
    await post('schools', { ...SCHOOL, reportEmail: 'nope' }).expect(400);
    await post('schools', {
      ...SCHOOL,
      applyUrl: 'http://insecure.example.com',
    }).expect(400);
    await post('schools', { ...SCHOOL, foundedYear: 1500 }).expect(400);
    await post('schools', { ...SCHOOL, rating: 5 }).expect(400);
    const { school, course } = await addSchool();
    await post(`schools/${school.id}/courses`, { ...COURSE, weeks: 0 }).expect(
      400,
    );
    await post(`schools/${school.id}/courses`, {
      ...COURSE,
      priceKobo: -1,
    }).expect(400);
    await post(`schools/${school.id}/courses`, {
      ...COURSE,
      priceKobo: 10.5,
    }).expect(400);
    await post(`schools/${school.id}/courses`, {
      ...COURSE,
      mode: 'remote',
    }).expect(400);
    await post(`school-courses/${course.id}/intakes`, {
      ...INTAKE,
      startDate: '2026-02-30',
    }).expect(400);
    await post(`school-courses/${course.id}/intakes`, {
      ...INTAKE,
      capacity: 0,
    }).expect(400);
    const ghost = '5c020200-0000-4000-8000-00000000dead';
    await post(`schools/${ghost}/courses`, COURSE).expect(404);
    await post(`school-courses/${ghost}/intakes`, INTAKE).expect(404);
    await http()
      .get(`/api/hub/admin/schools/${ghost}`)
      .set(as('superadmin'))
      .expect(404);
    await http()
      .patch(`/api/hub/admin/school-intakes/${ghost}`)
      .set(as('superadmin'))
      .send({ schedule: 'x' })
      .expect(404);
    await http()
      .get('/api/hub/admin/schools/not-a-uuid')
      .set(as('superadmin'))
      .expect(400);
  });

  it('pages the list with a cursor', async () => {
    await addSchool();
    await addSchool();
    const first = (
      await http()
        .get('/api/hub/admin/schools?limit=1')
        .set(as('superadmin'))
        .expect(200)
    ).body.data;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0].id);
    const second = (
      await http()
        .get(`/api/hub/admin/schools?limit=1&cursor=${first.nextCursor}`)
        .set(as('superadmin'))
        .expect(200)
    ).body.data;
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  describe('who may call', () => {
    const ID = '5c020200-0000-4000-8000-000000000001';
    const routes: [string, string, object | undefined][] = [
      ['get', '/api/hub/admin/schools', undefined],
      ['get', `/api/hub/admin/schools/${ID}`, undefined],
      ['post', '/api/hub/admin/schools', SCHOOL],
      ['patch', `/api/hub/admin/schools/${ID}`, { hidden: true }],
      ['post', `/api/hub/admin/schools/${ID}/courses`, COURSE],
      ['get', `/api/hub/admin/school-courses/${ID}`, undefined],
      ['patch', `/api/hub/admin/school-courses/${ID}`, { hidden: true }],
      ['post', `/api/hub/admin/school-courses/${ID}/intakes`, INTAKE],
      ['get', `/api/hub/admin/school-intakes/${ID}`, undefined],
      ['patch', `/api/hub/admin/school-intakes/${ID}`, { hidden: true }],
    ];
    const call = (
      m: string,
      url: string,
      body: object | undefined,
      auth?: string,
    ) => {
      const r = (
        http() as unknown as Record<string, (u: string) => request.Test>
      )[m](url);
      if (auth) r.set('Authorization', `Bearer ${auth}`);
      return body ? r.send(body) : r;
    };

    it.each(routes)(
      'a user token is refused on %s %s',
      async (m, url, body) => {
        await call(m, url, body, userToken).expect(401);
      },
    );
    it.each(routes)('no token is refused on %s %s', async (m, url, body) => {
      await call(m, url, body).expect(401);
    });
    it.each(routes)('finance is refused on %s %s', async (m, url, body) => {
      await call(m, url, body, tokens.finance).expect(403);
    });
    it.each(routes.filter(([m]) => m !== 'get'))(
      'support cannot write on %s %s',
      async (m, url, body) => {
        await call(m, url, body, tokens.support).expect(403);
      },
    );
  });
});

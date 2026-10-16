import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { hasControlCharacter } from '../../../schools/school-admin.dto';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminSchoolsModule } from '../admin-schools.module';

/**
 * FIX-19. A school's `name` and a course's `title` refuse every C0 control
 * (U+0001 to U+001F), DEL (U+007F) and every C1 control (U+0080 to U+009F),
 * on create and on edit: 400 naming the field, nothing saved. Real names
 * (accents, Arabic, Chinese, emoji, combining marks) still go through.
 */
const ADMIN_ID = 'ad190000-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'fix19-superadmin@admin.test.wawu.dev';
const PASSWORD = 'fix-19-control-chars-password';
const MARK = 'FIX-19 spec';
const KEYS = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'];

const SCHOOL = {
  name: `${MARK} Academy`,
  category: 'tech',
  location: 'Yaba, Lagos',
  expertise: ['Product design'],
  about: 'A school this spec creates and removes.',
  reportEmail: 'enrolments@school.example.com',
};
const COURSE = {
  title: 'Product Design',
  weeks: 12,
  mode: 'hybrid',
  syllabus: ['Research'],
  outcomes: ['Certificate'],
  priceKobo: 21_500_000,
};

const NAME_FIELDS = [
  ['school', 'name'],
  ['course', 'title'],
] as const;

/** The code points of a range, as strings. */
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    String.fromCharCode(from + i),
  );
type Body = { data: { id: string } & Record<string, unknown>; message: string };
const bodyOf = (res: { body: unknown }) => res.body as Body;
const hex = (c: string) =>
  `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

const C0 = range(0x01, 0x1f);
const DEL = ['\u007f'];
const C1 = range(0x80, 0x9f);

/** Real names a person writes. None holds a control character. */
const REAL_NAMES = [
  'École Supérieure de Création',
  'Ọ̀rọ̀ Academy Ìbàdàn',
  'مدرسة التصميم الرقمي',
  '设计学院 Design 学院',
  'Design 🎨 School 👩🏾‍💻 🏳️‍🌈',
  'São Paulo Ünal Zoë Ångström',
  'Space Inside',
  'Non Breaking Space',
  'Soft­Hyphen',
  'Line Separator',
  'Zero​Width',
];

describe('Admin schools: names refuse control characters (FIX-19)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const snapshot: Record<string, string | undefined> = {};
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function cleanUp(): Promise<void> {
    await prisma.school.deleteMany({ where: { location: MARK } });
  }
  const counts = async () =>
    JSON.stringify([
      await prisma.school.count({ where: { location: MARK } }),
      await prisma.schoolCourse.count({
        where: { school: { location: MARK } },
      }),
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
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.adminUser.create({
      data: {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        passwordHash,
        name: 'FIX19 superadmin',
        role: 'superadmin',
      },
    });
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
    token = bodyOf(res).data.accessToken as string;
    await cleanUp();
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

  // Each test starts from the same school and course, marked by its location.
  const school = (over: object = {}) => ({
    ...SCHOOL,
    location: MARK,
    ...over,
  });
  const post = async (url: string, body: object) =>
    bodyOf(await http().post(url).set(auth()).send(body).expect(201)).data;
  async function make() {
    const s = await post('/api/hub/admin/schools', school());
    const c = await post(`/api/hub/admin/schools/${s.id}/courses`, COURSE);
    return { s, c };
  }

  describe('the check itself', () => {
    it('is true for each code point of the three ranges and false just outside them', () => {
      for (const c of [...C0, ...DEL, ...C1])
        expect([hex(c), hasControlCharacter(`a${c}b`)]).toEqual([hex(c), true]);
      // NUL has its own check and message (IsCleanText); the space, the
      // printable ASCII range and U+00A0 onward are not controls.
      for (const c of [
        '\u0000',
        ...range(0x20, 0x7e),
        ...range(0xa0, 0xff),
        '​',
        ' ',
        '﻿',
      ])
        expect([hex(c), hasControlCharacter(`a${c}b`)]).toEqual([
          hex(c),
          false,
        ]);
      expect(hasControlCharacter(undefined)).toBe(false);
      expect(hasControlCharacter(7)).toBe(false);
    });
  });

  describe.each(NAME_FIELDS)('%s %s', (level, field) => {
    // Each range, by its first and last code point, a middle one, and the
    // controls a person pastes in: tab, line breaks, escape.
    const SAMPLES: [string, string][] = [
      ['C0 first', '\u0001'],
      ['C0 backspace', '\u0008'],
      ['C0 tab', '\u0009'],
      ['C0 line feed', '\u000a'],
      ['C0 vertical tab', '\u000b'],
      ['C0 carriage return', '\u000d'],
      ['C0 escape', '\u001b'],
      ['C0 last', '\u001f'],
      ['DEL', '\u007f'],
      ['C1 first', '\u0080'],
      ['C1 next line', '\u0085'],
      ['C1 last', '\u009f'],
    ];
    const placements: [string, (c: string) => string][] = [
      ['inside', (c) => `Ab${c}cd`],
      ['at the start', (c) => `${c}Abcd`],
      ['at the end', (c) => `Abcd${c}`],
      ['alone', (c) => c],
    ];

    it('refuses every control character on create: 400 naming the field, nothing saved', async () => {
      const { s } = await make();
      const before = await counts();
      for (const [label, c] of SAMPLES) {
        for (const [where, put] of placements) {
          const value = put(c);
          const body =
            level === 'school'
              ? school({ [field]: value })
              : { ...COURSE, [field]: value };
          const url =
            level === 'school'
              ? '/api/hub/admin/schools'
              : `/api/hub/admin/schools/${s.id}/courses`;
          const res = await http().post(url).set(auth()).send(body);
          expect([label, where, res.status]).toEqual([label, where, 400]);
          expect(JSON.stringify(bodyOf(res))).toContain(field);
        }
      }
      expect(await counts()).toBe(before);
    });

    it('refuses every control character on edit: 400 naming the field, the row unchanged', async () => {
      const { s, c } = await make();
      const url =
        level === 'school'
          ? `/api/hub/admin/schools/${s.id}`
          : `/api/hub/admin/school-courses/${c.id}`;
      const read = async () =>
        JSON.stringify(
          level === 'school'
            ? await prisma.school.findUnique({ where: { id: s.id } })
            : await prisma.schoolCourse.findUnique({ where: { id: c.id } }),
        );
      const before = await read();
      for (const [label, ch] of SAMPLES) {
        for (const [where, put] of placements) {
          const res = await http()
            .patch(url)
            .set(auth())
            .send({ [field]: put(ch) });
          expect([label, where, res.status]).toEqual([label, where, 400]);
          expect(JSON.stringify(bodyOf(res))).toContain(field);
        }
      }
      expect(await read()).toBe(before);
    });

    it('names the field in its message, and a NUL keeps its own message', async () => {
      const { s, c } = await make();
      const url =
        level === 'school'
          ? `/api/hub/admin/schools/${s.id}`
          : `/api/hub/admin/school-courses/${c.id}`;
      const control = await http()
        .patch(url)
        .set(auth())
        .send({ [field]: 'Ab\u0007cd' })
        .expect(400);
      expect(bodyOf(control).message).toBe(
        `${field} must not contain control characters`,
      );
      const nul = await http()
        .patch(url)
        .set(auth())
        .send({ [field]: 'Ab\u0000cd' })
        .expect(400);
      expect(bodyOf(nul).message).toBe(
        `${field} must have text in it, with no null characters or broken characters`,
      );
    });

    it('still takes real names, on create and on edit, and reads them back as sent', async () => {
      const { s, c } = await make();
      for (const name of REAL_NAMES) {
        const createUrl =
          level === 'school'
            ? '/api/hub/admin/schools'
            : `/api/hub/admin/schools/${s.id}/courses`;
        const made = await http()
          .post(createUrl)
          .set(auth())
          .send(
            level === 'school'
              ? school({ [field]: name })
              : { ...COURSE, [field]: name },
          )
          .expect(201);
        expect(bodyOf(made).data[field]).toBe(name);
        const editUrl =
          level === 'school'
            ? `/api/hub/admin/schools/${s.id}`
            : `/api/hub/admin/school-courses/${c.id}`;
        const edited = await http()
          .patch(editUrl)
          .set(auth())
          .send({ [field]: name })
          .expect(200);
        expect(bodyOf(edited).data[field]).toBe(name);
      }
    });

    it('still trims ordinary spaces around a name', async () => {
      const { s, c } = await make();
      const url =
        level === 'school'
          ? `/api/hub/admin/schools/${s.id}`
          : `/api/hub/admin/school-courses/${c.id}`;
      const res = await http()
        .patch(url)
        .set(auth())
        .send({ [field]: '   Padded Name   ' })
        .expect(200);
      expect(bodyOf(res).data[field]).toBe('Padded Name');
    });
  });

  it('leaves the other text fields as they were: a line break in the about text is still fine', async () => {
    const { s } = await make();
    const res = await http()
      .patch(`/api/hub/admin/schools/${s.id}`)
      .set(auth())
      .send({ about: 'First paragraph.\n\nSecond paragraph.' })
      .expect(200);
    expect(bodyOf(res).data.about).toBe(
      'First paragraph.\n\nSecond paragraph.',
    );
  });
});

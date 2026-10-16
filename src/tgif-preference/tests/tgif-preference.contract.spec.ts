import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { TgifPreferenceModule } from '../tgif-preference.module';

/**
 * HOME-11: GET and PATCH /settings/tgif. Real RS256 tokens from the local mock
 * WAWU ID, the real database. Each login is a separate token for the same
 * account, which is what "another device" is to the API.
 */

const MOCK_WAWU_ID_URL = 'http://localhost:4001';
const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  return ((await res.json()) as { accessToken: string }).accessToken;
}

type Shown = { show: boolean };
const shown = (res: { body: unknown }): Shown => {
  const b = res.body as { data?: Shown } & Shown;
  return b.data ?? b;
};

describe('TGIF preference (HOME-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let phone: string;
  let browser: string;
  let other: string;

  const get = (t: string) =>
    request(app.getHttpServer())
      .get('/api/hub/settings/tgif')
      .set('Authorization', `Bearer ${t}`);
  const patch = (t: string, body: unknown) =>
    request(app.getHttpServer())
      .patch('/api/hub/settings/tgif')
      .set('Authorization', `Bearer ${t}`)
      .send(body as object);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        TgifPreferenceModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    phone = await loginAs('user@test.wawu.dev');
    browser = await loginAs('user@test.wawu.dev');
    other = await loginAs('creator-basic@test.wawu.dev');
  });

  beforeEach(async () => {
    await prisma.tgifPreference.deleteMany({
      where: { userWawuId: { in: [USER_A, USER_B] } },
    });
  });

  afterAll(async () => {
    await prisma.tgifPreference.deleteMany({
      where: { userWawuId: { in: [USER_A, USER_B] } },
    });
    await app.close();
  });

  it('a user who never changed it sees TGIF shown, and reading it saves nothing', async () => {
    const res = await get(phone).expect(200);
    expect(shown(res)).toEqual({ show: true });
    expect(
      await prisma.tgifPreference.count({ where: { userWawuId: USER_A } }),
    ).toBe(0);
  });

  it('a user can turn TGIF off on one device and it stays off on another device', async () => {
    const off = await patch(browser, { show: false }).expect(200);
    expect(shown(off)).toEqual({ show: false });
    const seen = await get(phone).expect(200);
    expect(shown(seen)).toEqual({ show: false });
  });

  it('a user can turn TGIF back on', async () => {
    await patch(phone, { show: false }).expect(200);
    await patch(browser, { show: true }).expect(200);
    const seen = await get(phone).expect(200);
    expect(shown(seen)).toEqual({ show: true });
    expect(
      await prisma.tgifPreference.count({ where: { userWawuId: USER_A } }),
    ).toBe(1);
  });

  it("a user turning TGIF off does not change anyone else's setting", async () => {
    await patch(phone, { show: false }).expect(200);
    const seen = await get(other).expect(200);
    expect(shown(seen)).toEqual({ show: true });
    expect(
      await prisma.tgifPreference.count({ where: { userWawuId: USER_B } }),
    ).toBe(0);
  });

  it('a request with no sign-in is refused on both routes', async () => {
    await request(app.getHttpServer())
      .get('/api/hub/settings/tgif')
      .expect(401);
    await request(app.getHttpServer())
      .patch('/api/hub/settings/tgif')
      .send({ show: false })
      .expect(401);
  });

  it.each([
    ['an empty body', {}],
    ['a string', { show: 'false' }],
    ['a number', { show: 0 }],
    ['null', { show: null }],
    ['an array', { show: [false] }],
    ['an extra field', { show: false, userWawuId: USER_B }],
    ['a different field name', { hidden: true }],
  ])(
    'a user sending %s is refused with 400 and nothing is stored',
    async (_n, body) => {
      await patch(phone, body).expect(400);
      expect(
        await prisma.tgifPreference.count({ where: { userWawuId: USER_A } }),
      ).toBe(0);
    },
  );

  it('a user sending a body that is not JSON is refused with 400 or 415, never 500', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/hub/settings/tgif')
      .set('Authorization', `Bearer ${phone}`)
      .set('Content-Type', 'application/json')
      .send('{"show": ');
    expect([400, 415]).toContain(res.status);
  });

  it('a user changing it from 14 devices at once gets 14 successes, one row and a settled value', async () => {
    const results = await Promise.all(
      Array.from({ length: 14 }, (_v, i) =>
        patch(i % 2 ? phone : browser, { show: i % 2 === 0 }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(14).fill(200));
    expect(
      await prisma.tgifPreference.count({ where: { userWawuId: USER_A } }),
    ).toBe(1);
    const row = await prisma.tgifPreference.findUniqueOrThrow({
      where: { userWawuId: USER_A },
    });
    const seen = await get(phone).expect(200);
    expect(shown(seen).show).toBe(row.show);
  });
});

// Run against a test database: always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { UserProfileModule } from '../../user-profile/user-profile.module';
import { GeoModule } from '../geo.module';
import { ProfileLocationService } from '../profile-location.service';

/**
 * GEO-FILL point 3 (R-143): the first time the Hub sees a signed-in person
 * with no country row, it records the one the token gives, without the app
 * calling `/me/location`, once per person per process, and it never makes the
 * request fail.
 */

const MOCK = `http://localhost:${process.env.WAWU_ID_JWKS_URL ? new URL(process.env.WAWU_ID_JWKS_URL).port : '4001'}`;
const PRO = '00000000-0000-4000-8000-000000000003'; // seeded creator-pro; its token says country "Nigeria"
const P = 'b4000000-0000-4000-8000-0000000000';
const ids = {
  fresh: `${P}01`,
  chosen: `${P}02`,
  nothing: `${P}03`,
  failing: `${P}04`,
  phoneOnly: `${P}05`,
  repeat: `${P}06`,
};

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function until<T>(
  read: () => Promise<T | null>,
  ms = 4000,
): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== null || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Record the country of a signed-in person (GEO-FILL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let places: ProfileLocationService;
  let proToken: string;
  let proRowBefore: Awaited<
    ReturnType<PrismaService['profileDetails']['findUnique']>
  >;

  const row = (id: string) =>
    prisma.profileDetails.findUnique({ where: { wawuUserId: id } });
  const sweep = () =>
    prisma.profileDetails.deleteMany({
      where: { wawuUserId: { in: Object.values(ids) } },
    });

  beforeAll(async () => {
    proToken = await login('creator-pro@test.wawu.dev');
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        GeoModule,
        UserProfileModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
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
    places = moduleRef.get(ProfileLocationService);
    proRowBefore = await row(PRO);
    await sweep();
  }, 40000);

  afterAll(async () => {
    await sweep();
    await prisma.profileDetails.deleteMany({ where: { wawuUserId: PRO } });
    if (proRowBefore)
      await prisma.profileDetails.create({ data: proRowBefore });
    await app?.close();
  }, 30000);

  it('records the token country for a person with none, with the source', async () => {
    places.noteSignedIn(ids.fresh, {
      countryCode: 'GH',
      country: 'Ghana',
      phone: '+2348031230001',
    });
    const r = await until(() => row(ids.fresh));
    expect(r).toMatchObject({ countryCode: 'GH', countrySource: 'wawu_id' });
  });

  it('falls back to the phone when the token has no country, as me() does', async () => {
    places.noteSignedIn(ids.phoneOnly, {
      countryCode: null,
      country: null,
      phone: '+442079460958',
    });
    const r = await until(() => row(ids.phoneOnly));
    expect(r).toMatchObject({ countryCode: 'GB', countrySource: 'phone' });
  });

  it('never replaces a country the person chose', async () => {
    await prisma.profileDetails.create({
      data: {
        wawuUserId: ids.chosen,
        countryCode: 'NG',
        countrySource: 'profile',
      },
    });
    places.noteSignedIn(ids.chosen, {
      countryCode: 'GH',
      phone: '+233201230002',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await row(ids.chosen)).toMatchObject({
      countryCode: 'NG',
      countrySource: 'profile',
    });
  });

  it('reads at most once per person per process, however often they are seen', async () => {
    await prisma.profileDetails.create({
      data: {
        wawuUserId: ids.repeat,
        countryCode: 'NG',
        countrySource: 'profile',
      },
    });
    const spy = jest.spyOn(prisma.profileDetails, 'findUnique');
    try {
      for (let i = 0; i < 5; i += 1)
        places.noteSignedIn(ids.repeat, { countryCode: 'GH' });
      await new Promise((r) => setTimeout(r, 300));
      const mine = spy.mock.calls.filter(
        (c) =>
          (c[0] as { where: { wawuUserId: string } }).where.wawuUserId ===
          ids.repeat,
      );
      expect(mine).toHaveLength(1);
      // seen again after its row is gone: still not looked at again in this process
      await prisma.profileDetails.deleteMany({
        where: { wawuUserId: ids.repeat },
      });
      places.noteSignedIn(ids.repeat, { countryCode: 'GH' });
      await new Promise((r) => setTimeout(r, 200));
      expect(await row(ids.repeat)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('costs no read when the token gives no country at all', async () => {
    const spy = jest.spyOn(prisma.profileDetails, 'findUnique');
    try {
      places.noteSignedIn(ids.nothing, {
        countryCode: null,
        country: null,
        phone: '08031230001',
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(spy).not.toHaveBeenCalled();
      expect(await row(ids.nothing)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws, and looks again next time after a failure', async () => {
    const spy = jest
      .spyOn(prisma.profileDetails, 'findUnique')
      .mockRejectedValueOnce(new Error('db down'));
    try {
      expect(() =>
        places.noteSignedIn(ids.failing, { countryCode: 'KE' }),
      ).not.toThrow();
      await new Promise((r) => setTimeout(r, 200));
      expect(await row(ids.failing)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    places.noteSignedIn(ids.failing, { countryCode: 'KE' });
    expect(await until(() => row(ids.failing))).toMatchObject({
      countryCode: 'KE',
      countrySource: 'wawu_id',
    });
  });

  describe('on GET /users/me', () => {
    it('records the country once, and the answer is the one it always was', async () => {
      await prisma.profileDetails.deleteMany({ where: { wawuUserId: PRO } });
      const first = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${proToken}`)
        .expect(200);
      expect(first.body.statusCode).toBe(200);
      expect(first.body.data).toBeDefined();
      const recorded = await until(() => row(PRO));
      expect(recorded).toMatchObject({
        countryCode: 'NG',
        countrySource: 'wawu_id',
      });

      // The same person again in this process: not looked at again.
      await prisma.profileDetails.deleteMany({ where: { wawuUserId: PRO } });
      const second = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${proToken}`)
        .expect(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(await row(PRO)).toBeNull();
      expect(Object.keys(second.body.data).sort()).toEqual(
        Object.keys(first.body.data).sort(),
      );
    });

    it('does not fail the request when recording fails', async () => {
      const spy = jest
        .spyOn(prisma.profileDetails, 'findUnique')
        .mockRejectedValue(new Error('db down'));
      try {
        // a new process-level memory: forget this person by using a fresh service instance's set
        (places as unknown as { looked: Set<string> }).looked.clear();
        await request(app.getHttpServer())
          .get('/users/me')
          .set('Authorization', `Bearer ${proToken}`)
          .expect(200);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

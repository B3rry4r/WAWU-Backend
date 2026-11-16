import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminUsersModule } from '../admin-users.module';
import { WawuIdUsersClient } from '../../../identity-users/wawu-id-users.client';
import { WawuIdUsersStandIn } from '../../../identity-users/tests/wawu-id-users-stand-in';

/** Fix round 1: `q` wildcards are plain text (F2); a cut search says so (F3). */
const ADMIN_ID = 'b5000000-0000-4000-8000-0000000000d1';
const EMAIL = 'users-fix1@admin.test.wawu.dev';
const PASSWORD = 'admin-users-fix1-password';
const P = 'b5000000-0000-4000-8000-';
const idOf = (i: number) => `${P}${String(i).padStart(12, '0')}`;
const UNDER = idOf(900001); // handle holds an underscore
const PLAIN = idOf(900002);

describe('Admin users list, fix round 1', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const standIn = new WawuIdUsersStandIn();
  const envSnapshot: Record<string, string | undefined> = {};
  const list = (query: Record<string, unknown>) =>
    request(app.getHttpServer())
      .get('/api/hub/admin/users')
      .query(query)
      .set({ Authorization: `Bearer ${token}` });
  const sweep = () =>
    prisma.userProfile.deleteMany({ where: { wawuUserId: { startsWith: P } } });

  beforeAll(async () => {
    for (const k of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'])
      envSnapshot[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'admin-users-fix1-access-secret-0123456789';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'admin-users-fix1-refresh-secret-012345678';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminUsersModule,
      ],
    })
      .overrideProvider(WawuIdUsersClient)
      .useValue(standIn)
      .compile();
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
    const argon2 = await import('argon2');
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.adminUser.create({
      data: {
        id: ADMIN_ID,
        email: EMAIL,
        name: 'Fix1',
        role: 'superadmin',
        passwordHash: await argon2.hash(PASSWORD),
      },
    });
    const res = await request(app.getHttpServer())
      .post('/api/hub/admin/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    token = res.body.data.accessToken as string;
    await sweep();
    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: UNDER,
          accountType: 'user',
          handle: 'fixone_under_score',
          interests: [],
        },
        {
          wawuUserId: PLAIN,
          accountType: 'user',
          handle: 'fixone-plain',
          interests: [],
        },
      ],
    });
  }, 30000);

  afterAll(async () => {
    if (prisma) {
      await sweep();
      await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    }
    await app?.close();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    standIn.users.clear();
    standIn.down = false;
  });

  describe('F2: q wildcards', () => {
    it.each(['%%', '__', '%_%', '\\\\'])(
      '%s matches nothing when no handle holds it',
      async (q) => {
        const res = await list({ q }).expect(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.pagination.total).toBe(0);
      },
    );

    it('an underscore in q matches only a handle that holds one', async () => {
      const res = await list({ q: '_under_' }).expect(200);
      expect(
        (res.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
      ).toEqual([UNDER]);
      const none = await list({ q: 'fixone_plain' }).expect(200);
      expect(none.body.data).toEqual([]);
    });

    it('ordinary text still matches part of a handle', async () => {
      const res = await list({ q: 'FIXONE' }).expect(200);
      expect(res.body.pagination.total).toBe(2);
    });
  });

  describe('F3: truncated', () => {
    it('is false for a search that was read whole, and for a plain list', async () => {
      expect((await list({ q: 'fixone' }).expect(200)).body.truncated).toBe(
        false,
      );
      expect((await list({}).expect(200)).body.truncated).toBe(false);
    });

    it('is true when WAWU ID has more than 500 matches, and total is the 500', async () => {
      await prisma.userProfile.createMany({
        data: Array.from({ length: 600 }, (_, i) => ({
          wawuUserId: idOf(i + 1),
          accountType: 'user' as const,
          interests: [],
        })),
      });
      for (let i = 1; i <= 600; i += 1)
        standIn.add({ id: idOf(i), firstName: 'Zedd', lastName: 'Many' });
      try {
        const res = await list({ q: 'zedd', perPage: 5 }).expect(200);
        expect(res.body.truncated).toBe(true);
        expect(res.body.pagination.total).toBe(500);
        expect(res.body.contactUnavailable).toBe(false);
        expect(standIn.searchCalls.length).toBeGreaterThanOrEqual(5);
      } finally {
        await sweep();
        await prisma.userProfile.createMany({
          data: [
            {
              wawuUserId: UNDER,
              accountType: 'user',
              handle: 'fixone_under_score',
              interests: [],
            },
            {
              wawuUserId: PLAIN,
              accountType: 'user',
              handle: 'fixone-plain',
              interests: [],
            },
          ],
        });
      }
    }, 30000);

    it('is false when the matches are exactly 500', async () => {
      await prisma.userProfile.createMany({
        data: Array.from({ length: 500 }, (_, i) => ({
          wawuUserId: idOf(i + 1),
          accountType: 'user' as const,
          interests: [],
        })),
      });
      for (let i = 1; i <= 500; i += 1)
        standIn.add({ id: idOf(i), firstName: 'Zedd', lastName: 'Many' });
      try {
        const res = await list({ q: 'zedd', perPage: 5 }).expect(200);
        expect(res.body.pagination.total).toBe(500);
        expect(res.body.truncated).toBe(false);
      } finally {
        await sweep();
        await prisma.userProfile.createMany({
          data: [
            {
              wawuUserId: UNDER,
              accountType: 'user',
              handle: 'fixone_under_score',
              interests: [],
            },
            {
              wawuUserId: PLAIN,
              accountType: 'user',
              handle: 'fixone-plain',
              interests: [],
            },
          ],
        });
      }
    }, 30000);
  });
});

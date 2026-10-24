import { randomUUID } from 'node:crypto';
import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminAuthModule } from '../../../admin/auth/admin-auth.module';
import { AdminTokenService } from '../../../admin/auth/admin-token.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AbroadAdminController } from '../abroad-admin.controller';
import { AbroadAdminService } from '../abroad-admin.service';

/**
 * Who may use the admin routes of sending abroad (NUV-11 round 1, F4): superadmin and finance, and no one else. Support and reviewer
 * sign in for real (a token the admin guard verifies) and are refused on every one of the five routes, with the service never called
 * and no audit row written; finance and superadmin reach the service; no token and a bad token are 401. The service is a stand-in
 * that counts its calls, so this proves the guard and the role list and nothing of the service (abroad.contract.spec.ts does that).
 */

const calls: string[] = [];
const stub = {
  list: () => {
    calls.push('list');
    return Promise.resolve({ items: [], nextCursor: null });
  },
  get: () => {
    calls.push('get');
    return Promise.resolve({ id: 'x' });
  },
  cancel: () => {
    calls.push('cancel');
    return Promise.resolve({ id: 'x', status: 'cancelled' });
  },
  freeze: () => {
    calls.push('freeze');
    return Promise.resolve({
      wawuUserId: 'p',
      frozen: true,
      reason: 'r',
      at: null,
    });
  },
  unfreeze: () => {
    calls.push('unfreeze');
    return Promise.resolve({
      wawuUserId: 'p',
      frozen: false,
      reason: null,
      at: null,
    });
  },
};

@Module({
  imports: [AdminAuthModule],
  controllers: [AbroadAdminController],
  providers: [{ provide: AbroadAdminService, useValue: stub }],
})
class UnderTestModule {}

const BASE = '/api/hub/admin/money/abroad';
const SEND = '11111111-1111-4111-8111-111111111111';
const ROUTES: Array<{
  name: string;
  method: 'get' | 'post';
  path: string;
  body?: object;
}> = [
  { name: 'list', method: 'get', path: `${BASE}/sends` },
  { name: 'one', method: 'get', path: `${BASE}/sends/${SEND}` },
  {
    name: 'cancel',
    method: 'post',
    path: `${BASE}/sends/${SEND}/cancel`,
    body: { reason: 'confirmed with the partner' },
  },
  {
    name: 'freeze',
    method: 'post',
    path: `${BASE}/people/some-person/freeze`,
    body: { reason: 'checking a report' },
  },
  {
    name: 'unfreeze',
    method: 'post',
    path: `${BASE}/people/some-person/unfreeze`,
    body: { reason: 'cleared' },
  },
];

describe('Admin: send abroad, who may use it (NUV-11)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const previous: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};

  const call = (r: (typeof ROUTES)[number], role?: AdminRole) => {
    const req = request(app.getHttpServer())[r.method](r.path);
    const authed =
      role && tokens[role]
        ? req.set('Authorization', `Bearer ${tokens[role]}`)
        : req;
    return r.body ? authed.send(r.body) : authed;
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'nuv11-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'nuv11-admin-refresh-secret-0123456789abcdef',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        UnderTestModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
      AdminRole.reviewer,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `nuv11-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `NUV-11 ${role}`,
          role,
        },
      });
      tokens[role] = issuer.issuePair(admin).accessToken;
    }
  });

  afterAll(async () => {
    if (prisma)
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it.each(ROUTES)('$name: no token and a bad token are 401', async (r) => {
    await call(r).expect(401);
    await request(app.getHttpServer())
      [r.method](r.path)
      .set('Authorization', 'Bearer not.a.token')
      .expect(401);
    expect(calls).toEqual([]);
  });

  it.each(
    ROUTES.flatMap((r) =>
      [AdminRole.support, AdminRole.reviewer].map((role) => ({ ...r, role })),
    ),
  )(
    '$name: $role is refused with 403, the service is never called and no audit row is written',
    async (r) => {
      const before = await prisma.abroadAdminAudit.count({
        where: { subjectWawuId: 'some-person' },
      });
      await call(r, r.role).expect(403);
      expect(calls).toEqual([]);
      expect(
        await prisma.abroadAdminAudit.count({
          where: { subjectWawuId: 'some-person' },
        }),
      ).toBe(before);
    },
  );

  it.each(
    ROUTES.flatMap((r) =>
      [AdminRole.finance, AdminRole.superadmin].map((role) => ({ ...r, role })),
    ),
  )('$name: $role reaches the service', async (r) => {
    const res = await call(r, r.role);
    expect([200, 201]).toContain(res.status);
    expect(calls).toHaveLength(1);
  });
});

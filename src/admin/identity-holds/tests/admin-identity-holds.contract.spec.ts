import { randomUUID } from 'node:crypto';
import {
  type INestApplication,
  Injectable,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminOpsAuditModule } from '../../../common/audit/admin-ops-audit.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WalletOpeningService } from '../../../money/opening/wallet-opening.service';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminTokenService } from '../../auth/admin-token.service';
import { AdminIdentityHoldsController } from '../admin-identity-holds.controller';
import { AdminIdentityHoldsService } from '../admin-identity-holds.service';

/**
 * Support letting go of one person's BVN hold (NUV-02 round 3, N3): the
 * route's guards, role matrix, answers, audit and what it never says. The
 * opening itself (what a release does to the BVN claim and the person) is
 * proved against a real database and the Nuvion stand-in in
 * src/nuvion/tests/nuvion-opening.contract.spec.ts; here the opening service
 * is a stand-in that answers each outcome, so every answer of the route is
 * reached.
 */

type Outcome =
  | 'released'
  | 'no_opening'
  | 'already_released'
  | 'not_held'
  | 'in_review'
  | 'has_wallet';

@Injectable()
class OpeningDouble {
  answers = new Map<string, Outcome>();
  calls: string[] = [];
  releaseIdentityHold(
    id: string,
  ): Promise<{ outcome: Outcome; before: string | null }> {
    this.calls.push(id);
    return Promise.resolve({
      outcome: this.answers.get(id) ?? 'no_opening',
      before: 'review',
    });
  }
}

@Module({
  providers: [
    OpeningDouble,
    { provide: WalletOpeningService, useExisting: OpeningDouble },
  ],
  exports: [WalletOpeningService, OpeningDouble],
})
class OpeningDoubleModule {}

@Module({
  imports: [AdminAuthModule, AdminOpsAuditModule, OpeningDoubleModule],
  controllers: [AdminIdentityHoldsController],
  providers: [AdminIdentityHoldsService],
})
class UnderTestModule {}

describe('Admin: support lets go of a BVN hold (NUV-02 round 3)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let double: OpeningDouble;
  const previous: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};
  const holders: string[] = [];

  const http = () => request(app.getHttpServer());
  const release = (id: string, role?: AdminRole) => {
    const r = http().post(`/api/hub/admin/identity-holds/${id}/release`);
    return role && tokens[role]
      ? r.set('Authorization', `Bearer ${tokens[role]}`)
      : r;
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'nuv02-r3-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'nuv02-r3-admin-refresh-secret-0123456789abcd',
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
    double = moduleRef.get(OpeningDouble);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.support,
      AdminRole.reviewer,
      AdminRole.finance,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `nuv02r3-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `NUV-02 ${role}`,
          role,
        },
      });
      tokens[role] = issuer.issuePair(admin).accessToken;
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.adminOpsAudit.deleteMany({
        where: { resourceId: { in: holders } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('no token: 401; a user-style bad token: 401', async () => {
    await release(randomUUID()).expect(401);
    await http()
      .post(`/api/hub/admin/identity-holds/${randomUUID()}/release`)
      .set('Authorization', 'Bearer not.a.token')
      .expect(401);
    expect(double.calls).toEqual([]);
  });

  it.each([AdminRole.reviewer, AdminRole.finance])(
    '%s is refused entirely: 403, the opening is never touched',
    async (role) => {
      await release(randomUUID(), role).expect(403);
      expect(double.calls).toEqual([]);
    },
  );

  it('a malformed id: 400, the opening is never touched', async () => {
    await http()
      .post('/api/hub/admin/identity-holds/not-an-id/release')
      .set('Authorization', `Bearer ${tokens[AdminRole.support]}`)
      .expect(400);
    expect(double.calls).toEqual([]);
  });

  it.each([AdminRole.support, AdminRole.superadmin])(
    '%s lets go of a hold: 200, one audit row, no BVN or hash anywhere',
    async (role) => {
      const id = randomUUID();
      holders.push(id);
      double.answers.set(id, 'released');
      const res = await release(id, role).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({
        wawuUserId: id,
        outcome: 'released',
        state: 'expired',
      });
      expect(res.text).not.toMatch(/bvn|hash|released:|\d{11}/i);
      const rows = await prisma.adminOpsAudit.findMany({
        where: { resourceId: id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        resource: 'wallet_identity_hold',
        action: 'wallet_identity_hold_released',
        subjectWawuId: id,
        actedByAdminRole: role,
        detail: { stateBefore: 'review', stateAfter: 'expired' },
      });
      expect(JSON.stringify(rows[0])).not.toMatch(/\d{11}|bvn/i);
    },
  );

  it.each(['already_released', 'not_held'] as const)(
    '%s: 200, nothing changed, no audit row',
    async (outcome) => {
      const id = randomUUID();
      holders.push(id);
      double.answers.set(id, outcome);
      const res = await release(id, AdminRole.support).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({
        wawuUserId: id,
        outcome: 'already_released',
        state: 'unchanged',
      });
      expect(
        await prisma.adminOpsAudit.count({ where: { resourceId: id } }),
      ).toBe(0);
    },
  );

  it.each([
    ['no_opening', 404],
    ['in_review', 409],
    ['has_wallet', 409],
  ] as const)('%s: %s, no audit row', async (outcome, status) => {
    const id = randomUUID();
    holders.push(id);
    double.answers.set(id, outcome);
    await release(id, AdminRole.support).expect(status);
    expect(
      await prisma.adminOpsAudit.count({ where: { resourceId: id } }),
    ).toBe(0);
  });
});

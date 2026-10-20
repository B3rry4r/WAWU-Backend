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

/**
 * The text with the ids WAWU generated itself cut out (the audit row's own
 * uuid, the holder's, the admins', also inside an admin's email). A random
 * uuid can hold 11 decimal digits in a row, which is what a BVN looks like,
 * so scanning the raw row failed about 1 run in 100. What is left is only what
 * could carry a BVN: detail, the other fields, the date. A number planted in
 * any of those, or the word bvn, still trips the scan. The id is swapped for
 * a marker, not removed, so the text on either side cannot join into a run.
 */
function withoutKnownIds(text: string, knownIds: string[]): string {
  return knownIds.reduce((t, k) => t.split(k).join('<id>'), text);
}

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
      expect(withoutKnownIds(res.text, [id])).not.toMatch(
        /bvn|hash|released:|\d{11}/i,
      );
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
      expect(
        withoutKnownIds(JSON.stringify(rows[0]), [rows[0].id, id, ...adminIds]),
      ).not.toMatch(/\d{11}|bvn/i);
    },
  );

  it('the BVN scan skips our own ids, and still trips on a planted number or the word', () => {
    // An admin id whose last group holds 11 decimal digits in a row, as a
    // random uuid sometimes does.
    const adminId = '0b6e1c52-7a3d-4f10-9c2e-f43762817252';
    const holderId = '5d2f9a01-3c4b-4e7a-8b11-aa90c1d2e3f4';
    const rowId = '9c1e7b30-52d8-4a6f-b0e4-1f2a3b4c5d6e';
    const known = [rowId, holderId, adminId];
    const row = {
      id: rowId,
      resource: 'wallet_identity_hold',
      resourceId: holderId,
      subjectWawuId: holderId,
      action: 'wallet_identity_hold_released',
      detail: { stateBefore: 'review', stateAfter: 'expired' } as object,
      actedByAdminId: adminId,
      actedByAdminEmail: `nuv02r3-support-${adminId}@admin.test.wawu.dev`,
      actedByAdminRole: 'support',
      actedAt: '2026-10-16T12:34:56.789Z',
    };
    const scan = (r: object) =>
      withoutKnownIds(JSON.stringify(r), known).match(/\d{11}|bvn/i);

    // The old scan, on the raw row, trips on the id alone.
    expect(JSON.stringify(row)).toMatch(/\d{11}|bvn/i);
    // The new scan lets the clean row through.
    expect(scan(row)).toBeNull();
    // A real 11-digit number, or the word, in any field that is not an id.
    expect(scan({ ...row, detail: { note: '22212345678' } })).not.toBeNull();
    expect(scan({ ...row, detail: { bvn: 'masked' } })).not.toBeNull();
    expect(scan({ ...row, action: 'released_22212345678' })).not.toBeNull();
    // An id field that holds a number instead of the known id.
    expect(scan({ ...row, subjectWawuId: '22212345678' })).not.toBeNull();
    expect(
      scan({ ...row, actedByAdminEmail: 'someone22212345678@admin.test' }),
    ).not.toBeNull();
    // A number stuck to an id is not hidden by the id being cut out.
    expect(
      scan({ ...row, subjectWawuId: `${holderId}22212345678` }),
    ).not.toBeNull();
  });

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

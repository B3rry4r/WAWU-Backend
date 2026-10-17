import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PLANS_CONFIG, type PlansConfig } from '../../../plans/plans-config';
import type {
  PlanSettingsView,
  PlanSettingView,
} from '../../../plan-settings/plan-settings.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { AdminTokenService } from '../../auth/admin-token.service';
import { LONG_DASH } from '../../../plan-settings/plan-setting-registry';
import { AdminPlanSettingsModule } from '../admin-plan-settings.module';

/**
 * `/admin/plan-settings` (TIER-06, R-65): who may read and change the launch
 * figures, what a change does to the plan the next request reads, the audit
 * row it leaves, and every value it refuses. Real database, real guards.
 */

jest.setTimeout(120_000);

const EXTRA_PRICE = 'plan.extra_products.price_kobo';
const BASE = '/api/hub/admin/plan-settings';

type Envelope<T> = { statusCode: number; data: T };

describe('Admin: the launch figures as settings (TIER-06)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let settings: PlanSettingsService;
  let plan: PlansConfig;
  const previous: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};
  const admins: Partial<Record<AdminRole, { id: string; email: string }>> = {};

  const http = () => request(app.getHttpServer());
  const get = (role?: AdminRole) => {
    const r = http().get(BASE);
    return role ? r.set('Authorization', `Bearer ${tokens[role]}`) : r;
  };
  const patch = (body: unknown, role: AdminRole = AdminRole.finance) =>
    http()
      .patch(BASE)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .send(body as object);
  const view = (res: request.Response) =>
    (res.body as Envelope<PlanSettingsView>).data;
  const one = (v: PlanSettingsView, key: string): PlanSettingView =>
    v.settings.find((s) => s.key === key)!;
  const auditRows = (key: string) =>
    prisma.adminOpsAudit.findMany({
      where: { resource: 'plan_setting', resourceId: key },
      orderBy: { actedAt: 'asc' },
    });
  const storedRows = () => prisma.planSetting.findMany();

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'tier06-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'tier06-admin-refresh-secret-0123456789abcd',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AdminPlanSettingsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      logger: false,
    });
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
    settings = moduleRef.get(PlanSettingsService);
    plan = moduleRef.get<PlansConfig>(PLANS_CONFIG);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.support,
      AdminRole.reviewer,
      AdminRole.finance,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const email = `tier06-${role}-${id}@admin.test.wawu.dev`;
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email,
          passwordHash: 'not-a-real-hash',
          name: `TIER-06 ${role}`,
          role,
        },
      });
      admins[role] = { id, email };
      tokens[role] = issuer.issuePair(admin).accessToken;
    }
  });

  beforeEach(async () => {
    await prisma.planSetting.deleteMany({});
    await prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: { in: adminIds } },
    });
    await settings.refresh();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.planSetting.deleteMany({});
      await prisma.adminOpsAudit.deleteMany({
        where: { actedByAdminId: { in: adminIds } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ---- who may ------------------------------------------------------------

  it('no token and a bad token are 401 on both routes, and nothing is stored', async () => {
    await get().expect(401);
    await http()
      .patch(BASE)
      .send({ settings: { [EXTRA_PRICE]: 1 } })
      .expect(401);
    await http()
      .patch(BASE)
      .set('Authorization', 'Bearer not.a.token')
      .send({ settings: { [EXTRA_PRICE]: 1 } })
      .expect(401);
    expect(await storedRows()).toEqual([]);
  });

  it('a reviewer is refused on both routes', async () => {
    await get(AdminRole.reviewer).expect(403);
    await patch(
      { settings: { [EXTRA_PRICE]: 170_000 } },
      AdminRole.reviewer,
    ).expect(403);
    expect(await storedRows()).toEqual([]);
  });

  it('support may read but not change', async () => {
    await get(AdminRole.support).expect(200);
    await patch(
      { settings: { [EXTRA_PRICE]: 170_000 } },
      AdminRole.support,
    ).expect(403);
    expect(await storedRows()).toEqual([]);
  });

  // ---- reading ------------------------------------------------------------

  it('lists every setting with its default, the screens that print it and what is provisional', async () => {
    const v = view(await get(AdminRole.finance).expect(200));
    expect(v.settings.length).toBeGreaterThan(40);
    expect(v.settings.every((s) => s.source === 'default')).toBe(true);
    expect(v.settings.every((s) => s.usedBy.length > 0)).toBe(true);
    expect(one(v, EXTRA_PRICE)).toMatchObject({
      value: plan.extraProducts.price.kobo,
      default: plan.extraProducts.price.kobo,
      unit: 'kobo',
      provisional: null,
      updatedAt: null,
    });
    expect(one(v, EXTRA_PRICE).usedBy).toEqual(
      expect.arrayContaining(['VF13']),
    );
    const board = one(v, 'plan.pack.m.price_kobo').provisional;
    expect(board?.id).toBe('DV2-BOARD-FIGURE');
    expect(board?.why).toContain('R-65');
    expect(JSON.stringify(v)).not.toMatch(LONG_DASH);
  });

  // ---- changing -----------------------------------------------------------

  it('a change is saved, audited, and the plan the next request reads has it with no restart', async () => {
    const before = plan.extraProducts.price.kobo;
    const res = await patch({ settings: { [EXTRA_PRICE]: 175_000 } }).expect(
      200,
    );
    expect(one(view(res), EXTRA_PRICE)).toMatchObject({
      value: 175_000,
      default: before,
      source: 'set',
    });
    // The live plan every reader injects.
    expect(plan.extraProducts.price.kobo).toBe(175_000);
    // The next read of the list.
    expect(one(view(await get(AdminRole.support)), EXTRA_PRICE).value).toBe(
      175_000,
    );
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: EXTRA_PRICE,
      value: 175_000,
      updatedByAdminId: admins[AdminRole.finance]!.id,
    });
    const audit = await auditRows(EXTRA_PRICE);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'plan_setting_set',
      subjectWawuId: '',
      actedByAdminId: admins[AdminRole.finance]!.id,
      actedByAdminEmail: admins[AdminRole.finance]!.email,
      actedByAdminRole: AdminRole.finance,
      detail: { key: EXTRA_PRICE, from: before, to: 175_000, reset: false },
    });
  });

  it('a null puts the default back and says so in the audit', async () => {
    await patch({ settings: { [EXTRA_PRICE]: 175_000 } }).expect(200);
    const res = await patch(
      { settings: { [EXTRA_PRICE]: null } },
      AdminRole.superadmin,
    ).expect(200);
    expect(one(view(res), EXTRA_PRICE).source).toBe('default');
    expect(plan.extraProducts.price.kobo).toBe(
      one(view(res), EXTRA_PRICE).default,
    );
    expect(await storedRows()).toEqual([]);
    const audit = await auditRows(EXTRA_PRICE);
    expect(audit.map((a) => a.detail)).toEqual([
      expect.objectContaining({ to: 175_000, reset: false }),
      expect.objectContaining({
        from: 175_000,
        to: one(view(res), EXTRA_PRICE).default,
        reset: true,
      }),
    ]);
  });

  it('one audit row per setting that changed; a value already in force writes nothing', async () => {
    const same = plan.extraProducts.count;
    const res = await patch({
      settings: {
        [EXTRA_PRICE]: 160_000,
        'points.daily_cap': 4500,
        'plan.extra_products.count': same,
        'referral.hold_days': null,
      },
    }).expect(200);
    expect(one(view(res), 'points.daily_cap').value).toBe(4500);
    expect((await storedRows()).map((r) => r.key).sort()).toEqual(
      [EXTRA_PRICE, 'points.daily_cap'].sort(),
    );
    expect(await auditRows(EXTRA_PRICE)).toHaveLength(1);
    expect(await auditRows('points.daily_cap')).toHaveLength(1);
    expect(await auditRows('plan.extra_products.count')).toHaveLength(0);
    expect(await auditRows('referral.hold_days')).toHaveLength(0);
    // The same request again changes nothing and adds no audit.
    await patch({
      settings: { [EXTRA_PRICE]: 160_000, 'points.daily_cap': 4500 },
    }).expect(200);
    expect(await auditRows(EXTRA_PRICE)).toHaveLength(1);
    expect(await auditRows('points.daily_cap')).toHaveLength(1);
  });

  it('lists, objects and the pass lines are saved in the one normal form', async () => {
    const ladder = [
      { x: 1, min: 1 },
      { x: 2.5, min: 4 },
    ];
    const lines = ['  First line  ', 'Second line'];
    const res = await patch({
      settings: {
        'referral.multipliers': ladder,
        'plan.event_pass.maker_pass_priority.benefits': lines,
        'plan.event_date': '2026-12-19',
        tgif_notification_time: '06:45',
      },
    }).expect(200);
    const v = view(res);
    expect(one(v, 'referral.multipliers').value).toEqual([
      { min: 1, x: 1 },
      { min: 4, x: 2.5 },
    ]);
    expect(
      one(v, 'plan.event_pass.maker_pass_priority.benefits').value,
    ).toEqual(['First line', 'Second line']);
    expect(plan.eventDate).toBe('2026-12-19');
    expect(settings.text('tgif_notification_time')).toBe('06:45');
    expect(plan.referral.levels).toEqual([
      { min: 1, x: 1 },
      { min: 4, x: 2.5 },
    ]);
  });

  // ---- refusals -----------------------------------------------------------

  it.each([
    ['zero', 0],
    ['negative', -150_000],
    ['a decimal', 1500.5],
    ['text', '150000'],
    ['too large', 2 ** 40],
    ['an object', { kobo: 150_000 }],
  ])(
    'a price of %s is 400, naming the key, and nothing is stored',
    async (_n, value) => {
      const res = await patch({ settings: { [EXTRA_PRICE]: value } }).expect(
        400,
      );
      expect(JSON.stringify(res.body)).toContain(EXTRA_PRICE);
      expect(await storedRows()).toEqual([]);
      expect(await auditRows(EXTRA_PRICE)).toEqual([]);
      expect(plan.extraProducts.price.kobo).toBeGreaterThan(0);
    },
  );

  it.each([
    ['no body', undefined],
    ['no settings', {}],
    ['settings as a list', { settings: [] }],
    ['settings as text', { settings: 'x' }],
    ['no settings in it', { settings: {} }],
    ['an unknown key', { settings: { 'plan.no.such': 1 } }],
    [
      'an unknown top-level field',
      { settings: { [EXTRA_PRICE]: 1 }, other: 1 },
    ],
  ])('%s is 400 and nothing is stored', async (_n, body) => {
    await patch(body).expect(400);
    expect(await storedRows()).toEqual([]);
  });

  it('one bad value refuses the whole request: the good one is not saved either', async () => {
    await patch({
      settings: { [EXTRA_PRICE]: 160_000, 'points.daily_cap': 0 },
    }).expect(400);
    expect(await storedRows()).toEqual([]);
    expect(await auditRows(EXTRA_PRICE)).toEqual([]);
    expect(plan.extraProducts.price.kobo).not.toBe(160_000);
  });

  // ---- other writers ------------------------------------------------------

  it('a change saved by another process reaches this one on the next reload', async () => {
    await prisma.planSetting.create({
      data: { key: 'points.cash_rate_kobo_per_1000', value: 60_000 },
    });
    expect(plan.cashOut.per1000Points.kobo).not.toBe(60_000);
    await settings.refresh();
    expect(plan.cashOut.per1000Points.kobo).toBe(60_000);
  });

  it('a row written outside the service that fails its check is ignored: the default is used', async () => {
    await prisma.planSetting.create({
      data: { key: EXTRA_PRICE, value: -5 },
    });
    await prisma.planSetting.create({
      data: { key: 'no.such.setting', value: 5 },
    });
    await settings.refresh();
    expect(plan.extraProducts.price.kobo).toBeGreaterThan(0);
    expect(one(settings.describe(), EXTRA_PRICE).source).toBe('default');
  });
});

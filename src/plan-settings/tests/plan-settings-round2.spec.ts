import { Logger } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { loadPlanSettingsDefaults } from '../plan-settings-defaults';
import { PlanSettingsService } from '../plan-settings.service';

/**
 * TIER-06 round 2, with no database: a save whose reload fails is loud, and
 * the next reload brings the saved figure in (finding 5).
 */

const seed = loadPlanSettingsDefaults();
const admin: AdminActor = {
  id: 'admin-1',
  email: 'a@admin.test.wawu.dev',
  role: AdminRole.finance,
};

type Row = { key: string; value: unknown; updatedAt: Date };

/** A stand-in for the one table: a save writes `rows`, a read returns them (or fails while `down`). */
function fakeDb() {
  const rows = new Map<string, Row>();
  const state = { down: false };
  const delegate = {
    findMany: jest.fn(() => {
      if (state.down) return Promise.reject(new Error('connection lost'));
      return Promise.resolve([...rows.values()]);
    }),
    findUnique: jest.fn(({ where }: { where: { key: string } }) =>
      Promise.resolve(rows.get(where.key) ?? null),
    ),
    upsert: jest.fn(
      ({
        where,
        create,
      }: {
        where: { key: string };
        create: { key: string; value: unknown };
      }) => {
        rows.set(where.key, { ...create, updatedAt: new Date() });
        return Promise.resolve();
      },
    ),
    delete: jest.fn(({ where }: { where: { key: string } }) => {
      rows.delete(where.key);
      return Promise.resolve();
    }),
  };
  const tx = {
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    // The table inside a save reads the rows even while the plain reads fail:
    // only the reload after the save is made to fail.
    planSetting: {
      ...delegate,
      findMany: jest.fn(() => Promise.resolve([...rows.values()])),
    },
    adminOpsAudit: { create: jest.fn(() => Promise.resolve()) },
  };
  const prisma = {
    planSetting: delegate,
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, state, rows };
}

describe('a save whose reload fails (TIER-06 round 2, finding 5)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is logged as an error naming what happened, and the next reload brings the saved figure in', async () => {
    const { prisma, state } = fakeDb();
    const svc = new PlanSettingsService(prisma as never, seed);
    await svc.refresh();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    state.down = true;
    const view = await svc.set(admin, {
      settings: { 'points.daily_cap': 4000 },
    });
    // The save went through; this process still holds the old plan, and says so loudly.
    expect(view.settings.find((s) => s.key === 'points.daily_cap')!.value).toBe(
      seed.plans.caps.dailyPointsPerUser,
    );
    expect(error).toHaveBeenCalledTimes(1);
    const said = String(error.mock.calls[0][0]);
    expect(said).toMatch(/saved/i);
    expect(said).toMatch(/points\.daily_cap/);

    // The next tick of the timer reloads, and the figure is in force.
    state.down = false;
    await svc.refresh();
    expect(svc.number('points.daily_cap')).toBe(4000);
    expect(svc.current().caps.dailyPointsPerUser).toBe(4000);
  });

  it('a reload that works is not an error', async () => {
    const { prisma } = fakeDb();
    const svc = new PlanSettingsService(prisma as never, seed);
    await svc.refresh();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await svc.set(admin, { settings: { 'points.daily_cap': 4100 } });
    expect(error).not.toHaveBeenCalled();
    expect(svc.number('points.daily_cap')).toBe(4100);
  });
});

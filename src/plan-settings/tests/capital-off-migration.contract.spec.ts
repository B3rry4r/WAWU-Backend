// CAPITAL-OFF (R-97): Capital is off by default, and the migration `20261210090000_capital_off`
// sets a saved `capital.enabled` row to 0, touches nothing else, and its rollback refuses while
// the row exists.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs inside
// one transaction that is always rolled back, so PlanSetting is left as found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildRegistry } from '../plan-setting-registry';
import { loadPlanSettingsDefaults } from '../plan-settings-defaults';

jest.setTimeout(60_000);

const FOLDER = join(
  __dirname,
  '../../../prisma/migrations/20261210090000_capital_off',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');

describe('CAPITAL-OFF: the default is off', () => {
  it('the seed file and the registry both read 0 for capital.enabled', () => {
    const seed = loadPlanSettingsDefaults();
    expect(seed.extras.values['capital.enabled']).toBe(0);
    const def = buildRegistry(seed.plans, seed.extras).find(
      (d) => d.key === 'capital.enabled',
    );
    expect(def?.default).toBe(0);
    // The note an admin reads names the ruling and the reason.
    expect(seed.extras.provisional['CAPITAL-ENABLED']).toContain('R-97');
  });
});

describe('CAPITAL-OFF: the migration sets a saved capital.enabled row off and nothing else', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
  async function inRolledBackTx<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
    class Done extends Error {}
    let out!: T;
    try {
      await prisma.$transaction(async (tx) => {
        out = await body(tx);
        throw new Done();
      });
    } catch (e) {
      if (!(e instanceof Done)) throw e;
    }
    return out;
  }

  const put = (tx: Tx, key: string, value: unknown, admin: string | null) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "PlanSetting" ("key","value","updatedByAdminId","updatedAt") VALUES ($1, $2::jsonb, $3, now())`,
      key,
      JSON.stringify(value),
      admin,
    );
  const KEYS = `'capital.enabled', 'plan.tier.verify.days', 'plan.event_name', 'capital.other'`;
  const all = (tx: Tx) =>
    tx.$queryRawUnsafe<
      { key: string; value: unknown; updatedByAdminId: string | null }[]
    >(
      `SELECT "key","value","updatedByAdminId" FROM "PlanSetting" WHERE "key" IN (${KEYS}) ORDER BY "key"`,
    );
  const clear = (tx: Tx) =>
    tx.$executeRawUnsafe(`DELETE FROM "PlanSetting" WHERE "key" IN (${KEYS})`);

  it('moves a saved "on" to 0 (no longer naming the admin), leaves every other row alone, and runs again with no change', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await put(tx, 'capital.enabled', 1, 'adm1');
      await put(tx, 'plan.tier.verify.days', 365, 'adm1');
      await put(tx, 'plan.event_name', ['Christmas event'], 'adm2');
      await put(tx, 'capital.other', 1, 'adm3');
      await tx.$executeRawUnsafe(MIGRATE);
      const first = await all(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const second = await all(tx);
      return { first, second };
    });
    const by = (rows: { key: string; value: unknown }[]) =>
      Object.fromEntries(rows.map((x) => [x.key, x.value]));
    expect(by(r.first)).toEqual({
      'capital.enabled': 0,
      'plan.tier.verify.days': 365,
      'plan.event_name': ['Christmas event'],
      'capital.other': 1,
    });
    const admin = Object.fromEntries(
      r.first.map((x) => [x.key, x.updatedByAdminId]),
    );
    expect(admin['capital.enabled']).toBeNull();
    expect(admin['plan.tier.verify.days']).toBe('adm1');
    expect(admin['plan.event_name']).toBe('adm2');
    expect(admin['capital.other']).toBe('adm3');
    expect(r.second).toEqual(r.first);
  });

  it('leaves a row already at 0 as it is (same admin), and adds no row when there is none', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const none = await all(tx);
      await put(tx, 'capital.enabled', 0, 'adm9');
      await tx.$executeRawUnsafe(MIGRATE);
      const off = await all(tx);
      return { none, off };
    });
    expect(r.none).toEqual([]);
    expect(r.off).toEqual([
      { key: 'capital.enabled', value: 0, updatedByAdminId: 'adm9' },
    ]);
  });

  it('touches no order: a Capital order and its state are the same after it runs', async () => {
    const r = await inRolledBackTx(async (tx) => {
      const [{ n: before }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "CapitalOrder"`,
      );
      await put(tx, 'capital.enabled', 1, 'adm1');
      await tx.$executeRawUnsafe(MIGRATE);
      const [{ n: after }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "CapitalOrder"`,
      );
      return { before, after };
    });
    expect(r.after).toEqual(r.before);
  });

  it('its rollback refuses, changing nothing, while the row exists, and passes once it does not', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await put(tx, 'capital.enabled', 0, null);
      await put(tx, 'capital.other', 1, 'adm1');
      let refused = '';
      // A failed statement aborts the transaction, so the refusal runs in a savepoint.
      await tx.$executeRawUnsafe('SAVEPOINT refusal');
      try {
        await tx.$executeRawUnsafe(ROLLBACK);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refusal');
      const still = await all(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM "PlanSetting" WHERE "key" = 'capital.enabled'`,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const after = await all(tx);
      return { refused, still, after };
    });
    expect(r.refused).toContain('CAPITAL-OFF rollback');
    expect(r.refused).toContain('Nothing was changed');
    expect(r.still.map((x) => x.key)).toEqual([
      'capital.enabled',
      'capital.other',
    ]);
    expect(r.after.map((x) => x.key)).toEqual(['capital.other']);
  });
});

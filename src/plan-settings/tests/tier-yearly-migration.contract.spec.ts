// TIER-YEARLY (R-89): the migration `20261204090000_tier_yearly` moves a saved admin
// setting of a tier's price or length to the owner's yearly figures, touches nothing
// else, and its rollback refuses while one of those rows exists.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs
// inside one transaction that is always rolled back, so PlanSetting is left as found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { loadPlansConfig } from '../../plans/plans-config';

jest.setTimeout(60_000);

const FOLDER = join(
  __dirname,
  '../../../prisma/migrations/20261204090000_tier_yearly',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');

const OWNER: Record<string, number> = {
  'plan.tier.verify.price_kobo': 299_900,
  'plan.tier.verify.days': 365,
  'plan.tier.plus.price_kobo': 599_900,
  'plan.tier.plus.days': 365,
  'plan.tier.founding.price_kobo': 999_900,
  'plan.tier.founding.days': 365,
};

describe('TIER-YEARLY: the migration sets the saved tier figures and nothing else', () => {
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
  const all = (tx: Tx) =>
    tx.$queryRawUnsafe<
      { key: string; value: unknown; updatedByAdminId: string | null }[]
    >(
      `SELECT "key","value","updatedByAdminId" FROM "PlanSetting" WHERE "key" LIKE 'plan.tier.%' OR "key" LIKE 'plan.extra_products.%' ORDER BY "key"`,
    );
  const clear = (tx: Tx) =>
    tx.$executeRawUnsafe(
      `DELETE FROM "PlanSetting" WHERE "key" LIKE 'plan.tier.%' OR "key" LIKE 'plan.extra_products.%'`,
    );

  it('the seed holds the same figures the migration sets (a tier with no saved row reads them)', () => {
    const plan = loadPlansConfig();
    const seed: Record<string, number> = {};
    for (const t of plan.tiers) {
      seed[`plan.tier.${t.id}.price_kobo`] = t.price.kobo;
      seed[`plan.tier.${t.id}.days`] = t.days;
    }
    expect(seed).toEqual(OWNER);
  });

  it('moves each of the six saved rows to the owner figure, leaves every other row alone, and runs again with no change', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      // The old launch figures, an admin's own figure, and a row already at the owner's.
      await put(tx, 'plan.tier.verify.price_kobo', 100_000, 'adm1');
      await put(tx, 'plan.tier.verify.days', 30, 'adm1');
      await put(tx, 'plan.tier.plus.price_kobo', 350_000, 'adm1');
      await put(tx, 'plan.tier.plus.days', 180, 'adm1');
      await put(tx, 'plan.tier.founding.price_kobo', 999_900, 'adm2');
      // Rows that are not one of the six.
      await put(tx, 'plan.tier.founding.products', 12, 'adm1');
      await put(tx, 'plan.tier.verify.bonus_points', 150, 'adm1');
      await put(tx, 'plan.extra_products.price_kobo', 175_000, 'adm1');
      await tx.$executeRawUnsafe(MIGRATE);
      const first = await all(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const second = await all(tx);
      return { first, second };
    });
    const by = (rows: { key: string; value: unknown }[]) =>
      Object.fromEntries(rows.map((x) => [x.key, x.value]));
    expect(by(r.first)).toEqual({
      'plan.tier.verify.price_kobo': 299_900,
      'plan.tier.verify.days': 365,
      'plan.tier.plus.price_kobo': 599_900,
      'plan.tier.plus.days': 365,
      'plan.tier.founding.price_kobo': 999_900,
      'plan.tier.founding.products': 12,
      'plan.tier.verify.bonus_points': 150,
      'plan.extra_products.price_kobo': 175_000,
    });
    // A row it moved no longer names the admin; a row already right, and every other row, keep theirs.
    const admin = Object.fromEntries(
      r.first.map((x) => [x.key, x.updatedByAdminId]),
    );
    expect(admin['plan.tier.verify.price_kobo']).toBeNull();
    expect(admin['plan.tier.plus.days']).toBeNull();
    expect(admin['plan.tier.founding.price_kobo']).toBe('adm2');
    expect(admin['plan.tier.founding.products']).toBe('adm1');
    expect(admin['plan.extra_products.price_kobo']).toBe('adm1');
    expect(r.second).toEqual(r.first);
  });

  it('adds no row: a key with no saved row stays without one (its default is the owner figure)', async () => {
    const rows = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      return all(tx);
    });
    expect(rows).toEqual([]);
  });

  it('its rollback refuses, changing nothing, while any of the six rows exists, and passes once none does', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await put(tx, 'plan.tier.plus.days', 365, null);
      await put(tx, 'plan.tier.founding.products', 12, 'adm1');
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
        `DELETE FROM "PlanSetting" WHERE "key" = 'plan.tier.plus.days'`,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const after = await all(tx);
      return { refused, still, after };
    });
    expect(r.refused).toContain('TIER-YEARLY rollback');
    expect(r.refused).toContain('Nothing was changed');
    expect(r.still.map((x) => x.key)).toEqual([
      'plan.tier.founding.products',
      'plan.tier.plus.days',
    ]);
    expect(r.after.map((x) => x.key)).toEqual(['plan.tier.founding.products']);
  });
});

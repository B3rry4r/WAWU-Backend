// TIER-COUNTS (R-112): the migration `20261224090000_tier_counts` moves a saved admin setting of a tier's
// products to the owner's counts (Verify 4, Verify Plus 8, Founding Maker 15), raises the count on every
// running tier a person holds (never lowers one, never touches an ended tier), touches nothing else, and its
// rollback refuses while one of the three saved rows exists.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs inside one transaction
// that is always rolled back, so PlanSetting and MakerTier are left as found.

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
  '../../../prisma/migrations/20261224090000_tier_counts',
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
  'plan.tier.verify.products': 4,
  'plan.tier.plus.products': 8,
  'plan.tier.founding.products': 15,
};
const WHO = 'tier-counts-mig-';

describe('TIER-COUNTS: the migration sets the saved tier counts, raises running tiers, and nothing else', () => {
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
  const settingsOf = (tx: Tx) =>
    tx.$queryRawUnsafe<
      { key: string; value: unknown; updatedByAdminId: string | null }[]
    >(
      `SELECT "key","value","updatedByAdminId" FROM "PlanSetting" WHERE "key" LIKE 'plan.tier.%' OR "key" LIKE 'plan.extra_products.%' ORDER BY "key"`,
    );
  const clear = (tx: Tx) =>
    tx.$executeRawUnsafe(
      `DELETE FROM "PlanSetting" WHERE "key" LIKE 'plan.tier.%' OR "key" LIKE 'plan.extra_products.%'`,
    );
  let n = 0;
  /** A tier row as a purchase leaves it. `days` is how far from now it ends (negative: ended). */
  async function tier(
    tx: Tx,
    tierId: string,
    products: number,
    days: number,
    extra = 0,
  ): Promise<string> {
    n += 1;
    const id = `${WHO}${Date.now()}-${n}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO "MakerTier" ("wawuUserId","tierId","activeFrom","activeUntil","productsIncluded","extraProducts","pointsIncluded","voiceIntroIncluded","createdAt","updatedAt")
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC') - interval '800 days', (now() AT TIME ZONE 'UTC') + ($3 || ' days')::interval, $4, $5, 100, false, (now() AT TIME ZONE 'UTC') - interval '800 days', (now() AT TIME ZONE 'UTC') - interval '800 days')`,
      id,
      tierId,
      String(days),
      products,
      extra,
    );
    return id;
  }
  const rowsOf = (tx: Tx, ids: string[]) =>
    tx.$queryRawUnsafe<
      {
        wawuUserId: string;
        tierId: string;
        productsIncluded: number;
        extraProducts: number;
        pointsIncluded: number;
        activeUntil: Date;
        updatedAt: Date;
      }[]
    >(
      `SELECT "wawuUserId","tierId","productsIncluded","extraProducts","pointsIncluded","activeUntil","updatedAt" FROM "MakerTier" WHERE "wawuUserId" = ANY($1::text[]) ORDER BY "wawuUserId"`,
      ids,
    );

  it('the seed holds the counts the migration sets (a tier with no saved row reads them)', () => {
    const seed: Record<string, number> = {};
    for (const t of loadPlansConfig().tiers)
      seed[`plan.tier.${t.id}.products`] = t.products;
    expect(seed).toEqual(OWNER);
  });

  it('moves each saved row to the owner count, leaves every other row alone, and runs again with no change', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      // The old launch counts, an admin's own count, and a row already at the owner's.
      await put(tx, 'plan.tier.verify.products', 3, 'adm1');
      await put(tx, 'plan.tier.plus.products', 11, 'adm1');
      await put(tx, 'plan.tier.founding.products', 15, 'adm2');
      // Rows that are not one of the three.
      await put(tx, 'plan.tier.founding.price_kobo', 999_900, 'adm1');
      await put(tx, 'plan.tier.verify.bonus_points', 150, 'adm1');
      await put(tx, 'plan.extra_products.count', 7, 'adm1');
      await tx.$executeRawUnsafe(MIGRATE);
      const first = await settingsOf(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const second = await settingsOf(tx);
      return { first, second };
    });
    const by = (rows: { key: string; value: unknown }[]) =>
      Object.fromEntries(rows.map((x) => [x.key, x.value]));
    expect(by(r.first)).toEqual({
      'plan.tier.verify.products': 4,
      'plan.tier.plus.products': 8,
      'plan.tier.founding.products': 15,
      'plan.tier.founding.price_kobo': 999_900,
      'plan.tier.verify.bonus_points': 150,
      'plan.extra_products.count': 7,
    });
    // A row it moved no longer names the admin; a row already right, and every other row, keep theirs.
    const admin = Object.fromEntries(
      r.first.map((x) => [x.key, x.updatedByAdminId]),
    );
    expect(admin['plan.tier.verify.products']).toBeNull();
    expect(admin['plan.tier.plus.products']).toBeNull();
    expect(admin['plan.tier.founding.products']).toBe('adm2');
    expect(admin['plan.tier.founding.price_kobo']).toBe('adm1');
    expect(admin['plan.extra_products.count']).toBe('adm1');
    expect(r.second).toEqual(r.first);
  });

  it('adds no setting row: a key with no saved row stays without one (its default is the owner count)', async () => {
    const rows = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      return settingsOf(tx);
    });
    expect(rows).toEqual([]);
  });

  it('raises each running tier to the new count of its tier, keeps its extras, dates and points, and runs again with no change', async () => {
    const r = await inRolledBackTx(async (tx) => {
      const v = await tier(tx, 'verify', 3, 200);
      const p = await tier(tx, 'plus', 6, 200, 5);
      const f = await tier(tx, 'founding', 10, 200, 10);
      // A tier in its last days is still running ("ending").
      const ending = await tier(tx, 'founding', 10, 2);
      const before = await rowsOf(tx, [v, p, f, ending]);
      await tx.$executeRawUnsafe(MIGRATE);
      const first = await rowsOf(tx, [v, p, f, ending]);
      await tx.$executeRawUnsafe(MIGRATE);
      const second = await rowsOf(tx, [v, p, f, ending]);
      return { before, first, second };
    });
    const NEW: Record<string, number> = { verify: 4, plus: 8, founding: 15 };
    expect(r.before.map((x) => x.productsIncluded)).toEqual([3, 6, 10, 10]);
    expect(r.first.map((x) => x.productsIncluded)).toEqual(
      r.first.map((x) => NEW[x.tierId]),
    );
    // Everything but the count (and the touched-at stamp) is as it was.
    r.first.forEach((row, i) => {
      expect(row.extraProducts).toBe(r.before[i].extraProducts);
      expect(row.pointsIncluded).toBe(r.before[i].pointsIncluded);
      expect(row.activeUntil).toEqual(r.before[i].activeUntil);
      expect(row.updatedAt.getTime()).toBeGreaterThan(
        r.before[i].updatedAt.getTime(),
      );
    });
    expect(r.second).toEqual(r.first);
  });

  it('only ever raises: an ended tier, a tier holding more than the new count, and a tier of another id are not touched', async () => {
    const r = await inRolledBackTx(async (tx) => {
      const endedF = await tier(tx, 'founding', 10, -1);
      const endedV = await tier(tx, 'verify', 3, -400);
      const more = await tier(tx, 'founding', 20, 100);
      const equal = await tier(tx, 'plus', 8, 100);
      const other = await tier(tx, 'legacy', 2, 100);
      const ids = [endedF, endedV, more, equal, other];
      const before = await rowsOf(tx, ids);
      await tx.$executeRawUnsafe(MIGRATE);
      const after = await rowsOf(tx, ids);
      return { before, after };
    });
    expect(r.after).toEqual(r.before);
  });

  it('its rollback refuses, changing nothing, while any of the three rows exists, and passes once none does', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await put(tx, 'plan.tier.plus.products', 8, null);
      await put(tx, 'plan.tier.founding.price_kobo', 999_900, 'adm1');
      const kept = await tier(tx, 'founding', 15, 100);
      let refused = '';
      // A failed statement aborts the transaction, so the refusal runs in a savepoint.
      await tx.$executeRawUnsafe('SAVEPOINT refusal');
      try {
        await tx.$executeRawUnsafe(ROLLBACK);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refusal');
      const still = await settingsOf(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM "PlanSetting" WHERE "key" = 'plan.tier.plus.products'`,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const after = await settingsOf(tx);
      // The rollback does not lower a running tier: a person may have published into the new places.
      const row = await rowsOf(tx, [kept]);
      return { refused, still, after, row };
    });
    expect(r.refused).toContain('TIER-COUNTS rollback');
    expect(r.refused).toContain('Nothing was changed');
    expect(r.still.map((x) => x.key)).toEqual([
      'plan.tier.founding.price_kobo',
      'plan.tier.plus.products',
    ]);
    expect(r.after.map((x) => x.key)).toEqual([
      'plan.tier.founding.price_kobo',
    ]);
    expect(r.row[0].productsIncluded).toBe(15);
  });
});

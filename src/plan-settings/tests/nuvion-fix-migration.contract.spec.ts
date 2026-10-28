// NUVION-FIX 1.1 (Nuvion's answers, 27 Oct 2026): naira cannot be added by card, mobile money or open banking, so the two
// switches `money.add_money_card_on` and `money.add_money_ussd_on` read 0 by default, and the migration
// `20261219090000_nuvion_fix` sets a saved row to 0 after keeping the old value, so its rollback can put it back.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs inside one transaction that is always
// rolled back, so PlanSetting and FxAccount are left as found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';

jest.setTimeout(60_000);

const FOLDER = join(
  __dirname,
  '../../../prisma/migrations/20261219090000_nuvion_fix',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');

const CARD = 'money.add_money_card_on';
const USSD = 'money.add_money_ussd_on';
const KEYS = `'${CARD}', '${USSD}', 'plan.event_name', 'money.other'`;

describe('NUVION-FIX 1.1: the migration turns a saved "on" off and keeps what it was', () => {
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
      `SELECT "key","value","updatedByAdminId" FROM "PlanSetting" WHERE "key" IN (${KEYS}) ORDER BY "key"`,
    );
  const clear = (tx: Tx) =>
    tx.$executeRawUnsafe(`DELETE FROM "PlanSetting" WHERE "key" IN (${KEYS})`);
  const backups = (tx: Tx) =>
    tx.$queryRawUnsafe<
      { key: string; value: unknown; updatedByAdminId: string | null }[]
    >(
      `SELECT "key","value","updatedByAdminId" FROM "PlanSettingNuvionFixBackup" ORDER BY "key"`,
    );
  const by = (rows: { key: string; value: unknown }[]) =>
    Object.fromEntries(rows.map((x) => [x.key, x.value]));

  it('moves a saved "on" to 0, keeps the old value and admin, leaves every other row alone, and runs again with no change', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe('DELETE FROM "PlanSettingNuvionFixBackup"');
      await put(tx, CARD, 1, 'adm1');
      await put(tx, USSD, 1, 'adm2');
      await put(tx, 'plan.event_name', ['Christmas event'], 'adm3');
      await put(tx, 'money.other', 1, 'adm4');
      await tx.$executeRawUnsafe(MIGRATE);
      const first = await all(tx);
      const kept = await backups(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const second = await all(tx);
      const keptAgain = await backups(tx);
      return { first, kept, second, keptAgain };
    });
    expect(by(r.first)).toEqual({
      [CARD]: 0,
      [USSD]: 0,
      'plan.event_name': ['Christmas event'],
      'money.other': 1,
    });
    const admin = Object.fromEntries(
      r.first.map((x) => [x.key, x.updatedByAdminId]),
    );
    expect(admin[CARD]).toBeNull();
    expect(admin[USSD]).toBeNull();
    expect(admin['plan.event_name']).toBe('adm3');
    expect(admin['money.other']).toBe('adm4');
    // What it was is kept, whoever saved it.
    expect(r.kept).toEqual([
      { key: CARD, value: 1, updatedByAdminId: 'adm1' },
      { key: USSD, value: 1, updatedByAdminId: 'adm2' },
    ]);
    expect(r.second).toEqual(r.first);
    expect(r.keptAgain).toEqual(r.kept);
  });

  it('leaves a row already at 0 as it is, keeps nothing for it, and adds no row when there is none', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe('DELETE FROM "PlanSettingNuvionFixBackup"');
      await tx.$executeRawUnsafe(MIGRATE);
      const none = await all(tx);
      await put(tx, CARD, 0, 'adm9');
      await tx.$executeRawUnsafe(MIGRATE);
      const off = await all(tx);
      const kept = await backups(tx);
      return { none, off, kept };
    });
    expect(r.none).toEqual([]);
    expect(r.off).toEqual([{ key: CARD, value: 0, updatedByAdminId: 'adm9' }]);
    expect(r.kept).toEqual([]);
  });

  it('adds the two nullable markers to FxAccount and changes no row of it', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(MIGRATE);
      return tx.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'FxAccount' AND column_name IN ('detailsAskedAt', 'detailsReadyAt') ORDER BY 1`,
      );
    });
    expect(r).toEqual([
      { column_name: 'detailsAskedAt', is_nullable: 'YES' },
      { column_name: 'detailsReadyAt', is_nullable: 'YES' },
    ]);
  });

  it('its rollback puts the old values back, drops what it added, and forgets the migration', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe('DELETE FROM "PlanSettingNuvionFixBackup"');
      await put(tx, CARD, 1, 'adm1');
      await put(tx, USSD, 1, 'adm2');
      await put(tx, 'money.other', 1, 'adm4');
      await tx.$executeRawUnsafe(MIGRATE);
      await tx.$executeRawUnsafe(ROLLBACK);
      const after = await all(tx);
      const [{ t }] = await tx.$queryRawUnsafe<{ t: string | null }[]>(
        `SELECT to_regclass('"PlanSettingNuvionFixBackup"')::text AS t`,
      );
      const cols = await tx.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'FxAccount' AND column_name IN ('detailsAskedAt', 'detailsReadyAt')`,
      );
      return { after, t, cols };
    });
    expect(r.after).toEqual([
      { key: CARD, value: 1, updatedByAdminId: 'adm1' },
      { key: USSD, value: 1, updatedByAdminId: 'adm2' },
      { key: 'money.other', value: 1, updatedByAdminId: 'adm4' },
    ]);
    expect(r.t).toBeNull();
    expect(r.cols).toEqual([]);
  });

  it('its rollback refuses, changing nothing, while an admin has set a row since; a row an admin removed stays removed', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe('DELETE FROM "PlanSettingNuvionFixBackup"');
      await put(tx, CARD, 1, 'adm1');
      await put(tx, USSD, 1, 'adm2');
      await tx.$executeRawUnsafe(MIGRATE);
      // Later an admin switched the card on again on purpose.
      await tx.$executeRawUnsafe(
        `UPDATE "PlanSetting" SET "value" = to_jsonb(1), "updatedByAdminId" = 'adm7' WHERE "key" = '${CARD}'`,
      );
      let refused = '';
      await tx.$executeRawUnsafe('SAVEPOINT refusal');
      try {
        await tx.$executeRawUnsafe(ROLLBACK);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refusal');
      const still = await all(tx);
      const keptStill = await backups(tx);
      // The admin keeps their card choice (leaves that key out of the backup, as rollback.sql says) and removes the USSD row:
      // the rollback now passes and puts nothing over their choice.
      await tx.$executeRawUnsafe(
        `DELETE FROM "PlanSettingNuvionFixBackup" WHERE "key" = '${CARD}'`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM "PlanSetting" WHERE "key" = '${USSD}'`,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const after = await all(tx);
      return { refused, still, keptStill, after };
    });
    expect(r.refused).toContain('NUVION-FIX rollback');
    expect(r.refused).toContain('Nothing was changed');
    expect(by(r.still)).toEqual({ [CARD]: 1, [USSD]: 0 });
    expect(r.keptStill).toHaveLength(2);
    expect(r.after).toEqual([
      { key: CARD, value: 1, updatedByAdminId: 'adm7' },
    ]);
  });

  it('NF-V1: its rollback also refuses when an admin saved 0 after the migration, and their 0 is not overwritten by the old 1', async () => {
    const r = await inRolledBackTx(async (tx) => {
      await clear(tx);
      await tx.$executeRawUnsafe('DELETE FROM "PlanSettingNuvionFixBackup"');
      await put(tx, CARD, 1, 'adm1');
      await put(tx, USSD, 1, 'adm2');
      await tx.$executeRawUnsafe(MIGRATE);
      // Later an admin saved the card switch as 0 on purpose: the value is the migration's, the author is not.
      await tx.$executeRawUnsafe(
        `UPDATE "PlanSetting" SET "value" = to_jsonb(0), "updatedByAdminId" = 'adm8' WHERE "key" = '${CARD}'`,
      );
      let refused = '';
      await tx.$executeRawUnsafe('SAVEPOINT refusal');
      try {
        await tx.$executeRawUnsafe(ROLLBACK);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refusal');
      const still = await all(tx);
      const keptStill = await backups(tx);
      // They decide: leave the card out of the backup. The USSD row the migration set is still the migration's, so it is restored.
      await tx.$executeRawUnsafe(
        `DELETE FROM "PlanSettingNuvionFixBackup" WHERE "key" = '${CARD}'`,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const after = await all(tx);
      return { refused, still, keptStill, after };
    });
    expect(r.refused).toContain('NUVION-FIX rollback');
    expect(r.refused).toContain('Nothing was changed');
    expect(r.still).toEqual([
      { key: CARD, value: 0, updatedByAdminId: 'adm8' },
      { key: USSD, value: 0, updatedByAdminId: null },
    ]);
    expect(r.keptStill).toHaveLength(2);
    expect(r.after).toEqual([
      { key: CARD, value: 0, updatedByAdminId: 'adm8' },
      { key: USSD, value: 1, updatedByAdminId: 'adm2' },
    ]);
  });
});

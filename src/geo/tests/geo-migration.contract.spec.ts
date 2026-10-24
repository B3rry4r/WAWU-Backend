import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Migration 20261124090000_geo_location (GEO-02) and its rollback.
 *
 * The two files run for real, in a scratch schema holding the four tables they
 * touch as they stood before the migration, so nothing in the shared test
 * database changes. Proved: existing accounts get Nigeria from a proved +234
 * phone and from nothing else; a row that already has a country keeps it; the
 * rollback takes the derived countries back out, and REFUSES (changing
 * nothing) while any person has saved a country, region or city.
 */

const NAME = '20261124090000_geo_location';
const DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations', NAME);
const migrationSql = readFileSync(join(DIR, 'migration.sql'), 'utf8');
// The first line is psql's `\set ON_ERROR_STOP on` (FIX-96); this runner is not
// psql, so it leaves out lines that start with a backslash.
const rollbackSql = readFileSync(join(DIR, 'rollback.sql'), 'utf8')
  .split('\n')
  .filter((line) => !line.startsWith('\\'))
  .join('\n');

describe('Where a person is: the migration and its rollback (GEO-02)', () => {
  let db: Client;
  const schema = `geo02_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const run = (sql: string) => db.query(sql);

  const rows = async () =>
    (
      await db.query<{
        wawuUserId: string;
        location: string | null;
        countryCode: string | null;
        countrySource: string | null;
        city: string | null;
      }>(
        `SELECT "wawuUserId", "location", "countryCode", "countrySource", "city"
         FROM "ProfileDetails" ORDER BY "wawuUserId"`,
      )
    ).rows;
  const byId = async () =>
    new Map((await rows()).map((r) => [r.wawuUserId, r]));
  const hasColumn = async (column: string) =>
    (
      await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'ProfileDetails' AND column_name = $2`,
        [schema, column],
      )
    ).rowCount === 1;
  const hasIndex = async () =>
    (
      await db.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'ProfileDetails_countryCode_regionCode_idx'`,
        [schema],
      )
    ).rowCount === 1;

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL ?? '');
    u.search = '';
    db = new Client({ connectionString: u.toString() });
    await db.connect();
    await run(`CREATE SCHEMA "${schema}"`);
    await run(`SET search_path TO "${schema}"`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });

  beforeEach(async () => {
    await run(`SET search_path TO "${schema}"`);
    await run(
      `DROP TABLE IF EXISTS "ProfileDetails", "UserProfile", "WalletIdentity", "FintavaWalletOpening" CASCADE`,
    );
    await run(`CREATE TABLE "UserProfile" ("wawuUserId" TEXT PRIMARY KEY)`);
    await run(
      `CREATE TABLE "WalletIdentity" ("wawuUserId" TEXT PRIMARY KEY, "verifiedPhone" TEXT)`,
    );
    await run(
      `CREATE TABLE "FintavaWalletOpening" ("wawuUserId" TEXT PRIMARY KEY, "phone" TEXT NOT NULL)`,
    );
    await run(`CREATE TABLE "ProfileDetails" (
      "wawuUserId" TEXT NOT NULL PRIMARY KEY,
      "location" TEXT,
      "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "openTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "threadsHandle" TEXT,
      "socialOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL
    )`);
    for (const id of [
      'wallet',
      'opening',
      'existing',
      'abroad',
      'nophone',
      'both',
    ]) {
      await run(`INSERT INTO "UserProfile" VALUES ('${id}')`);
    }
    // wallet and both: a proved +234 phone; abroad: a proved number that is not Nigerian.
    await run(
      `INSERT INTO "WalletIdentity" VALUES ('wallet', '+2348031234567'), ('both', '+2348039999999'), ('abroad', '+233241234567'), ('ghost', '+2348030000000')`,
    );
    await run(
      `INSERT INTO "FintavaWalletOpening" VALUES ('opening', '+2348021234567'), ('both', '+2348039999999')`,
    );
    // An account that already has profile fields and no country.
    await run(
      `INSERT INTO "ProfileDetails" ("wawuUserId", "location", "updatedAt") VALUES ('existing', 'Lagos, Nigeria', NOW())`,
    );
    await run(
      `INSERT INTO "WalletIdentity" VALUES ('existing', '+2348051111111')`,
    );
  });

  it('forward: Nigeria for a proved +234 phone, from either table, and for no one else', async () => {
    await run(migrationSql);
    const now = await byId();
    expect(now.get('wallet')).toMatchObject({
      countryCode: 'NG',
      countrySource: 'phone',
    });
    expect(now.get('opening')).toMatchObject({
      countryCode: 'NG',
      countrySource: 'phone',
    });
    expect(now.get('both')).toMatchObject({
      countryCode: 'NG',
      countrySource: 'phone',
    });
    expect(now.has('abroad')).toBe(false);
    expect(now.has('nophone')).toBe(false);
    // A wallet identity with no profile does not make one.
    expect(now.has('ghost')).toBe(false);
    // The row that was there keeps its own fields.
    expect(now.get('existing')).toMatchObject({
      location: 'Lagos, Nigeria',
      countryCode: 'NG',
      countrySource: 'phone',
    });
    expect(await hasIndex()).toBe(true);
  });

  it('forward: a country already there is never touched, and running it twice changes nothing more', async () => {
    await run(migrationSql);
    await run(
      `UPDATE "ProfileDetails" SET "countryCode" = 'GH', "countrySource" = 'profile', "city" = 'Accra' WHERE "wawuUserId" = 'wallet'`,
    );
    await run(`DROP INDEX "ProfileDetails_countryCode_regionCode_idx"`);
    for (const c of [
      'countrySource',
      'city',
      'regionName',
      'regionCode',
      'countryCode',
    ]) {
      // Put the table back as it was, but keep the data the person saved, to run the data step alone.
      expect(await hasColumn(c)).toBe(true);
    }
    const data = migrationSql.slice(migrationSql.indexOf('INSERT INTO'));
    await run(data);
    const now = await byId();
    expect(now.get('wallet')).toMatchObject({
      countryCode: 'GH',
      countrySource: 'profile',
      city: 'Accra',
    });
    expect(now.get('opening')).toMatchObject({ countryCode: 'NG' });
  });

  it('rollback: with only derived countries it removes them, the rows it made, and the columns, and leaves the other fields', async () => {
    await run(migrationSql);
    await run(rollbackSql);
    for (const c of [
      'countryCode',
      'regionCode',
      'regionName',
      'city',
      'countrySource',
    ]) {
      expect(await hasColumn(c)).toBe(false);
    }
    expect(await hasIndex()).toBe(false);
    const { rows: left } = await db.query<{
      wawuUserId: string;
      location: string | null;
    }>(`SELECT "wawuUserId", "location" FROM "ProfileDetails" ORDER BY 1`);
    expect(left).toEqual([
      { wawuUserId: 'existing', location: 'Lagos, Nigeria' },
    ]);
  });

  it.each([
    [
      'a country the person chose',
      `"countryCode" = 'GH', "countrySource" = 'profile'`,
    ],
    ['a region', `"regionCode" = 'NG-LA', "regionName" = 'Lagos'`],
    ['a city', `"city" = 'Ikeja'`],
    [
      'a country with no source at all',
      `"countryCode" = 'GH', "countrySource" = NULL`,
    ],
  ])(
    'rollback refuses, and changes nothing, while someone has saved %s',
    async (_what, set) => {
      await run(migrationSql);
      await run(
        `UPDATE "ProfileDetails" SET ${set} WHERE "wawuUserId" = 'wallet'`,
      );
      const before = await rows();
      await expect(run(rollbackSql)).rejects.toThrow(/GEO-02 rollback/);
      expect(await rows()).toEqual(before);
      expect(await hasColumn('countryCode')).toBe(true);
      expect(await hasIndex()).toBe(true);
    },
  );

  it('rollback, forward again: the same result as the first forward', async () => {
    await run(migrationSql);
    const first = await rows();
    await run(rollbackSql);
    await run(migrationSql);
    expect(await rows()).toEqual(first);
  });
});

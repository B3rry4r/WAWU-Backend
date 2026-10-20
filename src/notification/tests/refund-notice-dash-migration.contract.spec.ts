import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Migration 20261026090000_no_em_dash_stored_refund_notice (SWEEP-APP-1) and its
 * rollback (FIX-64): the migration keeps the old body of every notice it
 * rewrites, and rollback.sql puts them back, byte for byte.
 *
 * The two files run for real, but in a scratch schema of their own holding the
 * two tables they touch ("Notification" with the columns they read, and
 * "_prisma_migrations"), so nothing in the shared test database is changed.
 */

const NAME = '20261026090000_no_em_dash_stored_refund_notice';
const DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations', NAME);
const migrationSql = readFileSync(join(DIR, 'migration.sql'), 'utf8');
const rollbackSql = readFileSync(join(DIR, 'rollback.sql'), 'utf8');

const DASH = '—';
const OLD = (amount: string) =>
  `Your ${amount} has been refunded ${DASH} the creator did not reply within 24 hours.`;
const NEW = (amount: string) =>
  `Your ${amount} has been refunded. The creator did not reply within 24 hours.`;

describe('No em-dash in stored refund notices: the migration and its rollback (FIX-64)', () => {
  let db: Client;
  const schema = `fix64_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  /** Rows that match, and rows that do not (each kept exactly as written). */
  const MATCH = {
    a: OLD('N500'),
    b: OLD('N1,200'),
    c: `Note: ${OLD('N5')} Thanks.`,
    d: OLD('N7'),
  };
  const OTHER = {
    clean: NEW('N500'),
    otherDash: `Your tip ${DASH} thank you`,
    hyphen: `Your N500 has been refunded - the creator did not reply within 24 hours.`,
    otherTail: `Your N500 has been refunded ${DASH} the creator replied.`,
    empty: '',
  };

  const run = (sql: string) => db.query(sql);
  const bodies = async (): Promise<Record<string, string>> => {
    const { rows } = await db.query<{ id: string; body: string }>(
      'SELECT "id", "body" FROM "Notification" ORDER BY "id"',
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.body]));
  };
  const backups = async (): Promise<Record<string, string>> => {
    const { rows } = await db.query<{ id: string; body: string }>(
      'SELECT "notificationId" AS id, "body" FROM "NotificationRefundNoticeBackup" ORDER BY 1',
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.body]));
  };
  const hasBackupTable = async () =>
    (
      await db.query<{ t: string | null }>(
        `SELECT to_regclass('"NotificationRefundNoticeBackup"')::text AS t`,
      )
    ).rows[0].t !== null;
  const recorded = async () =>
    (
      await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = $1',
        [NAME],
      )
    ).rows[0].n;

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL ?? '');
    u.search = '';
    db = new Client({ connectionString: u.toString() });
    await db.connect();
    await run(`CREATE SCHEMA "${schema}"`);
    await run(`SET search_path TO "${schema}"`);
    await run(
      'CREATE TABLE "Notification" ("id" TEXT PRIMARY KEY, "body" TEXT NOT NULL)',
    );
    await run(
      'CREATE TABLE "_prisma_migrations" ("migration_name" TEXT NOT NULL)',
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });

  beforeEach(async () => {
    await run(`SET search_path TO "${schema}"`);
    await run('DROP TABLE IF EXISTS "NotificationRefundNoticeBackup"');
    await run('DELETE FROM "Notification"');
    await run('DELETE FROM "_prisma_migrations"');
    for (const [k, body] of Object.entries({ ...MATCH, ...OTHER })) {
      await db.query(
        'INSERT INTO "Notification" ("id", "body") VALUES ($1, $2)',
        [k, body],
      );
    }
  });

  it('forward: the notices with the dash are copied first, then rewritten; every other row is left alone', async () => {
    await run(migrationSql);
    expect(await backups()).toEqual(MATCH);
    const now = await bodies();
    expect(now.a).toBe(NEW('N500'));
    expect(now.b).toBe(NEW('N1,200'));
    expect(now.c).toBe(`Note: ${NEW('N5')} Thanks.`);
    expect(now.d).toBe(NEW('N7'));
    for (const [k, body] of Object.entries(OTHER)) expect(now[k]).toBe(body);
    // No dash left in a rewritten notice.
    for (const k of Object.keys(MATCH)) expect(now[k]).not.toContain(DASH);
  });

  it('forward, rollback, forward again: the rollback gives back every body exactly and the second forward does the same as the first', async () => {
    const before = await bodies();
    await run(migrationSql);
    const afterFirst = await bodies();
    await run(
      `INSERT INTO "_prisma_migrations" ("migration_name") VALUES ('${NAME}')`,
    );

    await run(rollbackSql);
    expect(await bodies()).toEqual(before);
    expect(await hasBackupTable()).toBe(false);
    expect(await recorded()).toBe('0');

    await run(migrationSql);
    expect(await backups()).toEqual(MATCH);
    expect(await bodies()).toEqual(afterFirst);
  });

  it('a notice deleted or changed since the migration does not stop the rollback; the others are put back', async () => {
    await run(migrationSql);
    await run(`DELETE FROM "Notification" WHERE "id" = 'a'`);
    await run(
      `UPDATE "Notification" SET "body" = "body" || ' (edited)' WHERE "id" = 'b'`,
    );
    await run(rollbackSql);
    const now = await bodies();
    expect(now.a).toBeUndefined();
    expect(now.b).toBe(`${NEW('N1,200')} (edited)`);
    expect(now.c).toBe(MATCH.c);
    expect(now.d).toBe(MATCH.d);
    for (const [k, body] of Object.entries(OTHER)) expect(now[k]).toBe(body);
    expect(await hasBackupTable()).toBe(false);
  });

  it('a database with no notice to rewrite: the table is made empty and nothing changes', async () => {
    await run('DELETE FROM "Notification"');
    for (const [k, body] of Object.entries(OTHER)) {
      await db.query(
        'INSERT INTO "Notification" ("id", "body") VALUES ($1, $2)',
        [k, body],
      );
    }
    await run(migrationSql);
    expect(await backups()).toEqual({});
    expect(await bodies()).toEqual(OTHER);
    await run(rollbackSql);
    expect(await bodies()).toEqual(OTHER);
  });
});

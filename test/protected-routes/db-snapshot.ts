import { Client } from 'pg';

/**
 * Leaves the test database exactly as the suite found it (README, "Test
 * hygiene rules").
 *
 * The protected route suite drives ~230 real routes, many of which write:
 * profiles, purchases, pending charges, audit rows, counters on rows that
 * already existed. Listing every table each probe might touch would rot the
 * first time a route started writing somewhere new, so instead the whole
 * public schema is snapshotted before the first request and restored after
 * the last one.
 *
 * Restore runs in ONE transaction with `session_replication_role = replica`,
 * which suspends foreign-key and other triggers for that transaction only, so
 * tables can be rewritten in any order. The end state is the snapshot, which
 * was consistent when it was taken, so nothing is left dangling. That setting
 * needs a superuser, which the local and CI test databases both use.
 *
 * Only tables whose contents actually changed are rewritten.
 */

export interface DbSnapshot {
  tables: Map<string, string>;
}

const SKIP_TABLES = new Set(['_prisma_migrations']);

/** Refuses anything that does not look like a disposable test database. */
export function assertDisposableDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (
    /test|protected/i.test(name) ||
    process.env.PROTECTED_ROUTES_ALLOW_DB === name
  )
    return;
  throw new Error(
    `The protected route suite rewrites the database it runs against back to its starting state. ` +
      `"${name}" does not look like a test database. Point DATABASE_URL at one, or set ` +
      `PROTECTED_ROUTES_ALLOW_DB=${name} if this really is disposable.`,
  );
}

async function tableNames(client: Client): Promise<string[]> {
  const res = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return res.rows.map((r) => r.tablename).filter((t) => !SKIP_TABLES.has(t));
}

async function tableContents(client: Client, table: string): Promise<string> {
  // Ordered by the whole row's text so the comparison does not depend on
  // physical order.
  const res = await client.query<{ rows: unknown }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table}" t`,
  );
  return JSON.stringify(res.rows[0].rows);
}

export async function takeSnapshot(url: string): Promise<DbSnapshot> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = new Map<string, string>();
    for (const t of await tableNames(client))
      tables.set(t, await tableContents(client, t));
    return { tables };
  } finally {
    await client.end();
  }
}

/** Returns the names of the tables it had to rewrite. */
export async function restoreSnapshot(
  url: string,
  snapshot: DbSnapshot,
): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  const changed: string[] = [];
  try {
    for (const t of await tableNames(client)) {
      const before = snapshot.tables.get(t);
      const now = await tableContents(client, t);
      if (before === undefined) {
        // A table that did not exist at snapshot time: a migration ran
        // mid-suite, which the suite never does. Leave it alone.
        continue;
      }
      if (before !== now) changed.push(t);
    }
    if (changed.length === 0) return changed;
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    for (const t of changed) {
      await client.query(`DELETE FROM "${t}"`);
      await client.query(
        `INSERT INTO "${t}" SELECT * FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb)`,
        [snapshot.tables.get(t)],
      );
    }
    await client.query('COMMIT');
    return changed;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

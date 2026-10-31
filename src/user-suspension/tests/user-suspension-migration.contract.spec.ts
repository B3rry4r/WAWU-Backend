/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
// USER-SUSPEND (R-121): the migration `20261229090000_user_suspension` is applied (the table, its checks, the one-in-force
// index), its rollback REFUSES while any suspension is in force and otherwise drops the table and nothing else, and the
// migration applies again. Real database, no HTTP. Every check runs in one transaction that is always rolled back.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';

jest.setTimeout(60_000);

const FOLDER = join(
  __dirname,
  '../../../prisma/migrations/20261229090000_user_suspension',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql, so it leaves out such lines.
const script = (file: string, keep: (line: string) => boolean = () => true) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\') && keep(line))
    .join('\n');
const ROLLBACK = script('rollback.sql');
// An enum value stays after a rollback (Postgres cannot drop one), so applying again leaves the ALTER TYPE lines out.
const MIGRATE_AGAIN = script(
  'migration.sql',
  (line) => !line.startsWith('ALTER TYPE'),
);
const COLUMNS = [
  'id',
  'liftNote',
  'liftedAt',
  'liftedByAdminEmail',
  'liftedByAdminId',
  'liftedByAdminRole',
  'note',
  'reason',
  'reportId',
  'suspendedAt',
  'suspendedByAdminEmail',
  'suspendedByAdminId',
  'suspendedByAdminRole',
  'wawuUserId',
].sort();

describe('USER-SUSPEND: the UserSuspension migration, its rollback and the migration again', () => {
  let prisma: PrismaService;
  const person = `usm-mig-${randomUUID()}`;

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
  const columnsOf = async (tx: Tx): Promise<string[]> =>
    (
      await tx.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'UserSuspension' ORDER BY column_name`,
      )
    ).map((r) => r.column_name);
  const insert = (extra: Record<string, string | null> = {}, who = person) => {
    const cols: Record<string, string | null> = {
      id: randomUUID(),
      wawuUserId: who,
      reason: 'spam',
      suspendedByAdminId: 'a1',
      suspendedByAdminEmail: 'a@x.dev',
      suspendedByAdminRole: 'support',
      ...extra,
    };
    const names = Object.keys(cols)
      .map((c) => `"${c}"`)
      .join(',');
    const values = Object.values(cols)
      .map((v) => (v === null ? 'NULL' : `'${v}'`))
      .join(',');
    return `INSERT INTO "UserSuspension" (${names}) VALUES (${values})`;
  };
  const lifted = { liftedAt: '2026-10-31T00:00:00Z', liftedByAdminId: 'a2' };

  it('is applied: the columns, the indexes, and the checks on the reason, the note and a lift', async () => {
    const result = await inRolledBackTx(async (tx) => {
      const fails = async (sql: string): Promise<boolean> => {
        await tx.$executeRawUnsafe('SAVEPOINT s');
        try {
          await tx.$executeRawUnsafe(sql);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
          return false;
        } catch {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
          return true;
        }
      };
      return {
        columns: await columnsOf(tx),
        indexes: (
          await tx.$queryRawUnsafe<{ indexname: string }[]>(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'UserSuspension' ORDER BY indexname`,
          )
        ).map((r) => r.indexname),
        badReason: await fails(insert({ reason: 'rude' }, 'p1')),
        longNote: await fails(insert({ note: 'x'.repeat(1001) }, 'p2')),
        liftWithoutWho: await fails(
          insert({ liftedAt: '2026-10-31T00:00:00Z' }, 'p3'),
        ),
        goodRow: !(await fails(insert({}, 'p4'))),
        goodLifted: !(await fails(insert(lifted, 'p5'))),
      };
    });
    expect(result.columns).toEqual(COLUMNS);
    expect(result.indexes).toEqual([
      'UserSuspension_in_force_key',
      'UserSuspension_liftedAt_idx',
      'UserSuspension_pkey',
      'UserSuspension_wawuUserId_suspendedAt_idx',
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        badReason: true,
        longNote: true,
        liftWithoutWho: true,
        goodRow: true,
        goodLifted: true,
      }),
    );
  });

  it('one suspension in force per person, any number lifted', async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        await tx.$executeRawUnsafe(insert());
        await tx.$executeRawUnsafe(insert());
      }),
    ).rejects.toThrow(/UserSuspension_in_force_key|unique/);
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(insert(lifted));
      await tx.$executeRawUnsafe(insert(lifted));
      await tx.$executeRawUnsafe(insert());
    });
  });

  it('the rollback REFUSES while a suspension is in force and keeps it', async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        await tx.$executeRawUnsafe(insert());
        await tx.$executeRawUnsafe(ROLLBACK);
      }),
    ).rejects.toThrow(/rollback refused: a UserSuspension is still in force/);
  });

  it('rolls back with only lifted history, touches no other table, and the migration applies again (up, down, up)', async () => {
    const result = await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM "UserSuspension"`);
      await tx.$executeRawUnsafe(insert(lifted));
      const before = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "UgcReport"`,
          )
        )[0].n,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const gone = await columnsOf(tx);
      const after = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "UgcReport"`,
          )
        )[0].n,
      );
      await tx.$executeRawUnsafe(MIGRATE_AGAIN);
      const again = await columnsOf(tx);
      await tx.$executeRawUnsafe(insert());
      return { gone, again, before, after };
    });
    expect(result.gone).toEqual([]);
    expect(result.after).toBe(result.before);
    expect(result.again).toEqual(COLUMNS);
  });
});

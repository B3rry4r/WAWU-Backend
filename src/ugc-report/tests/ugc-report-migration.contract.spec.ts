// REPORT-UGC: the migration `20261228090000_ugc_reports` is applied (the table, its checks and its one-report-per-person
// index), its rollback REFUSES while any report exists and otherwise drops the table and nothing else, and the migration
// applies again. Real database, no HTTP. Every check runs in one transaction that is always rolled back.

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
  '../../../prisma/migrations/20261228090000_ugc_reports',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql, so it leaves out such lines.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
const COLUMNS = [
  'createdAt',
  'emailedAt',
  'id',
  'kind',
  'note',
  'reason',
  'reporterWawuId',
  'resolution',
  'resolvedAt',
  'resolvedByAdminEmail',
  'resolvedByAdminId',
  'resolvedByAdminRole',
  'status',
  'subjectWawuId',
  'targetId',
];

describe('REPORT-UGC: the UgcReport migration, its rollback and the migration again', () => {
  let prisma: PrismaService;
  const who = `ugc-mig-${randomUUID()}`;

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
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'UgcReport' ORDER BY column_name`,
      )
    ).map((r) => r.column_name);
  const row = (kind = 'piece', target = randomUUID(), reporter = who) =>
    `INSERT INTO "UgcReport" ("id","kind","targetId","subjectWawuId","reporterWawuId","reason")
     VALUES ('${randomUUID()}','${kind}','${target}','someone','${reporter}','spam')`;

  it('is applied: the columns, the indexes, and the checks on kind, status and the note', async () => {
    const result = await inRolledBackTx(async (tx) => {
      const columns = await columnsOf(tx);
      const indexes = (
        await tx.$queryRawUnsafe<{ indexname: string }[]>(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'UgcReport' ORDER BY indexname`,
        )
      ).map((r) => r.indexname);
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
        columns,
        indexes,
        badKind: await fails(row('photo')),
        badStatus: await fails(
          row()
            .replace('"reason")', '"reason","status")')
            .replace(`'spam')`, `'spam','gone')`),
        ),
        longNote: await fails(
          row()
            .replace('"reason")', '"reason","note")')
            .replace(`'spam')`, `'spam','${'x'.repeat(501)}')`),
        ),
        goodKinds: !(await fails(row('direct_message'))),
      };
    });
    expect(result.columns).toEqual(COLUMNS);
    expect(result.indexes).toEqual([
      'UgcReport_kind_targetId_idx',
      'UgcReport_pkey',
      'UgcReport_reporterWawuId_kind_idx',
      'UgcReport_reporterWawuId_kind_targetId_key',
      'UgcReport_status_createdAt_idx',
      'UgcReport_subjectWawuId_idx',
    ]);
    expect(result.badKind).toBe(true);
    expect(result.badStatus).toBe(true);
    expect(result.longNote).toBe(true);
    expect(result.goodKinds).toBe(true);
  });

  it('one report per person per item: a second row for the same person, kind and item is refused', async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        const target = randomUUID();
        await tx.$executeRawUnsafe(row('piece', target));
        await tx.$executeRawUnsafe(row('piece', target));
      }),
    ).rejects.toThrow(/UgcReport_reporterWawuId_kind_targetId_key|unique/);
  });

  it('the rollback REFUSES while any report exists and keeps it', async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        await tx.$executeRawUnsafe(row());
        await tx.$executeRawUnsafe(ROLLBACK);
      }),
    ).rejects.toThrow(/rollback refused: a UgcReport row exists/);
  });

  it('rolls back an empty table without touching any other row, and the migration applies again (up, down, up)', async () => {
    const result = await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM "UgcReport"`);
      const dmBefore = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "DmReport"`,
          )
        )[0].n,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const gone = await columnsOf(tx);
      const dmAfter = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "DmReport"`,
          )
        )[0].n,
      );
      await tx.$executeRawUnsafe(MIGRATE);
      const again = await columnsOf(tx);
      await tx.$executeRawUnsafe(row());
      return { gone, again, dmBefore, dmAfter };
    });
    expect(result.gone).toEqual([]);
    expect(result.dmAfter).toBe(result.dmBefore);
    expect(result.again).toEqual(COLUMNS);
  });
});

// AITOOLS-02: the migration `20261101100000_ai_tool_job_outputs` applies on a
// database that already holds AiToolJob rows, and its rollback keeps every row.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every
// check runs inside one transaction that is always rolled back, so the table
// is left as it was found (Postgres DDL is transactional).

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
  '../../../prisma/migrations/20261101100000_ai_tool_job_outputs',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is
// not psql, so it leaves out lines that start with a backslash.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
const NEW_COLUMNS = ['inputRef', 'outputs', 'providerRef'];

describe('AITOOLS-02: the AiToolJob migration applies on existing rows and rolls back without losing them', () => {
  let prisma: PrismaService;
  const who = `ait02-mig-${randomUUID()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
  /** Runs `body` in a transaction that is always rolled back; returns what `body` returned. */
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
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'AiToolJob' AND column_name = ANY($1::text[])
          ORDER BY column_name`,
        NEW_COLUMNS,
      )
    ).map((r) => r.column_name);

  /** One job row as the table looked before the migration (only the columns AITOOLS-01 had). */
  const oldRow = (
    n: number,
    state: 'working' | 'done' | 'failed',
    audioKey: string | null,
  ) =>
    `INSERT INTO "AiToolJob"
       ("id","wawuUserId","tool","idempotencyKey","requestHash","voiceId","characters","units","costPoints","state","audioKey","failureCode")
     VALUES ('${randomUUID()}','${who}','voiceover_per_min','key-${n}-${randomUUID()}','${'a'.repeat(64)}','ada',${10 * n},1,250,'${state}',${
       audioKey ? `'${audioKey}'` : 'NULL'
     },${state === 'failed' ? `'provider_failed'` : 'NULL'})`;

  /** Rows of the person, ordered, with the columns that exist before the migration. */
  const oldColumns = (tx: Tx) =>
    tx.$queryRawUnsafe<
      {
        id: string;
        state: string;
        audioKey: string | null;
        costPoints: number;
      }[]
    >(
      `SELECT "id","state","audioKey","costPoints" FROM "AiToolJob" WHERE "wawuUserId" = $1 ORDER BY "idempotencyKey"`,
      who,
    );

  /** Puts the table back to its state before the migration, with three rows of the old kind in it. */
  async function asBeforeTheMigration(tx: Tx) {
    // Done VoiceOver jobs of the old kind keep their audio by `audioKey` alone; the new columns hold nothing yet.
    await tx.$executeRawUnsafe(
      `UPDATE "AiToolJob" SET "outputs" = NULL, "providerRef" = NULL, "inputRef" = NULL`,
    );
    await tx.$executeRawUnsafe(oldRow(1, 'done', `ai/voiceover/${who}/1.mp3`));
    await tx.$executeRawUnsafe(oldRow(2, 'failed', null));
    await tx.$executeRawUnsafe(oldRow(3, 'working', null));
    await tx.$executeRawUnsafe(ROLLBACK);
  }

  it('rolls back without losing a row: the three columns go and every job keeps its state, cost and audio key; the migration then applies again on those rows', async () => {
    const result = await inRolledBackTx(async (tx) => {
      expect(await columnsOf(tx)).toEqual(NEW_COLUMNS);
      await asBeforeTheMigration(tx);
      const goneColumns = await columnsOf(tx);
      const before = await oldColumns(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const afterColumns = await columnsOf(tx);
      const after = await oldColumns(tx);
      const fresh = await tx.$queryRawUnsafe<
        {
          outputs: unknown;
          providerRef: string | null;
          inputRef: string | null;
        }[]
      >(
        `SELECT "outputs","providerRef","inputRef" FROM "AiToolJob" WHERE "wawuUserId" = $1`,
        who,
      );
      return { goneColumns, before, afterColumns, after, fresh };
    });
    expect(result.goneColumns).toEqual([]);
    expect(result.before).toHaveLength(3);
    expect(result.before.map((r) => r.state).sort()).toEqual([
      'done',
      'failed',
      'working',
    ]);
    expect(result.before.find((r) => r.state === 'done')!.audioKey).toBe(
      `ai/voiceover/${who}/1.mp3`,
    );
    // Applied on rows that already exist: they are all still there, unchanged, with the new columns empty.
    expect(result.afterColumns).toEqual(NEW_COLUMNS);
    expect(result.after).toEqual(result.before);
    expect(result.fresh).toHaveLength(3);
    for (const r of result.fresh)
      expect(r).toEqual({ outputs: null, providerRef: null, inputRef: null });
  });

  it('the rollback also goes through for a job that holds only its own audio in `outputs`, and keeps the row', async () => {
    const left = await inRolledBackTx(async (tx) => {
      const key = `ai/voiceover/${who}/own.mp3`;
      await tx.$executeRawUnsafe(oldRow(4, 'done', key));
      await tx.$executeRawUnsafe(
        `UPDATE "AiToolJob" SET "outputs" = '[{"kind":"audio","key":"${key}"}]'::jsonb WHERE "wawuUserId" = $1`,
        who,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      return {
        columns: await columnsOf(tx),
        rows: await oldColumns(tx),
      };
    });
    expect(left.columns).toEqual([]);
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0].audioKey).toBe(`ai/voiceover/${who}/own.mp3`);
  });

  it.each([
    [
      'words a person paid points for',
      `"outputs" = '[{"kind":"text","text":"Hello"}]'::jsonb`,
    ],
    [
      'a subtitles output',
      `"outputs" = '[{"kind":"subtitles","text":"1"}]'::jsonb`,
    ],
    [
      'an audio output that is not the job audio',
      `"outputs" = '[{"kind":"audio","key":"ai/other/x.mp3"}]'::jsonb`,
    ],
    ['the provider job id', `"providerRef" = 'p-1'`],
    ['the person upload', `"inputRef" = 'ai/input/x.m4a'`],
  ])(
    'the rollback refuses and changes nothing while a row holds %s',
    async (_what, set) => {
      const out = await inRolledBackTx(async (tx) => {
        const key = `ai/voiceover/${who}/k.mp3`;
        await tx.$executeRawUnsafe(oldRow(5, 'done', key));
        await tx.$executeRawUnsafe(
          `UPDATE "AiToolJob" SET ${set} WHERE "wawuUserId" = $1`,
          who,
        );
        // A failed statement aborts a Postgres transaction, so the rollback runs in a savepoint.
        await tx.$executeRawUnsafe('SAVEPOINT roll');
        let refused: string | null = null;
        try {
          await tx.$executeRawUnsafe(ROLLBACK);
        } catch (e) {
          refused = (e as Error).message;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT roll');
        }
        return { refused, columns: await columnsOf(tx) };
      });
      expect(out.refused).toMatch(/AITOOLS-02 rollback.*Nothing was changed/);
      expect(out.columns).toEqual(NEW_COLUMNS);
    },
  );

  it('the migration folder holds only the three nullable columns (additive)', () => {
    expect(MIGRATE.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim()).toBe(
      'ALTER TABLE "AiToolJob" ADD COLUMN "outputs" JSONB, ADD COLUMN "providerRef" TEXT, ADD COLUMN "inputRef" TEXT;',
    );
  });
});

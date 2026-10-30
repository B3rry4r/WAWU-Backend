// AITOOLS-11: the migration `20261222090000_ai_cloned_voice` applies on a database that already holds AiToolJob rows,
// its rollback REFUSES while a cloned voice row exists (a row is a voice the provider may still hold, and a consent) and
// otherwise drops the table without touching any other row, and the migration then applies again.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs inside one transaction that is
// always rolled back, so the table is left as it was found (Postgres DDL is transactional).

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
  '../../../prisma/migrations/20261222090000_ai_cloned_voice',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql, so it leaves out lines that
// start with a backslash.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
const COLUMNS = [
  'consentAt',
  'consentLine',
  'createdAt',
  'id',
  'jobId',
  'name',
  'providerVoiceId',
  'removedAt',
  'wawuUserId',
];

describe('AITOOLS-11: the AiClonedVoice migration, its rollback and the migration again', () => {
  let prisma: PrismaService;
  const who = `ait11-mig-${randomUUID()}`;

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
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'AiClonedVoice' ORDER BY column_name`,
      )
    ).map((r) => r.column_name);
  const row = (jobId = randomUUID(), providerVoiceId: string | null = 'v1') =>
    `INSERT INTO "AiClonedVoice" ("id","wawuUserId","jobId","providerVoiceId","name","consentLine","consentAt")
     VALUES ('${randomUUID()}','${who}','${jobId}',${providerVoiceId ? `'${providerVoiceId}'` : 'NULL'},'My voice','I agree.', now())`;
  const jobRow = () =>
    `INSERT INTO "AiToolJob" ("id","wawuUserId","tool","idempotencyKey","requestHash","voiceId","characters","units","costPoints","state")
     VALUES ('${randomUUID()}','${who}','voice_clone_once','k-${randomUUID()}','${'a'.repeat(64)}','',0,1,100,'working')`;

  it('is applied: the table, its columns and its checks and indexes are there', async () => {
    const result = await inRolledBackTx(async (tx) => {
      const columns = await columnsOf(tx);
      await tx.$executeRawUnsafe(row());
      const indexes = (
        await tx.$queryRawUnsafe<{ indexname: string }[]>(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'AiClonedVoice' ORDER BY indexname`,
        )
      ).map((r) => r.indexname);
      let nameCheck = '';
      try {
        await tx.$executeRawUnsafe('SAVEPOINT s1');
        await tx.$executeRawUnsafe(
          row().replace("'My voice'", `'${'x'.repeat(81)}'`),
        );
      } catch (e) {
        nameCheck = (e as Error).message;
      }
      return { columns, indexes, nameCheck };
    });
    expect(result.columns).toEqual(COLUMNS);
    expect(result.indexes).toEqual([
      'AiClonedVoice_jobId_key',
      'AiClonedVoice_pkey',
      'AiClonedVoice_removedAt_idx',
      'AiClonedVoice_wawuUserId_idx',
    ]);
    expect(result.nameCheck).toMatch(/AiClonedVoice_name_check|violates check/);
  });

  it('one clone for one job: a second row for the same job is refused', async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        const jobId = randomUUID();
        await tx.$executeRawUnsafe(row(jobId));
        await tx.$executeRawUnsafe(row(jobId));
      }),
    ).rejects.toThrow(/AiClonedVoice_jobId_key|unique/);
  });

  it('the rollback REFUSES while any cloned voice row exists (made, or still being made) and keeps it', async () => {
    for (const providerVoiceId of ['v1', null])
      await expect(
        inRolledBackTx(async (tx) => {
          await tx.$executeRawUnsafe(row(randomUUID(), providerVoiceId));
          await tx.$executeRawUnsafe(ROLLBACK);
        }),
      ).rejects.toThrow(/rollback refused: a cloned voice row exists/);
  });

  it('rolls back without touching any other row, and the migration applies again (up, down, up)', async () => {
    const result = await inRolledBackTx(async (tx) => {
      // Other rows that must survive: a job of the tool.
      await tx.$executeRawUnsafe(jobRow());
      await tx.$executeRawUnsafe(`DELETE FROM "AiClonedVoice"`);
      const jobsBefore = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "AiToolJob" WHERE "wawuUserId" = '${who}'`,
          )
        )[0].n,
      );
      await tx.$executeRawUnsafe(ROLLBACK);
      const gone = await columnsOf(tx);
      const jobsAfter = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "AiToolJob" WHERE "wawuUserId" = '${who}'`,
          )
        )[0].n,
      );
      await tx.$executeRawUnsafe(MIGRATE);
      const again = await columnsOf(tx);
      await tx.$executeRawUnsafe(row());
      const rows = Number(
        (
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "AiClonedVoice" WHERE "wawuUserId" = '${who}'`,
          )
        )[0].n,
      );
      return { jobsBefore, jobsAfter, gone, again, rows };
    });
    expect(result.gone).toEqual([]);
    expect(result.jobsBefore).toBe(1);
    expect(result.jobsAfter).toBe(1);
    expect(result.again).toEqual(COLUMNS);
    expect(result.rows).toBe(1);
  });
});

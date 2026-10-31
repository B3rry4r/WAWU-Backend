// REC-DELETE round 1: the migration `20261227090000_conversation_note_index` adds one partial index to AiToolJob (the notes
// of Receptionist conversations, by age), its rollback drops that index and touches no row, and the migration applies
// again. Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs inside one transaction that
// is always rolled back (Postgres DDL is transactional).

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
  '../../../prisma/migrations/20261227090000_conversation_note_index',
);
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
const INDEX = 'AiToolJob_conversation_note_idx';

describe('REC-DELETE: the conversation note index migration, its rollback and the migration again', () => {
  let prisma: PrismaService;
  const who = `recdel-mig-${randomUUID()}`;

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
  const indexDef = async (tx: Tx): Promise<string | null> =>
    (
      await tx.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}'`,
      )
    )[0]?.indexdef ?? null;
  const jobRow = (ref: string | null) =>
    `INSERT INTO "AiToolJob" ("id","wawuUserId","tool","idempotencyKey","requestHash","voiceId","characters","units","costPoints","state","providerRef")
     VALUES ('${randomUUID()}','${who}','receptionist_message','k-${randomUUID()}','${'a'.repeat(64)}','',0,1,20,'done',${ref === null ? 'NULL' : `'${ref}'`})`;

  it('is applied: a partial index on the age of the rows that note a conversation', async () => {
    const def = await inRolledBackTx((tx) => indexDef(tx));
    expect(def).toMatch(/\("createdAt"\)/);
    expect(def).toMatch(/providerRef/);
    expect(def).toMatch(/conversation:%/);
  });

  it('rolls back by dropping the index only, touches no row, and the migration applies again (up, down, up)', async () => {
    const result = await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(jobRow('conversation:conv-x'));
      await tx.$executeRawUnsafe(jobRow(null));
      const count = async () =>
        Number(
          (
            await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM "AiToolJob" WHERE "wawuUserId" = '${who}'`,
            )
          )[0].n,
        );
      const noted = async () =>
        Number(
          (
            await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM "AiToolJob" WHERE "wawuUserId" = '${who}' AND "providerRef" LIKE 'conversation:%'`,
            )
          )[0].n,
        );
      const before = { jobs: await count(), noted: await noted() };
      await tx.$executeRawUnsafe(ROLLBACK);
      const gone = await indexDef(tx);
      const after = { jobs: await count(), noted: await noted() };
      await tx.$executeRawUnsafe(MIGRATE);
      const again = await indexDef(tx);
      return { before, after, gone, again };
    });
    expect(result.gone).toBeNull();
    expect(result.before).toEqual({ jobs: 2, noted: 1 });
    expect(result.after).toEqual({ jobs: 2, noted: 1 });
    expect(result.again).toMatch(/conversation:%/);
  });

  it('the rollback can run twice (nothing to refuse over)', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(ROLLBACK);
      await tx.$executeRawUnsafe(ROLLBACK);
    });
  });
});

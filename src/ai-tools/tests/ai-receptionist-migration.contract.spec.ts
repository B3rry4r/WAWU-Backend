// AITOOLS-06: the migration `20261223090000_receptionist` applies on a database that already holds AiToolJob rows, its
// rollback REFUSES while an agent, a document or a message row exists (each is something a person gave their Receptionist,
// and the provider may hold a copy) and otherwise drops the three tables without touching any other row, and the
// migration then applies again. Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs
// inside one transaction that is always rolled back (Postgres DDL is transactional).

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
  '../../../prisma/migrations/20261223090000_receptionist',
);
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
const TABLES = [
  'ReceptionistAgent',
  'ReceptionistKnowledge',
  'ReceptionistTurn',
];

describe('AITOOLS-06: the Receptionist migration, its rollback and the migration again', () => {
  let prisma: PrismaService;
  const who = `ait06-mig-${randomUUID()}`;

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
  const tablesOf = async (tx: Tx): Promise<string[]> =>
    (
      await tx.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'Receptionist%' ORDER BY table_name`,
      )
    ).map((r) => r.table_name);
  const agent = (user = who) =>
    `INSERT INTO "ReceptionistAgent" ("id","wawuUserId","providerAgentId","businessName","offer","updatedAt")
     VALUES ('${randomUUID()}','${user}','a1','Ada Braids','Braids', now())`;
  const doc = () =>
    `INSERT INTO "ReceptionistKnowledge" ("id","wawuUserId","providerDocId","kind","name")
     VALUES ('${randomUUID()}','${who}','d1','text','Prices')`;
  const turn = () =>
    `INSERT INTO "ReceptionistTurn" ("id","wawuUserId","role","text")
     VALUES ('${randomUUID()}','${who}','person','Hello')`;
  const jobRow = () =>
    `INSERT INTO "AiToolJob" ("id","wawuUserId","tool","idempotencyKey","requestHash","voiceId","characters","units","costPoints","state")
     VALUES ('${randomUUID()}','${who}','receptionist_message','k-${randomUUID()}','${'a'.repeat(64)}','',0,1,20,'working')`;

  it('is applied: the three tables, their checks and the one-agent-a-person index are there', async () => {
    const result = await inRolledBackTx(async (tx) => {
      const tables = await tablesOf(tx);
      await tx.$executeRawUnsafe(agent());
      let second = '';
      try {
        await tx.$executeRawUnsafe('SAVEPOINT s1');
        await tx.$executeRawUnsafe(agent());
      } catch (e) {
        second = (e as Error).message;
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s1');
      let kind = '';
      try {
        await tx.$executeRawUnsafe(doc().replace("'text'", "'sip'"));
      } catch (e) {
        kind = (e as Error).message;
      }
      return { tables, second, kind };
    });
    expect(result.tables).toEqual(TABLES);
    expect(result.second).toMatch(/ReceptionistAgent_wawuUserId_key|unique/);
    expect(result.kind).toMatch(
      /ReceptionistKnowledge_kind_check|violates check/,
    );
  });

  it('the rollback REFUSES while an agent, a document or a message exists, and keeps it', async () => {
    for (const make of [agent, doc, turn])
      await expect(
        inRolledBackTx(async (tx) => {
          await tx.$executeRawUnsafe(make());
          await tx.$executeRawUnsafe(ROLLBACK);
        }),
      ).rejects.toThrow(/rollback refused: a receptionist row exists/);
  });

  it('rolls back without touching any other row, and the migration applies again (up, down, up)', async () => {
    const result = await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(jobRow());
      const count = async () =>
        Number(
          (
            await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM "AiToolJob" WHERE "wawuUserId" = '${who}'`,
            )
          )[0].n,
        );
      const jobsBefore = await count();
      await tx.$executeRawUnsafe(ROLLBACK);
      const gone = await tablesOf(tx);
      const jobsAfter = await count();
      await tx.$executeRawUnsafe(MIGRATE);
      const again = await tablesOf(tx);
      await tx.$executeRawUnsafe(agent());
      return { jobsBefore, jobsAfter, gone, again };
    });
    expect(result.gone).toEqual([]);
    expect(result.jobsBefore).toBe(1);
    expect(result.jobsAfter).toBe(1);
    expect(result.again).toEqual(TABLES);
  });
});

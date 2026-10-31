// MOD-ROOMS (R-122): the migration `20261230090000_community_moderation` is applied (two tables, their checks and the unique
// pair), its rollback REFUSES while either table holds a row, drops only those two tables otherwise, and the migration
// applies again (up, down, up). Real database, no HTTP. Every check runs in one transaction that is always rolled back.

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
  '../../../prisma/migrations/20261230090000_community_moderation',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql, so it leaves out such lines.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const ROLLBACK = script('rollback.sql');
const MIGRATE = script('migration.sql');

describe('MOD-ROOMS: the community moderation migration, its rollback and the migration again', () => {
  let prisma: PrismaService;
  const person = `mrm-${randomUUID()}`;

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
  const columnsOf = async (tx: Tx, table: string): Promise<string[]> =>
    (
      await tx.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY column_name`,
      )
    ).map((r) => r.column_name);
  const room = async (tx: Tx): Promise<string> => {
    const id = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO "Community" ("id","name","description","hostWawuId","kind") VALUES ('${id}','mrm','x','${person}','open')`,
    );
    return id;
  };
  const mute = (communityId: string, who = person) =>
    `INSERT INTO "CommunityMute" ("id","communityId","userWawuId","mutedByWawuId") VALUES ('${randomUUID()}','${communityId}','${who}','${person}-host')`;
  const log = (communityId: string, action = 'member_muted', kind?: string) =>
    `INSERT INTO "CommunityModerationLog" ("id","communityId","actorWawuId","action","messageKind") VALUES ('${randomUUID()}','${communityId}','${person}-host','${action}',${kind ? `'${kind}'` : 'NULL'})`;
  const fails = async (tx: Tx, sql: string): Promise<boolean> => {
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

  const MUTE_COLUMNS = [
    'communityId',
    'id',
    'mutedAt',
    'mutedByWawuId',
    'userWawuId',
  ];
  const LOG_COLUMNS = [
    'action',
    'actorWawuId',
    'communityId',
    'createdAt',
    'id',
    'messageId',
    'messageKind',
    'targetWawuId',
  ];

  it('is applied: the columns, one mute per member and room, the action and kind checks, the room cascade', async () => {
    const result = await inRolledBackTx(async (tx) => {
      const c = await room(tx);
      const out = {
        muteColumns: await columnsOf(tx, 'CommunityMute'),
        logColumns: await columnsOf(tx, 'CommunityModerationLog'),
        goodMute: !(await fails(tx, mute(c))),
        secondMuteOfTheSameMember: await fails(tx, mute(c)),
        sameMemberInAnotherRoom: !(await fails(tx, mute(await room(tx)))),
        muteInNoRoom: await fails(tx, mute(randomUUID(), 'someone-else')),
        goodLog: !(await fails(tx, log(c, 'message_deleted', 'photo'))),
        badAction: await fails(tx, log(c, 'banned')),
        badKind: await fails(tx, log(c, 'message_deleted', 'gif')),
        logSurvivesRoomDelete: false,
        muteGoneWithRoom: false,
      };
      await tx.$executeRawUnsafe(`DELETE FROM "Community" WHERE "id" = '${c}'`);
      const left = async (t: string) =>
        Number(
          (
            await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM "${t}" WHERE "communityId" = '${c}'`,
            )
          )[0].n,
        );
      out.logSurvivesRoomDelete = (await left('CommunityModerationLog')) > 0;
      out.muteGoneWithRoom = (await left('CommunityMute')) === 0;
      return out;
    });
    expect(result.muteColumns).toEqual(MUTE_COLUMNS);
    expect(result.logColumns).toEqual(LOG_COLUMNS);
    expect(result).toEqual(
      expect.objectContaining({
        goodMute: true,
        secondMuteOfTheSameMember: true,
        sameMemberInAnotherRoom: true,
        muteInNoRoom: true,
        goodLog: true,
        badAction: true,
        badKind: true,
        logSurvivesRoomDelete: true,
        muteGoneWithRoom: true,
      }),
    );
  });

  it('the rollback REFUSES while a mute is in force, and while the log holds a row, and keeps both', async () => {
    await expect(
      inRolledBackTx(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "CommunityMute"`);
        await tx.$executeRawUnsafe(`DELETE FROM "CommunityModerationLog"`);
        await tx.$executeRawUnsafe(mute(await room(tx)));
        await tx.$executeRawUnsafe(ROLLBACK);
      }),
    ).rejects.toThrow(/rollback refused: a CommunityMute is still in force/);
    await expect(
      inRolledBackTx(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "CommunityMute"`);
        await tx.$executeRawUnsafe(`DELETE FROM "CommunityModerationLog"`);
        await tx.$executeRawUnsafe(log(await room(tx)));
        await tx.$executeRawUnsafe(ROLLBACK);
      }),
    ).rejects.toThrow(
      /rollback refused: the CommunityModerationLog still holds rows/,
    );
  });

  it('rolls back when both are empty, touches no other table, and the migration applies again (up, down, up)', async () => {
    const result = await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM "CommunityMute"`);
      await tx.$executeRawUnsafe(`DELETE FROM "CommunityModerationLog"`);
      const count = async () =>
        Number(
          (
            await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM "CommunityMessage"`,
            )
          )[0].n,
        );
      const before = await count();
      await tx.$executeRawUnsafe(ROLLBACK);
      const gone = [
        ...(await columnsOf(tx, 'CommunityMute')),
        ...(await columnsOf(tx, 'CommunityModerationLog')),
      ];
      const after = await count();
      await tx.$executeRawUnsafe(MIGRATE);
      const again = {
        mute: await columnsOf(tx, 'CommunityMute'),
        log: await columnsOf(tx, 'CommunityModerationLog'),
      };
      await tx.$executeRawUnsafe(mute(await room(tx)));
      await tx.$executeRawUnsafe(ROLLBACK).catch(() => undefined);
      return { gone, before, after, again };
    });
    expect(result.gone).toEqual([]);
    expect(result.after).toBe(result.before);
    expect(result.again).toEqual({ mute: MUTE_COLUMNS, log: LOG_COLUMNS });
  });
});

// POINTS-BOUGHT (R-101 point 7): the migration `20261211090000_points_bought_never_expire`
// clears the end of the bought lots that exist, keeps the old dates in
// "PointLotExpiryChange", touches nothing else, and its rollback puts the old dates back
// or refuses (and says why) when that would end a lot that was spent past its old date.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Every check runs
// inside one transaction that is always rolled back, so the tables are left as found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { POINTS_NEVER_EXPIRES } from '../points-bought';
import { PointsService } from '../points.service';

jest.setTimeout(60_000);

const FOLDER = join(
  __dirname,
  '../../../prisma/migrations/20261211090000_points_bought_never_expire',
);
// The rollback's first line is psql's `\set ON_ERROR_STOP on`; this runner is not psql.
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
const NEVER = POINTS_NEVER_EXPIRES.getTime();
const DAY = 86_400_000;

describe('POINTS-BOUGHT: the migration and its rollback', () => {
  let prisma: PrismaService;
  let points: PointsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    points = new PointsService(prisma);
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

  /** A lot as an older Hub wrote it: granted, then given the end it had. */
  async function legacy(
    tx: Tx,
    who: string,
    source: 'pack' | 'bump' | 'shortfall' | 'tier_bonus' | 'referral',
    ends: Date,
    n = 100,
  ): Promise<string> {
    const ref = `pbm-${randomUUID()}`;
    // The service gives a bought lot the "never" end; an earned lot keeps what it is given.
    const out = await points.grant(
      {
        wawuUserId: who,
        source,
        sourceRef: ref,
        points: n,
        expiresAt: new Date(Date.now() + 400 * DAY),
      },
      { tx },
    );
    await setEnd(tx, out.lotId, ends);
    return out.lotId;
  }
  /**
   * ALTER TABLE refuses while the table has trigger events waiting for the end of the
   * transaction (the lots written by this test); run them now, then defer again.
   */
  async function settle(tx: Tx) {
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
  }
  /** Sets a lot's end the way an older Hub wrote it (the trigger holding the end fixed is off for this one update). */
  async function setEnd(tx: Tx, id: string, ends: Date | 'five days ago') {
    await settle(tx);
    await tx.$executeRawUnsafe(
      'ALTER TABLE "PointLot" DISABLE TRIGGER "PointLot_fixed_fields"',
    );
    if (ends instanceof Date)
      await tx.$executeRawUnsafe(
        `UPDATE "PointLot" SET "expiresAt" = $2 WHERE "id" = $1`,
        id,
        ends,
      );
    else
      await tx.$executeRawUnsafe(
        `UPDATE "PointLot" SET "expiresAt" = now() - interval '5 days' WHERE "id" = $1`,
        id,
      );
    await settle(tx);
    await tx.$executeRawUnsafe(
      'ALTER TABLE "PointLot" ENABLE TRIGGER "PointLot_fixed_fields"',
    );
  }
  const lotOf = (tx: Tx, id: string) =>
    tx.pointLot.findUniqueOrThrow({ where: { id } });
  const audits = (tx: Tx) =>
    tx.$queryRawUnsafe<{ lotId: string; previousExpiresAt: Date }[]>(
      `SELECT "lotId", "previousExpiresAt" FROM "PointLotExpiryChange"`,
    );
  async function failsWith(tx: Tx, sql: string): Promise<string> {
    await settle(tx);
    await tx.$executeRawUnsafe('SAVEPOINT attempt');
    try {
      await tx.$executeRawUnsafe(sql);
    } catch (e) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT attempt');
      return (e as Error).message;
    }
    throw new Error('expected the script to refuse');
  }

  it('clears the end of live bought lots, keeps the old dates, leaves earned, bonus and written-off lots alone, and runs again with no change', async () => {
    const r = await inRolledBackTx(async (tx) => {
      const who = `pbm-${randomUUID()}`;
      const soon = new Date(Date.now() + 30 * DAY);
      const later = new Date(Date.now() + 200 * DAY);
      const past = new Date(Date.now() - 5 * DAY);
      const pack = await legacy(tx, who, 'pack', soon);
      const bump = await legacy(tx, who, 'bump', later);
      const shortfall = await legacy(tx, who, 'shortfall', later);
      // Ended but the job had not written it off yet: its points are kept.
      const ended = await legacy(tx, who, 'pack', past);
      // Written off (or taken back by a store refund): left as it is.
      const lapsed = await legacy(tx, who, 'pack', past);
      await tx.$executeRawUnsafe(
        `UPDATE "PointLot" SET "lapsedAt" = now() WHERE "id" = $1`,
        lapsed,
      );
      const bonus = await legacy(tx, who, 'tier_bonus', soon);
      const referral = await legacy(tx, who, 'referral', later);
      await settle(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const ends: Record<string, number> = {};
      for (const [k, id] of Object.entries({
        pack,
        bump,
        shortfall,
        ended,
        lapsed,
        bonus,
        referral,
      }))
        ends[k] = (await lotOf(tx, id)).expiresAt.getTime();
      const first = {
        ends,
        audit: await audits(tx),
      };
      await settle(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const second = await audits(tx);
      return {
        first,
        second,
        ids: { pack, bump, shortfall, ended, lapsed },
        soon,
        later,
        past,
        bonus: bonus,
        referral,
      };
    });
    expect(r.first.ends).toMatchObject({
      pack: NEVER,
      bump: NEVER,
      shortfall: NEVER,
      ended: NEVER,
    });
    // A written-off lot and the earned and bonus lots keep the end they had.
    expect(r.first.ends.lapsed).toBe(r.past.getTime());
    expect(r.first.ends.bonus).toBe(r.soon.getTime());
    expect(r.first.ends.referral).toBe(r.later.getTime());
    const old = Object.fromEntries(
      r.first.audit.map((a) => [a.lotId, a.previousExpiresAt.getTime()]),
    );
    expect(old[r.ids.pack]).toBe(r.soon.getTime());
    expect(old[r.ids.bump]).toBe(r.later.getTime());
    expect(old[r.ids.shortfall]).toBe(r.later.getTime());
    expect(old[r.ids.ended]).toBe(r.past.getTime());
    expect(old[r.ids.lapsed]).toBeUndefined();
    expect(
      r.first.audit.filter((a) => old[a.lotId] !== undefined).length,
    ).toBeGreaterThanOrEqual(4);
    expect(r.second).toEqual(r.first.audit);
  });

  it('the rollback puts the old ends back, drops the audit table, and leaves a lot granted after the migration at the never end', async () => {
    const r = await inRolledBackTx(async (tx) => {
      const who = `pbm-${randomUUID()}`;
      const soon = new Date(Date.now() + 30 * DAY);
      const old = await legacy(tx, who, 'pack', soon);
      await settle(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      // Granted by the new build, after the migration: no old end to put back.
      const fresh = await points.grant(
        {
          wawuUserId: who,
          source: 'pack',
          sourceRef: `pbm-${randomUUID()}`,
          points: 5,
          expiresAt: soon,
        },
        { tx },
      );
      await settle(tx);
      await tx.$executeRawUnsafe(ROLLBACK);
      const table = await tx.$queryRawUnsafe<{ t: string | null }[]>(
        `SELECT to_regclass('"PointLotExpiryChange"')::text AS t`,
      );
      return {
        restored: (await lotOf(tx, old)).expiresAt.getTime(),
        fresh: (await lotOf(tx, fresh.lotId)).expiresAt.getTime(),
        table: table[0].t,
        soon,
      };
    });
    expect(r.restored).toBe(r.soon.getTime());
    expect(r.fresh).toBe(NEVER);
    expect(r.table).toBeNull();
  });

  it('the rollback refuses, saying so, when a lot was spent after its old end date, and changes nothing', async () => {
    await inRolledBackTx(async (tx) => {
      const who = `pbm-${randomUUID()}`;
      const lot = await legacy(
        tx,
        who,
        'pack',
        new Date(Date.now() + 30 * DAY),
      );
      // The spend happens now; the lot's old end (5 days ago) is before it.
      await points.hold(
        {
          wawuUserId: who,
          purpose: 'ai_job',
          reference: `pbm-${randomUUID()}`,
          points: 40,
        },
        { tx },
      );
      await setEnd(tx, lot, 'five days ago');
      await settle(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const message = await failsWith(tx, ROLLBACK);
      expect(message).toMatch(/spent after their old end date/);
      expect(message).toMatch(/Nothing was changed/);
      expect((await lotOf(tx, lot)).expiresAt.getTime()).toBe(NEVER);
      expect(await audits(tx)).toHaveLength((await audits(tx)).length);
      expect((await audits(tx)).some((a) => a.lotId === lot)).toBe(true);
    });
  });

  it('the rollback also refuses when a lot still holds points and its old end has passed, because they would be written off', async () => {
    await inRolledBackTx(async (tx) => {
      const who = `pbm-${randomUUID()}`;
      const lot = await legacy(tx, who, 'pack', new Date(Date.now() - 3 * DAY));
      await settle(tx);
      await tx.$executeRawUnsafe(MIGRATE);
      const message = await failsWith(tx, ROLLBACK);
      expect(message).toMatch(/still hold points/);
      expect((await lotOf(tx, lot)).expiresAt.getTime()).toBe(NEVER);
    });
  });
});

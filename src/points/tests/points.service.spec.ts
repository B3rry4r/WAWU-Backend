// Task POINTS-01: points in lots that expire, holds, and the append-only
// ledger. Runs against the caller's DATABASE_URL with the real migration
// (its CHECKs and triggers), like every other database spec here. Each run
// uses its own people (random ids) and removes every row it wrote: a whole
// person's ledger at once, the one delete the ledger allows.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { PointsService } from '../points.service';
import { PointsError } from '../points-error';
import { PointsExpiryService } from '../points-expiry.service';
import { POINTS_VIEW } from '../points-config';

// "Now" for every call that takes one, so the lots' January and March ends
// stay in the future whatever day the suite runs.
const NOW = new Date('2026-10-08T09:00:00.000Z');
const JANUARY = new Date('2027-01-31T22:00:00.000Z');
const MARCH = new Date('2027-03-31T22:00:00.000Z');
const at = { now: NOW };
const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

describe('POINTS-01: lots, holds and the ledger', () => {
  let prisma: PrismaService;
  let points: PointsService;
  const people: string[] = [];

  const person = (): string => {
    const id = `p01-${randomUUID()}`;
    people.push(id);
    return id;
  };
  const ref = (what: string) => `p01-${what}-${randomUUID()}`;

  const lotsOf = (wawuUserId: string) =>
    prisma.pointLot.findMany({
      where: { wawuUserId },
      orderBy: { expiresAt: 'asc' },
    });
  const ledgerOf = (wawuUserId: string) =>
    prisma.pointLedger.findMany({
      where: { wawuUserId },
      orderBy: { seq: 'asc' },
    });

  /** Every lot holds exactly the sum of its ledger rows. */
  async function expectLotsMatchLedger(wawuUserId: string): Promise<void> {
    const lots = await lotsOf(wawuUserId);
    const rows = await ledgerOf(wawuUserId);
    for (const lot of lots) {
      const sum = rows
        .filter((r) => r.lotId === lot.id)
        .reduce((s, r) => s + r.delta, 0);
      expect({ lot: lot.id, remaining: lot.remaining }).toEqual({
        lot: lot.id,
        remaining: sum,
      });
      expect(lot.remaining).toBeGreaterThanOrEqual(0);
    }
  }

  async function refusal(p: Promise<unknown>): Promise<PointsError> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(PointsError);
      return e as PointsError;
    }
    throw new Error('expected a refusal');
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    points = new PointsService(prisma);
  }, 60000);

  afterAll(async () => {
    // One statement per table for every person this run made: a whole
    // person's ledger, which is the only delete the ledger allows.
    await prisma.pointLedger.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.pointHold.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    await prisma.pointLot.deleteMany({ where: { wawuUserId: { in: people } } });
    await prisma.$disconnect();
  }, 60000);

  // ---------------------------------------------------------------------------
  describe('spending takes the soonest-expiring lot first', () => {
    it('a person with a January lot and a March lot spends January first', async () => {
      const me = person();
      // March is granted first, so the order is by end date, not by grant.
      const march = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('march'),
          points: 100,
          expiresAt: MARCH,
        },
        at,
      );
      const january = await points.grant(
        {
          wawuUserId: me,
          source: 'tier_bonus',
          sourceRef: ref('jan'),
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );

      const held = await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: ref('job'),
          points: 150,
          title: 'VoiceOver',
        },
        at,
      );
      expect(held.parts).toEqual([
        { lotId: january.lotId, points: 100 },
        { lotId: march.lotId, points: 50 },
      ]);
      const lots = await lotsOf(me);
      expect(lots.map((l) => [l.id, l.remaining])).toEqual([
        [january.lotId, 0],
        [march.lotId, 50],
      ]);
      const rows = await ledgerOf(me);
      expect(rows.map((r) => [r.reason, r.lotId, r.delta])).toEqual([
        ['grant', march.lotId, 100],
        ['grant', january.lotId, 100],
        ['hold', january.lotId, -100],
        ['hold', march.lotId, -50],
      ]);
      expect((await points.view(me, NOW)).balance).toBe(50);
      await expectLotsMatchLedger(me);
    });

    it('a hold larger than the balance is refused and nothing changes', async () => {
      const me = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('a'),
          points: 30,
          expiresAt: JANUARY,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: me,
          source: 'referral',
          sourceRef: ref('b'),
          points: 20,
          expiresAt: MARCH,
        },
        at,
      );
      const lotsBefore = await lotsOf(me);
      const rowsBefore = await ledgerOf(me);

      const reference = ref('too-big');
      const err = await refusal(
        points.hold(
          { wawuUserId: me, purpose: 'ai_job', reference, points: 51 },
          at,
        ),
      );
      expect(err.code).toBe('insufficient_points');
      expect(err.getStatus()).toBe(402);
      expect(err.getResponse()).toEqual({
        message: "You don't have enough points for this.",
        reason: {
          code: 'insufficient_points',
          message: "You don't have enough points for this.",
          balancePoints: 50,
          neededPoints: 51,
          shortfallPoints: 1,
        },
      });

      expect(await lotsOf(me)).toEqual(lotsBefore);
      expect(await ledgerOf(me)).toEqual(rowsBefore);
      expect(
        await prisma.pointHold.count({
          where: { purpose: 'ai_job', reference },
        }),
      ).toBe(0);
      // The same reference is still free once the person has the points.
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('c'),
          points: 1,
          expiresAt: MARCH,
        },
        at,
      );
      const ok = await points.hold(
        { wawuUserId: me, purpose: 'ai_job', reference, points: 51 },
        at,
      );
      expect(ok.replayed).toBe(false);
      await expectLotsMatchLedger(me);
    });

    it('another person’s points are never taken', async () => {
      const me = person();
      const other = person();
      await points.grant(
        {
          wawuUserId: other,
          source: 'pack',
          sourceRef: ref('other'),
          points: 500,
          expiresAt: JANUARY,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('mine'),
          points: 10,
          expiresAt: JANUARY,
        },
        at,
      );
      const err = await refusal(
        points.hold(
          {
            wawuUserId: me,
            purpose: 'ai_job',
            reference: ref('j'),
            points: 11,
          },
          at,
        ),
      );
      expect(err.detail).toEqual({
        balancePoints: 10,
        neededPoints: 11,
        shortfallPoints: 1,
      });
      expect((await lotsOf(other))[0].remaining).toBe(500);
    });

    it('an ended lot is never spent, even before the expiry job reaches it', async () => {
      const me = person();
      const soon = minutes(NOW, 60);
      await points.grant(
        {
          wawuUserId: me,
          source: 'bump',
          sourceRef: ref('soon'),
          points: 40,
          expiresAt: soon,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('later'),
          points: 10,
          expiresAt: MARCH,
        },
        at,
      );
      const later = { now: minutes(soon, 1) };
      expect((await points.view(me, later.now)).balance).toBe(10);
      const err = await refusal(
        points.hold(
          {
            wawuUserId: me,
            purpose: 'ai_job',
            reference: ref('j'),
            points: 11,
          },
          later,
        ),
      );
      expect(err.detail.balancePoints).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the same grant twice grants once', () => {
    it('a repeated reference returns the first lot and writes nothing', async () => {
      const me = person();
      const sourceRef = ref('purchase');
      const first = await points.grant(
        {
          wawuUserId: me,
          source: 'tier_bonus',
          sourceRef,
          points: 600,
          expiresAt: MARCH,
        },
        at,
      );
      // A replayed webhook computes a later end; the first grant's end stands.
      const again = await points.grant(
        {
          wawuUserId: me,
          source: 'tier_bonus',
          sourceRef,
          points: 600,
          expiresAt: minutes(MARCH, 5),
        },
        at,
      );
      expect(first.granted).toBe(true);
      expect(again).toEqual({
        lotId: first.lotId,
        granted: false,
        points: 600,
        expiresAt: MARCH,
      });
      expect(await prisma.pointLot.count({ where: { wawuUserId: me } })).toBe(
        1,
      );
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: me } }),
      ).toBe(1);
      expect((await points.view(me, NOW)).balance).toBe(600);
    });

    it('ten grants of one reference at once make one lot and one ledger row', async () => {
      const me = person();
      const sourceRef = ref('race');
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          points.grant(
            {
              wawuUserId: me,
              source: 'pack',
              sourceRef,
              points: 1000,
              expiresAt: JANUARY,
            },
            at,
          ),
        ),
      );
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      expect(new Set(results.map((r) => r.lotId)).size).toBe(1);
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: me } }),
      ).toBe(1);
      expect((await points.view(me, NOW)).balance).toBe(1000);
    });

    it('one reference for another person or another amount is refused', async () => {
      const me = person();
      const other = person();
      const sourceRef = ref('shared');
      await points.grant(
        {
          wawuUserId: me,
          source: 'referral',
          sourceRef,
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );
      const otherPerson = await refusal(
        points.grant(
          {
            wawuUserId: other,
            source: 'referral',
            sourceRef,
            points: 100,
            expiresAt: JANUARY,
          },
          at,
        ),
      );
      expect(otherPerson.code).toBe('points_grant_conflict');
      const otherAmount = await refusal(
        points.grant(
          {
            wawuUserId: me,
            source: 'referral',
            sourceRef,
            points: 101,
            expiresAt: JANUARY,
          },
          at,
        ),
      );
      expect(otherAmount.code).toBe('points_grant_conflict');
      expect(
        await prisma.pointLot.count({ where: { wawuUserId: other } }),
      ).toBe(0);
      // The same reference under another source is another grant.
      const pack = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef,
          points: 5,
          expiresAt: JANUARY,
        },
        at,
      );
      expect(pack.granted).toBe(true);
    });

    it('two people racing for one reference: one lot, one refusal', async () => {
      const a = person();
      const b = person();
      const sourceRef = ref('race-two');
      const settled = await Promise.allSettled([
        points.grant(
          {
            wawuUserId: a,
            source: 'pack',
            sourceRef,
            points: 50,
            expiresAt: JANUARY,
          },
          at,
        ),
        points.grant(
          {
            wawuUserId: b,
            source: 'pack',
            sourceRef,
            points: 50,
            expiresAt: JANUARY,
          },
          at,
        ),
      ]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const rejected = settled.find(
        (s) => s.status === 'rejected',
      ) as PromiseRejectedResult;
      expect((rejected.reason as PointsError).code).toBe(
        'points_grant_conflict',
      );
      expect(
        await prisma.pointLot.count({ where: { sourceRef, source: 'pack' } }),
      ).toBe(1);
    });

    it.each([
      ['zero points', { points: 0 }],
      ['a fraction', { points: 1.5 }],
      ['below zero', { points: -5 }],
      ['an end in the past', { expiresAt: minutes(NOW, -1) }],
      ['an end now', { expiresAt: NOW }],
      ['no reference', { sourceRef: '' }],
      ['a reference too long', { sourceRef: 'r'.repeat(201) }],
    ])('refuses %s and writes nothing', async (_what, change) => {
      const me = person();
      const err = await refusal(
        points.grant(
          {
            wawuUserId: me,
            source: 'pack',
            sourceRef: ref('bad'),
            points: 10,
            expiresAt: JANUARY,
            ...change,
          },
          at,
        ),
      );
      expect(err.code).toBe('points_invalid');
      expect(await prisma.pointLot.count({ where: { wawuUserId: me } })).toBe(
        0,
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('two holds at once never take the balance below zero', () => {
    it('eight holds of 30 against 100 points: three are held, five refused', async () => {
      const me = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('a'),
          points: 60,
          expiresAt: JANUARY,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('b'),
          points: 40,
          expiresAt: MARCH,
        },
        at,
      );
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          points.hold(
            {
              wawuUserId: me,
              purpose: 'ai_job',
              reference: ref(`h${i}`),
              points: 30,
            },
            at,
          ),
        ),
      );
      const held = settled.filter((s) => s.status === 'fulfilled');
      const refused = settled.filter((s) => s.status === 'rejected');
      expect(held).toHaveLength(3);
      expect(refused).toHaveLength(5);
      for (const r of refused) {
        expect((r.reason as PointsError).code).toBe('insufficient_points');
        expect((r.reason as PointsError).detail.balancePoints).toBe(10);
      }
      const lots = await lotsOf(me);
      expect(lots.map((l) => l.remaining)).toEqual([0, 10]);
      expect((await points.view(me, NOW)).balance).toBe(10);
      expect(await prisma.pointHold.count({ where: { wawuUserId: me } })).toBe(
        3,
      );
      await expectLotsMatchLedger(me);
    });

    it('two holds of 60 against 100 at once: exactly one is held', async () => {
      const me = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('a'),
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );
      const settled = await Promise.allSettled([
        points.hold(
          {
            wawuUserId: me,
            purpose: 'ai_job',
            reference: ref('x'),
            points: 60,
          },
          at,
        ),
        points.hold(
          {
            wawuUserId: me,
            purpose: 'cash_out',
            reference: ref('y'),
            points: 60,
          },
          at,
        ),
      ]);
      expect(settled.map((s) => s.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect((await lotsOf(me))[0].remaining).toBe(40);
      await expectLotsMatchLedger(me);
    });

    it('the same hold asked for twice at once holds once', async () => {
      const me = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('a'),
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );
      const reference = ref('same-job');
      const [one, two] = await Promise.all([
        points.hold(
          { wawuUserId: me, purpose: 'ai_job', reference, points: 70 },
          at,
        ),
        points.hold(
          { wawuUserId: me, purpose: 'ai_job', reference, points: 70 },
          at,
        ),
      ]);
      expect(one.holdId).toBe(two.holdId);
      expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
      expect((await lotsOf(me))[0].remaining).toBe(30);
      // Another person or amount on the same reference is refused.
      const err = await refusal(
        points.hold(
          { wawuUserId: me, purpose: 'ai_job', reference, points: 10 },
          at,
        ),
      );
      expect(err.code).toBe('points_hold_conflict');
    });
  });

  // ---------------------------------------------------------------------------
  describe('commit and release', () => {
    it('a released hold returns its points to the same lots', async () => {
      const me = person();
      const jan = await points.grant(
        {
          wawuUserId: me,
          source: 'tier_bonus',
          sourceRef: ref('jan'),
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );
      const mar = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('mar'),
          points: 300,
          expiresAt: MARCH,
        },
        at,
      );
      // Spend some of January first, so the release has to find its exact lots.
      await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: ref('earlier'),
          points: 30,
        },
        at,
      );

      const reference = ref('voiceover');
      const held = await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference,
          points: 250,
          title: 'VoiceOver',
        },
        at,
      );
      expect(held.parts).toEqual([
        { lotId: jan.lotId, points: 70 },
        { lotId: mar.lotId, points: 180 },
      ]);
      const released = await points.release(
        { purpose: 'ai_job', reference },
        at,
      );
      expect(released.state).toBe('released');
      expect(released.replayed).toBe(false);

      const lots = await lotsOf(me);
      expect(lots.map((l) => [l.id, l.remaining])).toEqual([
        [jan.lotId, 70],
        [mar.lotId, 300],
      ]);
      const rows = (await ledgerOf(me)).filter((r) => r.holdId === held.holdId);
      expect(rows.map((r) => [r.reason, r.lotId, r.delta])).toEqual([
        ['hold', jan.lotId, -70],
        ['hold', mar.lotId, -180],
        ['release', jan.lotId, 70],
        ['release', mar.lotId, 180],
      ]);

      // Again: nothing more. Committing it now is refused.
      const again = await points.release({ holdId: held.holdId }, at);
      expect(again.replayed).toBe(true);
      expect(
        (await ledgerOf(me)).filter((r) => r.holdId === held.holdId),
      ).toHaveLength(4);
      const late = await refusal(points.commit({ holdId: held.holdId }, at));
      expect(late.code).toBe('points_hold_settled');
      expect(late.message).toBe('Those points were already given back.');
      await expectLotsMatchLedger(me);
    });

    it('a committed hold stays spent and cannot be released', async () => {
      const me = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('a'),
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );
      const held = await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: ref('c'),
          points: 40,
          title: 'Captions',
        },
        at,
      );
      const rowsBefore = await ledgerOf(me);
      const done = await points.commit({ holdId: held.holdId }, at);
      expect(done).toMatchObject({
        state: 'committed',
        points: 40,
        replayed: false,
      });
      // Committing writes no ledger row: the hold already moved the points.
      expect(await ledgerOf(me)).toEqual(rowsBefore);
      expect((await points.commit({ holdId: held.holdId }, at)).replayed).toBe(
        true,
      );
      const err = await refusal(points.release({ holdId: held.holdId }, at));
      expect(err.code).toBe('points_hold_settled');
      expect(err.message).toBe('Those points were already spent.');
      expect((await points.view(me, NOW)).balance).toBe(60);
      const hold = await prisma.pointHold.findUniqueOrThrow({
        where: { id: held.holdId },
      });
      expect(hold.settledAt).toEqual(NOW);
    });

    it('an unknown hold is not found', async () => {
      const err = await refusal(points.commit({ holdId: randomUUID() }, at));
      expect(err.code).toBe('points_hold_not_found');
      expect(err.getStatus()).toBe(404);
    });

    it('points given back to a lot that ended meanwhile end with it', async () => {
      const me = person();
      const soon = minutes(NOW, 30);
      const lot = await points.grant(
        {
          wawuUserId: me,
          source: 'bump',
          sourceRef: ref('soon'),
          points: 100,
          expiresAt: soon,
        },
        at,
      );
      const held = await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: ref('long-job'),
          points: 80,
        },
        at,
      );
      const after = minutes(soon, 5);
      // The expiry job takes the 20 the lot still had.
      expect((await points.expireLapsed(after)).points).toBeGreaterThanOrEqual(
        20,
      );
      await points.release({ holdId: held.holdId }, { now: after });

      const rows = await ledgerOf(me);
      expect(rows.map((r) => [r.reason, r.delta])).toEqual([
        ['grant', 100],
        ['hold', -80],
        ['expire', -20],
        ['release', 80],
        ['expire', -80],
      ]);
      const stored = await prisma.pointLot.findUniqueOrThrow({
        where: { id: lot.lotId },
      });
      expect(stored.remaining).toBe(0);
      expect((await points.view(me, after)).balance).toBe(0);
      await expectLotsMatchLedger(me);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the expiry job', () => {
    it('each lapsed lot leaves the balance with one ledger row', async () => {
      const me = person();
      const t1 = minutes(NOW, 10);
      const t2 = minutes(NOW, 20);
      const a = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('a'),
          points: 100,
          expiresAt: t1,
        },
        at,
      );
      const b = await points.grant(
        {
          wawuUserId: me,
          source: 'referral',
          sourceRef: ref('b'),
          points: 50,
          expiresAt: t2,
        },
        at,
      );
      const c = await points.grant(
        {
          wawuUserId: me,
          source: 'tier_bonus',
          sourceRef: ref('c'),
          points: 30,
          expiresAt: MARCH,
        },
        at,
      );
      // Spend part of the first lot, and all of a fourth that ends with them.
      await points.hold(
        { wawuUserId: me, purpose: 'ai_job', reference: ref('j'), points: 25 },
        at,
      );
      const empty = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('empty'),
          points: 5,
          expiresAt: t1,
        },
        at,
      );
      // 80 more: the 75 left in `a`, then all of `empty` (same end, granted later).
      await points.hold(
        { wawuUserId: me, purpose: 'ai_job', reference: ref('k'), points: 80 },
        at,
      );
      const before = await lotsOf(me);
      const remaining = Object.fromEntries(
        before.map((l) => [l.id, l.remaining]),
      );
      expect(remaining[a.lotId] + remaining[empty.lotId]).toBe(0);
      expect(remaining[b.lotId]).toBe(50);
      expect(remaining[c.lotId]).toBe(30);

      // Two passes at once after both ends: one row per lot that still had points.
      const after = minutes(t2, 1);
      const [x, y] = await Promise.all([
        points.expireLapsed(after),
        points.expireLapsed(after),
      ]);
      const mine = (await ledgerOf(me)).filter((r) => r.reason === 'expire');
      expect(mine.map((r) => [r.lotId, r.delta])).toEqual([[b.lotId, -50]]);
      expect(x.points + y.points).toBeGreaterThanOrEqual(50);
      const view = await points.view(me, after);
      expect(view.balance).toBe(30);
      expect(view.movements[0]).toMatchObject({
        reason: 'expire',
        points: -50,
        label: 'Expired',
      });

      // A later pass finds nothing more of theirs.
      await points.expireLapsed(minutes(after, 1));
      expect(
        (await ledgerOf(me)).filter((r) => r.reason === 'expire'),
      ).toHaveLength(1);
      const lapsed = await prisma.pointLot.findUniqueOrThrow({
        where: { id: b.lotId },
      });
      expect(lapsed.remaining).toBe(0);
      expect(lapsed.lapsedAt).toEqual(after);
      await expectLotsMatchLedger(me);
    });

    it('a lot the database refuses is reported and the rest of the pass goes on', async () => {
      const me = person();
      const end = minutes(NOW, 2);
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('x1'),
          points: 3,
          expiresAt: end,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('x2'),
          points: 4,
          expiresAt: end,
        },
        at,
      );
      // The first write-off of the pass is refused, as the database refuses a
      // lot whose points no longer match its ledger.
      let calls = 0;
      const refusesFirst = new Proxy(prisma, {
        get(target, key, receiver) {
          if (key === '$transaction') {
            return (fn: Parameters<PrismaService['$transaction']>[0]) =>
              calls++ === 0
                ? Promise.reject(new Error('refused'))
                : target.$transaction(fn as never);
          }
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== 'function') return value;
          return (value as (...args: unknown[]) => unknown).bind(
            target,
          ) as unknown;
        },
      });
      const after = minutes(end, 1);
      const outcome = await new PointsService(refusesFirst).expireLapsed(after);
      expect(outcome.failed).toBe(1);
      expect(
        (await ledgerOf(me)).filter((r) => r.reason === 'expire'),
      ).toHaveLength(1);
      // The refused lot is untouched and the next pass writes it off.
      await points.expireLapsed(after);
      const expired = (await ledgerOf(me)).filter((r) => r.reason === 'expire');
      expect(expired.map((r) => r.delta).sort()).toEqual([-3, -4]);
      await expectLotsMatchLedger(me);
    });

    it('the scheduled job runs a pass and never throws', async () => {
      const me = person();
      const soon = minutes(NOW, 1);
      await points.grant(
        {
          wawuUserId: me,
          source: 'returned',
          sourceRef: ref('r'),
          points: 7,
          expiresAt: soon,
        },
        at,
      );
      await new PointsExpiryService(points).run(minutes(soon, 1));
      expect((await ledgerOf(me)).map((r) => [r.reason, r.delta])).toEqual([
        ['grant', 7],
        ['expire', -7],
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the ledger is append-only', () => {
    let me: string;
    let rowId: string;
    let lotId: string;

    beforeAll(async () => {
      me = person();
      const lot = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('ao'),
          points: 10,
          expiresAt: JANUARY,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('ao2'),
          points: 5,
          expiresAt: MARCH,
        },
        at,
      );
      lotId = lot.lotId;
      rowId = (await ledgerOf(me))[0].id;
    });

    it('an UPDATE of a ledger row is refused by the database', async () => {
      await expect(
        prisma.pointLedger.update({
          where: { id: rowId },
          data: { delta: 1000 },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(
          'UPDATE "PointLedger" SET "reference" = $1 WHERE "id" = $2',
          'x',
          rowId,
        ),
      ).rejects.toThrow(/append-only/);
      expect(
        (await prisma.pointLedger.findUniqueOrThrow({ where: { id: rowId } }))
          .delta,
      ).toBe(10);
    });

    it('a DELETE of some of a person’s rows is refused by the database', async () => {
      await expect(
        prisma.pointLedger.delete({ where: { id: rowId } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(
          'DELETE FROM "PointLedger" WHERE "id" = $1',
          rowId,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe('TRUNCATE "PointLedger"'),
      ).rejects.toThrow(/append-only/);
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: me } }),
      ).toBe(2);
    });

    it('a lot cannot change without its ledger row, nor change what it is', async () => {
      await expect(
        prisma.pointLot.update({
          where: { id: lotId },
          data: { remaining: 3 },
        }),
      ).rejects.toThrow(/ledger sums to 10/);
      await expect(
        prisma.pointLot.update({
          where: { id: lotId },
          data: { expiresAt: MARCH },
        }),
      ).rejects.toThrow(/only its remaining points/);
      await expect(
        prisma.pointLot.update({
          where: { id: lotId },
          data: { remaining: 11 },
        }),
      ).rejects.toThrow();
      expect(
        (await prisma.pointLot.findUniqueOrThrow({ where: { id: lotId } }))
          .remaining,
      ).toBe(10);
    });

    it('no code outside a spec updates or deletes ledger rows', () => {
      const src = join(__dirname, '..', '..');
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) {
            if (name !== 'tests') walk(full);
          } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
            const text = readFileSync(full, 'utf8');
            if (
              /pointLedger\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(
                text,
              ) ||
              /\b(UPDATE|DELETE\s+FROM)\s+"?(public"?\."?)?PointLedger\b/i.test(
                text,
              )
            ) {
              offenders.push(full.slice(src.length + 1));
            }
          }
        }
      };
      walk(src);
      expect(offenders).toEqual([]);
    });

    it('a full grant, hold, commit, release and expiry sends no UPDATE or DELETE to the ledger', async () => {
      const logged = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        log: [{ emit: 'event', level: 'query' }],
      });
      const sql: string[] = [];
      logged.$on('query', (e) => sql.push(e.query));
      try {
        const svc = new PointsService(logged as unknown as PrismaService);
        const who = person();
        const soon = minutes(NOW, 15);
        await svc.grant(
          {
            wawuUserId: who,
            source: 'pack',
            sourceRef: ref('l1'),
            points: 50,
            expiresAt: soon,
          },
          at,
        );
        await svc.grant(
          {
            wawuUserId: who,
            source: 'pack',
            sourceRef: ref('l2'),
            points: 50,
            expiresAt: MARCH,
          },
          at,
        );
        const h1 = await svc.hold(
          {
            wawuUserId: who,
            purpose: 'ai_job',
            reference: ref('q1'),
            points: 30,
          },
          at,
        );
        await svc.commit({ holdId: h1.holdId }, at);
        const h2 = await svc.hold(
          {
            wawuUserId: who,
            purpose: 'cash_out',
            reference: ref('q2'),
            points: 40,
          },
          at,
        );
        const later = minutes(soon, 1);
        await svc.expireLapsed(later);
        await svc.release({ holdId: h2.holdId }, { now: later });
        await svc.view(who, later);
      } finally {
        await logged.$disconnect();
      }
      expect(
        sql.some((q) => /INSERT INTO "public"\."PointLedger"/.test(q)),
      ).toBe(true);
      expect(
        sql.filter((q) => /^\s*(UPDATE|DELETE)\b[\s\S]*"PointLedger"/i.test(q)),
      ).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('what GET /me/points reads', () => {
    it('balance, live lots soonest first, the next end and the last 20 movements, newest first', async () => {
      const me = person();
      const other = person();
      await points.grant(
        {
          wawuUserId: other,
          source: 'pack',
          sourceRef: ref('o'),
          points: 999,
          expiresAt: JANUARY,
        },
        at,
      );
      const mar = await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('mar'),
          points: 1000,
          expiresAt: MARCH,
        },
        at,
      );
      const jan = await points.grant(
        {
          wawuUserId: me,
          source: 'tier_bonus',
          sourceRef: ref('jan'),
          points: 100,
          expiresAt: JANUARY,
        },
        at,
      );
      // 24 more movements: 12 holds, 6 committed and 6 released.
      for (let i = 0; i < 12; i += 1) {
        const h = await points.hold(
          {
            wawuUserId: me,
            purpose: 'ai_job',
            reference: ref(`v${i}`),
            points: 10,
            title: 'VoiceOver',
          },
          at,
        );
        if (i % 2 === 0) await points.commit({ holdId: h.holdId }, at);
        else await points.release({ holdId: h.holdId }, at);
      }
      const pending = await points.hold(
        {
          wawuUserId: me,
          purpose: 'cash_out',
          reference: ref('cash'),
          points: 5,
        },
        at,
      );

      const view = await points.view(me, NOW);
      expect(view.balance).toBe(1100 - 60 - 5);
      expect(view.lotCount).toBe(2);
      expect(view.lots).toEqual([
        {
          id: jan.lotId,
          points: 35,
          granted: 100,
          source: 'tier_bonus',
          label: 'Tier bonus',
          expiresAt: JANUARY.toISOString(),
        },
        {
          id: mar.lotId,
          points: 1000,
          granted: 1000,
          source: 'pack',
          label: 'Bought points',
          expiresAt: MARCH.toISOString(),
        },
      ]);
      expect(view.nextExpiry).toEqual({
        points: 35,
        expiresAt: JANUARY.toISOString(),
      });

      expect(view.movements).toHaveLength(POINTS_VIEW.movements);
      const all = await prisma.pointLedger.findMany({
        where: { wawuUserId: me },
        orderBy: { seq: 'desc' },
        take: 20,
      });
      expect(view.movements.map((m) => m.id)).toEqual(all.map((r) => r.id));
      expect(view.movements[0]).toMatchObject({
        reason: 'hold',
        points: -5,
        label: 'Converting to cash',
        pending: true,
      });
      expect(pending.state).toBe('held');
      const labels = new Set(view.movements.map((m) => m.label));
      expect(labels).toEqual(
        new Set([
          'Tier bonus',
          'Converting to cash',
          'Returned from VoiceOver',
          'Held for VoiceOver',
          'Spent on VoiceOver',
        ]),
      );
      for (const m of view.movements) {
        expect(Number.isInteger(m.points)).toBe(true);
        expect(m.label).not.toMatch(/₦|\$|naira|dollar|\u2014/i);
        if (m.reason !== 'hold') expect(m.pending).toBe(false);
      }
      // The other person's lot and movement are nowhere.
      const theirs = [
        ...(await lotsOf(other)).map((l) => l.id),
        ...(await ledgerOf(other)).map((r) => r.id),
      ];
      expect(theirs).toHaveLength(2);
      const shown = [
        ...view.lots.map((l) => l.id),
        ...view.movements.map((m) => m.id),
      ];
      expect(shown.filter((id) => theirs.includes(id))).toEqual([]);
    });

    it('someone with no points sees an empty view', async () => {
      expect(await points.view(person(), NOW)).toEqual({
        balance: 0,
        nextExpiry: null,
        lots: [],
        lotCount: 0,
        movements: [],
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('account deletion and the data export', () => {
    it('the export holds the person’s own lots, holds and movements only', async () => {
      const me = person();
      const other = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('e1'),
          points: 20,
          expiresAt: JANUARY,
        },
        at,
      );
      await points.grant(
        {
          wawuUserId: other,
          source: 'pack',
          sourceRef: ref('e2'),
          points: 30,
          expiresAt: JANUARY,
        },
        at,
      );
      await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: ref('e3'),
          points: 5,
          title: 'Captions',
        },
        at,
      );
      const section = (key: string) =>
        EXPORT_SECTIONS.find((s) => s.key === key)!;
      const lots = (await section('pointLots').load(prisma, me)) as Array<
        Record<string, unknown>
      >;
      const holds = (await section('pointHolds').load(prisma, me)) as Array<
        Record<string, unknown>
      >;
      const moves = (await section('pointMovements').load(prisma, me)) as Array<
        Record<string, unknown>
      >;
      expect(lots).toHaveLength(1);
      expect(lots[0]).toMatchObject({
        source: 'pack',
        quantity: 20,
        remaining: 15,
      });
      expect(lots[0]).not.toHaveProperty('sourceRef');
      expect(holds).toEqual([
        expect.objectContaining({
          title: 'Captions',
          quantity: 5,
          state: 'held',
        }),
      ]);
      expect(moves.map((m) => m.delta)).toEqual([-5, 20]);
      expect(moves[0]).not.toHaveProperty('reference');
    });

    it('deleting an account removes all of its points rows and nobody else’s', async () => {
      const me = person();
      const other = person();
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef: ref('d1'),
          points: 20,
          expiresAt: JANUARY,
        },
        at,
      );
      const h = await points.hold(
        { wawuUserId: me, purpose: 'ai_job', reference: ref('d2'), points: 5 },
        at,
      );
      await points.release({ holdId: h.holdId }, at);
      await points.grant(
        {
          wawuUserId: other,
          source: 'pack',
          sourceRef: ref('d3'),
          points: 30,
          expiresAt: JANUARY,
        },
        at,
      );

      const purged = await new AccountPurgeService(prisma).purge(me);
      expect(purged.deleted).toMatchObject({
        'PointLedger.wawuUserId': 3,
        'PointHold.wawuUserId': 1,
        'PointLot.wawuUserId': 1,
      });
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: me } }),
      ).toBe(0);
      expect(await prisma.pointLot.count({ where: { wawuUserId: me } })).toBe(
        0,
      );
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: other } }),
      ).toBe(1);
      expect((await points.view(other, NOW)).balance).toBe(30);
    });
  });
});

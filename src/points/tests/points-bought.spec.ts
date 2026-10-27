// POINTS-BOUGHT (R-101 point 7, owner, 27 Oct 2026): "Bought points cannot be cashed
// out ... it can't expire ... This applies for the Play Store build too."
// Points a person bought (lot sources pack, bump, shortfall) never end and are never
// cashable; earned and bonus points (tier_bonus, referral) keep their rules. Real
// database (the caller's DATABASE_URL), the real PointsService, no provider and no HTTP.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import type { PointLotSource } from '../../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  BOUGHT_POINT_SOURCES,
  endOf,
  isBoughtSource,
  NOT_CASHABLE_WORDS,
  POINTS_NEVER_EXPIRES,
} from '../points-bought';
import { PointsError } from '../points-error';
import { purgePersonPoints } from '../points-purge';
import { PointsService } from '../points.service';

const NOW = new Date('2026-10-27T09:00:00.000Z');
const at = { now: NOW };
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const YEARS_LATER = new Date('2031-10-27T09:00:00.000Z');

describe('POINTS-BOUGHT: bought points never expire and are never cashable', () => {
  let prisma: PrismaService;
  let points: PointsService;
  const people: string[] = [];
  const person = (): string => {
    const id = `pb-${randomUUID()}`;
    people.push(id);
    return id;
  };
  const give = (
    who: string,
    source: PointLotSource,
    n: number,
    ends: Date | null,
    now = NOW,
  ) =>
    points.grant(
      {
        wawuUserId: who,
        source,
        sourceRef: `pb-${randomUUID()}`,
        points: n,
        // A bought lot is given an end on purpose: it must be ignored.
        expiresAt: ends ?? days(365),
      },
      { now },
    );
  const refusal = async (p: Promise<unknown>): Promise<PointsError> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(PointsError);
      return e as PointsError;
    }
    throw new Error('expected a refusal');
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    points = new PointsService(prisma);
  }, 60_000);
  afterAll(async () => {
    for (const id of people) await purgePersonPoints(prisma, id);
    await prisma.$disconnect();
  }, 120_000);

  describe('1. a bought lot has no end', () => {
    it.each(['pack', 'bump', 'shortfall'] as const)(
      'a %s lot is stored with the "never" end whatever end the caller gives',
      async (source) => {
        const me = person();
        const out = await give(me, source, 100, days(30));
        expect(out.expiresAt.getTime()).toBe(POINTS_NEVER_EXPIRES.getTime());
        const lot = await prisma.pointLot.findUniqueOrThrow({
          where: { id: out.lotId },
        });
        expect(lot.expiresAt.getTime()).toBe(POINTS_NEVER_EXPIRES.getTime());
        expect(endOf(lot.expiresAt)).toBeNull();
      },
    );

    it('a bought grant needs no valid end; an earned or bonus lot still must end in the future and before the never date', async () => {
      const me = person();
      await expect(
        give(me, 'pack', 10, new Date('2020-01-01T00:00:00Z')),
      ).resolves.toMatchObject({ granted: true });
      for (const source of ['tier_bonus', 'referral'] as const) {
        const past = await refusal(give(me, source, 10, days(-1)));
        expect(past.code).toBe('points_invalid');
        const far = await refusal(give(me, source, 10, POINTS_NEVER_EXPIRES));
        expect(far.code).toBe('points_invalid');
      }
      const earned = await give(me, 'tier_bonus', 10, days(90));
      expect(earned.expiresAt.getTime()).toBe(days(90).getTime());
    });

    it('the sources are exactly pack, bump and shortfall', () => {
      expect([...BOUGHT_POINT_SOURCES].sort()).toEqual([
        'bump',
        'pack',
        'shortfall',
      ]);
      for (const s of ['tier_bonus', 'referral', 'returned'] as const)
        expect(isBoughtSource(s)).toBe(false);
    });

    it('the expiry job leaves a bought lot alone years later, and writes off the earned one', async () => {
      const me = person();
      const bought = await give(me, 'pack', 500, null);
      const earned = await give(me, 'tier_bonus', 40, days(60));
      await points.expireLapsed(YEARS_LATER);
      const lots = await prisma.pointLot.findMany({
        where: { wawuUserId: me },
      });
      const by = (id: string) => lots.find((l) => l.id === id)!;
      expect(by(bought.lotId)).toMatchObject({
        remaining: 500,
        lapsedAt: null,
      });
      expect(by(earned.lotId)).toMatchObject({ remaining: 0 });
      expect(await points.balanceOf(me, YEARS_LATER)).toBe(500);
    });
  });

  describe('2. the view says what can be cashed out', () => {
    it('mixed lots: balance counts all, cashablePoints only earned and bonus, bought lots show no end', async () => {
      const me = person();
      await give(me, 'pack', 1000, null);
      await give(me, 'bump', 50, null);
      const bonus = await give(me, 'tier_bonus', 120, days(100));
      const referral = await give(me, 'referral', 30, days(10));
      const view = await points.view(me, NOW);
      expect(view.balance).toBe(1200);
      expect(view.cashablePoints).toBe(150);
      expect(view.lotCount).toBe(4);
      // Lots that end first, soonest first; then the lots that never end.
      expect(view.lots.map((l) => [l.source, l.expiresAt, l.cashable])).toEqual(
        [
          ['referral', days(10).toISOString(), true],
          ['tier_bonus', days(100).toISOString(), true],
          ['pack', null, false],
          ['bump', null, false],
        ],
      );
      expect(view.lots[0].id).toBe(referral.lotId);
      expect(view.lots[1].id).toBe(bonus.lotId);
      // The next end is an earned lot's; bought points have no end to show.
      expect(view.nextExpiry).toEqual({
        points: 30,
        expiresAt: days(10).toISOString(),
      });
      expect(await points.cashableBalanceOf(me, NOW)).toBe(150);
    });

    it('a person with only bought points has a balance, nothing to cash out and no next end', async () => {
      const me = person();
      await give(me, 'pack', 800, null);
      const view = await points.view(me, NOW);
      expect(view).toMatchObject({
        balance: 800,
        cashablePoints: 0,
        nextExpiry: null,
        lotCount: 1,
      });
      expect(await points.cashableBalanceOf(me, NOW)).toBe(0);
    });

    it('earned points that have ended are neither balance nor cashable', async () => {
      const me = person();
      await give(me, 'tier_bonus', 60, days(5));
      await give(me, 'pack', 10, null);
      const later = days(6);
      expect(await points.balanceOf(me, later)).toBe(10);
      expect(await points.cashableBalanceOf(me, later)).toBe(0);
    });
  });

  describe('3. spending (an AI tool) takes lots that end soonest first, bought lots last', () => {
    it('earned and bonus lots by end date, then the bought lots, oldest first', async () => {
      const me = person();
      // The bought lot is granted FIRST, so "last" is by the rule and not by the grant.
      const bought1 = await give(me, 'pack', 100, null);
      const bought2 = await give(me, 'shortfall', 100, null);
      const march = await give(me, 'tier_bonus', 100, days(150));
      const january = await give(me, 'referral', 100, days(60));
      const out = await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: `pb-${randomUUID()}`,
          points: 350,
        },
        at,
      );
      expect(out.parts).toEqual([
        { lotId: january.lotId, points: 100 },
        { lotId: march.lotId, points: 100 },
        { lotId: bought1.lotId, points: 100 },
        { lotId: bought2.lotId, points: 50 },
      ]);
    });

    it('a small job spends the earned points and leaves every bought point', async () => {
      const me = person();
      const bought = await give(me, 'pack', 1000, null);
      await give(me, 'tier_bonus', 80, days(30));
      await points.hold(
        {
          wawuUserId: me,
          purpose: 'ai_job',
          reference: `pb-${randomUUID()}`,
          points: 80,
        },
        at,
      );
      const lot = await prisma.pointLot.findUniqueOrThrow({
        where: { id: bought.lotId },
      });
      expect(lot.remaining).toBe(1000);
    });

    it('a released hold gives the points back to the bought lot, which is still live years later', async () => {
      const me = person();
      const bought = await give(me, 'pack', 100, null);
      const reference = `pb-${randomUUID()}`;
      await points.hold(
        { wawuUserId: me, purpose: 'ai_job', reference, points: 60 },
        at,
      );
      await points.release({ purpose: 'ai_job', reference }, at);
      const lot = await prisma.pointLot.findUniqueOrThrow({
        where: { id: bought.lotId },
      });
      expect(lot).toMatchObject({ remaining: 100, lapsedAt: null });
      expect(await points.balanceOf(me, YEARS_LATER)).toBe(100);
    });
  });

  describe('4. cash-out takes only earned and bonus points', () => {
    it('holds the earned points, soonest end first, and never touches a bought lot', async () => {
      const me = person();
      const bought = await give(me, 'pack', 5000, null);
      const late = await give(me, 'tier_bonus', 70, days(200));
      const soon = await give(me, 'referral', 50, days(20));
      const out = await points.hold(
        {
          wawuUserId: me,
          purpose: 'cash_out',
          reference: `pb-${randomUUID()}`,
          points: 120,
        },
        at,
      );
      expect(out.parts).toEqual([
        { lotId: soon.lotId, points: 50 },
        { lotId: late.lotId, points: 70 },
      ]);
      const lot = await prisma.pointLot.findUniqueOrThrow({
        where: { id: bought.lotId },
      });
      expect(lot.remaining).toBe(5000);
    });

    it('asking for one point more than the earned points is points_not_cashable, and nothing is held', async () => {
      const me = person();
      await give(me, 'pack', 5000, null);
      await give(me, 'tier_bonus', 120, days(30));
      const reference = `pb-${randomUUID()}`;
      const err = await refusal(
        points.hold(
          { wawuUserId: me, purpose: 'cash_out', reference, points: 121 },
          at,
        ),
      );
      expect(err.code).toBe('points_not_cashable');
      expect(err.getStatus()).toBe(422);
      expect(err.message).toBe(NOT_CASHABLE_WORDS);
      expect(err.detail).toEqual({
        balancePoints: 5120,
        cashablePoints: 120,
        neededPoints: 121,
      });
      expect(await prisma.pointHold.count({ where: { reference } })).toBe(0);
      expect(await points.balanceOf(me, NOW)).toBe(5120);
    });

    it('more than the whole balance is still insufficient_points, as before', async () => {
      const me = person();
      await give(me, 'pack', 100, null);
      await give(me, 'tier_bonus', 20, days(30));
      const err = await refusal(
        points.hold(
          {
            wawuUserId: me,
            purpose: 'cash_out',
            reference: `pb-${randomUUID()}`,
            points: 121,
          },
          at,
        ),
      );
      expect(err.code).toBe('insufficient_points');
      expect(err.detail).toMatchObject({
        balancePoints: 120,
        shortfallPoints: 1,
      });
    });

    it('a person with only bought points cannot cash out one point', async () => {
      const me = person();
      await give(me, 'pack', 100, null);
      const err = await refusal(
        points.hold(
          {
            wawuUserId: me,
            purpose: 'cash_out',
            reference: `pb-${randomUUID()}`,
            points: 1,
          },
          at,
        ),
      );
      expect(err.code).toBe('points_not_cashable');
      expect(err.detail.cashablePoints).toBe(0);
    });
  });

  describe('5. a store refund takes back only what is unspent', () => {
    it('revokeLot on a bought lot with spent points takes the remainder and no more', async () => {
      const me = person();
      const sourceRef = `pb-${randomUUID()}`;
      await points.grant(
        {
          wawuUserId: me,
          source: 'pack',
          sourceRef,
          points: 100,
          expiresAt: days(1),
        },
        at,
      );
      const reference = `pb-${randomUUID()}`;
      await points.hold(
        { wawuUserId: me, purpose: 'ai_job', reference, points: 30 },
        at,
      );
      await points.commit({ purpose: 'ai_job', reference }, at);
      const taken = await points.revokeLot('pack', sourceRef, at);
      expect(taken).toEqual({ taken: 70, granted: 100 });
      expect(await points.balanceOf(me, NOW)).toBe(0);
      // Again: nothing more to take.
      expect(await points.revokeLot('pack', sourceRef, at)).toEqual({
        taken: 0,
        granted: 100,
      });
    });
  });
});

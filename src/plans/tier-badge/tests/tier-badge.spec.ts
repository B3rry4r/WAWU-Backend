import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { purgePersonPoints } from '../../../points/points-purge';
import { PlansModule } from '../../plans.module';
import { TierGrantService } from '../../tier-grant.service';
import { TierBadgeModule } from '../tier-badge.module';
import { TierBadgeService } from '../tier-badge.service';

/**
 * TIER-07: who shows a tier badge, and the number on a numbered one. Real
 * database, the real grant: a badge exists exactly while a tier runs, and a
 * Founding Maker's number is given once, never repeated and kept for life.
 */

const DAY = 86_400_000;
const WHO = 'tier-badge-spec-';

describe('Tier badge and its number (TIER-07)', () => {
  let prisma: PrismaService;
  let grants: TierGrantService;
  let badges: TierBadgeService;
  let close: () => Promise<void>;
  const people: string[] = [];

  const person = () => {
    const sub = `${WHO}${people.length}-${Date.now()}`;
    people.push(sub);
    return sub;
  };
  const grant = (
    sub: string,
    ref: string,
    over: { tierId?: string; now?: Date; days?: number } = {},
  ) =>
    prisma.$transaction((tx) =>
      grants.grant(tx, {
        wawuUserId: sub,
        tierId: over.tierId ?? 'founding',
        sourceRef: ref,
        ...(over.now ? { now: over.now } : {}),
        ...(over.days ? { days: over.days } : {}),
      }),
    );
  const numberOf = async (sub: string) =>
    (
      await prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: sub },
        select: { badgeNumber: true },
      })
    ).badgeNumber;
  const counter = async () =>
    (
      await prisma.badgeNumberCounter.findUniqueOrThrow({
        where: { name: 'numbered_badge' },
      })
    ).last;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PlansModule,
        TierBadgeModule,
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    grants = mod.get(TierGrantService);
    badges = mod.get(TierBadgeService);
    close = () => mod.close();
  });

  afterAll(async () => {
    for (const sub of people) {
      await purgePersonPoints(prisma, sub);
      await prisma.eventPass.deleteMany({ where: { wawuUserId: sub } });
      await prisma.makerTier.deleteMany({ where: { wawuUserId: sub } });
    }
    await close();
  });

  it('a person with a running Verify or Verify Plus tier shows the Verify badge, with no number', async () => {
    const a = person();
    const b = person();
    await grant(a, 'badge:a', { tierId: 'verify' });
    await grant(b, 'badge:b', { tierId: 'plus' });
    expect(await badges.forOne(a)).toEqual({
      id: 'verified',
      numbered: false,
      name: 'Verify',
      number: null,
    });
    expect(await badges.forOne(b)).toEqual({
      id: 'verified',
      numbered: false,
      name: 'Verify Plus',
      number: null,
    });
  });

  it('the badge disappears when the tier ends, at the exact moment it ends, and is still shown while it is ending', async () => {
    const sub = person();
    const now = new Date('2026-10-17T10:00:00.000Z');
    const out = await grant(sub, 'badge:end', { tierId: 'verify', now });
    const until = out.activeUntil.getTime();
    const at = (t: number) => badges.forOne(sub, new Date(t));
    expect(await at(until - 60 * DAY)).not.toBeNull(); // active
    expect(await at(until - 1000)).not.toBeNull(); // ending
    expect(await at(until)).toBeNull(); // ended
    expect(await at(until + 400 * DAY)).toBeNull();
  });

  it('a person with no tier, or a tier the plan no longer names, has no badge; the others on the page keep theirs', async () => {
    const withTier = person();
    const none = person();
    const retired = person();
    await grant(withTier, 'badge:page', { tierId: 'verify' });
    await prisma.makerTier.create({
      data: {
        wawuUserId: retired,
        tierId: 'retired_tier',
        activeFrom: new Date(),
        activeUntil: new Date(Date.now() + 30 * DAY),
        productsIncluded: 3,
        pointsIncluded: 0,
      },
    });
    const map = await badges.forMany([withTier, none, retired, withTier]);
    expect([...map.keys()]).toEqual([withTier]);
    expect(await badges.forMany([])).toEqual(new Map());
  });

  it('two Founding Makers get different numbers, shown on their badges', async () => {
    const a = person();
    const b = person();
    await grant(a, 'badge:f-a');
    await grant(b, 'badge:f-b');
    const na = await numberOf(a);
    const nb = await numberOf(b);
    expect(na).not.toBeNull();
    expect(nb).toBe(na! + 1);
    expect(await badges.forOne(a)).toEqual({
      id: 'founding',
      numbered: true,
      name: 'Founding Maker',
      number: na,
    });
    expect((await badges.forOne(b))?.number).toBe(nb);
  });

  it('the number is given once: the same payment confirmed again changes nothing and uses no number', async () => {
    const sub = person();
    await grant(sub, 'badge:once');
    const n = await numberOf(sub);
    const used = await counter();
    const again = await grant(sub, 'badge:once');
    expect(again.granted).toBe(false);
    expect(await numberOf(sub)).toBe(n);
    expect(await counter()).toBe(used);
  });

  it('a renewal keeps the number; so does an ended tier bought again and a stop at another tier in between', async () => {
    const sub = person();
    const t0 = new Date('2026-01-05T00:00:00.000Z');
    await grant(sub, 'badge:life-1', { now: t0 });
    const n = (await numberOf(sub))!;
    const used = await counter();
    await grant(sub, 'badge:life-2', { now: new Date(t0.getTime() + DAY) }); // renew
    expect(await numberOf(sub)).toBe(n);
    // The year ends, Verify is bought: the number stays on the row but is not shown.
    const later = new Date(t0.getTime() + 800 * DAY);
    await grant(sub, 'badge:life-3', { tierId: 'verify', now: later });
    expect(await numberOf(sub)).toBe(n);
    expect((await badges.forOne(sub, later))?.number).toBeNull();
    // Founding again after Verify ends: the same number comes back.
    const much = new Date(later.getTime() + 400 * DAY);
    await grant(sub, 'badge:life-4', { now: much });
    expect(await numberOf(sub)).toBe(n);
    expect((await badges.forOne(sub, much))?.number).toBe(n);
    expect(await counter()).toBe(used);
  });

  it('an upgrade to Founding Maker numbers the person once', async () => {
    const sub = person();
    await grant(sub, 'badge:up-1', { tierId: 'verify' });
    expect(await numberOf(sub)).toBeNull();
    await prisma.$transaction((tx) =>
      grants.upgrade(tx, {
        wawuUserId: sub,
        fromTierId: 'verify',
        tierId: 'founding',
        sourceRef: 'badge:up-2',
      }),
    );
    const n = await numberOf(sub);
    expect(n).not.toBeNull();
    expect((await badges.forOne(sub))?.number).toBe(n);
  });

  it('a Founding Maker held before numbers existed shows no number until their next grant gives one', async () => {
    const sub = person();
    await prisma.makerTier.create({
      data: {
        wawuUserId: sub,
        tierId: 'founding',
        activeFrom: new Date(Date.now() - DAY),
        activeUntil: new Date(Date.now() + 100 * DAY),
        productsIncluded: 10,
        pointsIncluded: 600,
      },
    });
    expect(await badges.forOne(sub)).toMatchObject({
      id: 'founding',
      number: null,
    });
    await grant(sub, 'badge:legacy');
    expect((await badges.forOne(sub))?.number).toBe(await numberOf(sub));
    expect(await numberOf(sub)).not.toBeNull();
  });

  it('eight Founding Makers bought at once get eight different numbers with no gap', async () => {
    const group = Array.from({ length: 8 }, () => person());
    await Promise.all(group.map((s, i) => grant(s, `badge:race-${i}`)));
    const numbers = (await Promise.all(group.map(numberOf)))
      .map((n) => n!)
      .sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[7] - numbers[0]).toBe(7);
  });

  it('a purchase that rolls back gives its number back: the next buyer gets it', async () => {
    const failed = person();
    const next = person();
    const before = await counter();
    await expect(
      prisma.$transaction(async (tx) => {
        await grants.grant(tx, {
          wawuUserId: failed,
          tierId: 'founding',
          sourceRef: 'badge:rollback',
        });
        throw new Error('the purchase failed after the grant');
      }),
    ).rejects.toThrow('the purchase failed');
    expect(await counter()).toBe(before);
    await grant(next, 'badge:after-rollback');
    expect(await numberOf(next)).toBe(before + 1);
  });

  it('the number is never one that is already held, even if the counter is behind', async () => {
    const holder = person();
    const sub = person();
    await grant(holder, 'badge:behind-1');
    const held = (await numberOf(holder))!;
    await prisma.badgeNumberCounter.update({
      where: { name: 'numbered_badge' },
      data: { last: 0 },
    });
    await grant(sub, 'badge:behind-2');
    expect((await numberOf(sub))!).toBeGreaterThan(held);
  });
});

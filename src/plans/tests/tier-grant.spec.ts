import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { purgePersonPoints } from '../../points/points-purge';
import { loadPlansConfig, tierById } from '../plans-config';
import { PlansModule } from '../plans.module';
import { TierGrantService } from '../tier-grant.service';

/**
 * JOIN-03: the one place a tier is granted (TierGrantService). The claim in
 * the app goes through it over HTTP (waitlist-claim.contract.spec.ts); this
 * file holds what only a direct call can show: a reference grants once, two
 * grants for one person at once both count, and what is refused is refused.
 */

const DAY = 86_400_000;
const WHO = 'tier-grant-spec-';

describe('TierGrantService (JOIN-03)', () => {
  let prisma: PrismaService;
  let grants: TierGrantService;
  let close: () => Promise<void>;
  const people: string[] = [];
  const config = loadPlansConfig();
  const verify = tierById(config, 'verify')!;

  const person = () => {
    const sub = `${WHO}${people.length}-${Date.now()}`;
    people.push(sub);
    return sub;
  };
  const grant = (
    sub: string,
    ref: string,
    over: { tierId?: string; days?: number; now?: Date } = {},
  ) =>
    prisma.$transaction((tx) =>
      grants.grant(tx, {
        wawuUserId: sub,
        tierId: over.tierId ?? 'verify',
        sourceRef: ref,
        ...(over.days === undefined ? {} : { days: over.days }),
        ...(over.now === undefined ? {} : { now: over.now }),
      }),
    );

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PlansModule,
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    grants = mod.get(TierGrantService);
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

  it("gives the tier's days, pass, first Voice Intro and bonus points from now, copying what the tier gives", async () => {
    const sub = person();
    const now = new Date('2026-10-17T10:00:00.000Z');
    const out = await grant(sub, 'spec:a', { now });
    expect(out).toMatchObject({
      granted: true,
      tierId: 'verify',
      extended: false,
      daysAdded: verify.days,
      pointsGranted: verify.bonusPoints,
    });
    expect(out.activeFrom).toEqual(now);
    expect(out.activeUntil.getTime()).toBe(now.getTime() + verify.days * DAY);
    expect(out.pointsExpireAt!.getTime()).toBe(
      now.getTime() + verify.bonusExpiryDays * DAY,
    );
    const row = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: sub },
    });
    expect(row).toMatchObject({
      tierId: 'verify',
      productsIncluded: verify.products,
      extraProducts: 0,
      pointsIncluded: verify.bonusPoints,
      voiceIntroIncluded: verify.firstVoiceIntro,
    });
  });

  it('a reference grants once however often it is asked: the second call writes nothing', async () => {
    const sub = person();
    const first = await grant(sub, 'spec:once');
    const again = await grant(sub, 'spec:once', { days: 400 });
    expect(again).toMatchObject({
      granted: false,
      extended: false,
      daysAdded: 0,
      pointsGranted: 0,
      pointsExpireAt: null,
    });
    expect(again.activeUntil).toEqual(first.activeUntil);
    expect(await prisma.eventPass.count({ where: { wawuUserId: sub } })).toBe(
      1,
    );
    expect(await prisma.pointLot.count({ where: { wawuUserId: sub } })).toBe(1);
  });

  it('five grants for one person at once all count: one tier row, five passes, five lots, the days added one after the other', async () => {
    const sub = person();
    const now = new Date();
    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => grant(sub, `spec:race-${n}`, { now })),
    );
    expect(out.filter((o) => o.extended)).toHaveLength(4);
    expect(out.filter((o) => !o.extended)).toHaveLength(1);
    const row = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: sub },
    });
    expect(row.activeUntil.getTime()).toBe(
      now.getTime() + 5 * verify.days * DAY,
    );
    expect(await prisma.eventPass.count({ where: { wawuUserId: sub } })).toBe(
      5,
    );
    expect(await prisma.pointLot.count({ where: { wawuUserId: sub } })).toBe(5);
  });

  it('never starts a period in the future: a held tier is extended, and an ended one is replaced from now', async () => {
    const sub = person();
    const now = new Date();
    await prisma.makerTier.create({
      data: {
        wawuUserId: sub,
        tierId: 'plus',
        activeFrom: new Date(now.getTime() - 300 * DAY),
        activeUntil: new Date(now.getTime() - 1000),
        productsIncluded: 6,
        pointsIncluded: 300,
      },
    });
    const out = await grant(sub, 'spec:ended', { now });
    expect(out.extended).toBe(false);
    expect(out.activeFrom.getTime()).toBeLessThanOrEqual(
      out.activeUntil.getTime(),
    );
    const row = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: sub },
    });
    expect(row.tierId).toBe('verify');
    expect(row.activeFrom.getTime()).toBe(now.getTime());
  });

  it('refuses a tier the plans file does not name, and days that are not a whole number of at least one, writing nothing', async () => {
    const sub = person();
    await expect(grant(sub, 'spec:x', { tierId: 'nope' })).rejects.toThrow(
      /names no tier/,
    );
    for (const days of [0, -3, 1.5, Number.NaN]) {
      await expect(grant(sub, 'spec:x', { days })).rejects.toThrow(
        /whole number of days/,
      );
    }
    await expect(
      grant(sub, 'spec:x', { days: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(/last date/);
    expect(await prisma.eventPass.count({ where: { wawuUserId: sub } })).toBe(
      0,
    );
    expect(await prisma.makerTier.count({ where: { wawuUserId: sub } })).toBe(
      0,
    );
  });

  it('a failed points grant undoes the whole grant', async () => {
    const sub = person();
    await expect(
      prisma.$transaction(async (tx) => {
        await grants.grant(tx, {
          wawuUserId: sub,
          tierId: 'verify',
          sourceRef: 'spec:rollback',
        });
        throw new Error('the caller failed after the grant');
      }),
    ).rejects.toThrow(/caller failed/);
    expect(await prisma.makerTier.count({ where: { wawuUserId: sub } })).toBe(
      0,
    );
    expect(await prisma.eventPass.count({ where: { wawuUserId: sub } })).toBe(
      0,
    );
    expect(await prisma.pointLot.count({ where: { wawuUserId: sub } })).toBe(0);
  });
});

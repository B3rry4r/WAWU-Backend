// Task AITOOLS-05 (a fix after CI): the points sweep settles an ordinary AI
// hold exactly as it did before dubbing, and only a WORKING dub waits.
//
// Runs against the caller's DATABASE_URL with the real migration, like the
// other points specs. It does not boot the app, the money module or any
// payment double: the three services are built over a real PrismaService, and
// the settings service reads the plan's own defaults.
//
// The cause it pins: the sweep looked up the working dubs (a read of
// AiToolJob) BEFORE it read the due holds, so every ordinary hold reached its
// release one database round trip later than it had. A job that commits late
// and the sweep race for a hold; the extra read made the sweep lose every
// race, which the "late commit and the sweep" contract test of POINTS-03 saw
// as a person's points pinned by commits (insufficient_points).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { loadPlanSettingsDefaults } from '../../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../../plans/plans-config';
import { PointsService } from '../../points.service';
import { purgePersonPoints } from '../../points-purge';
import {
  DUB_ACTION_ID,
  DUB_MAX_RUN_SETTING,
  JOB_MAX_RUN_SETTING,
  PointsHoldSweepService,
} from '../points-hold-sweep.service';
import { PointsSpendService, jobHoldReference } from '../points-spend.service';

jest.setTimeout(120_000);

const config = loadPlansConfig();
const DAY = 86_400_000;
const MINUTE = 60_000;
const minuteTool = config.actions.find((a) => a.per === 'minute')!;
const dubTool = config.actions.find((a) => a.id === DUB_ACTION_ID)!;

describe('The points sweep and a working dub (AITOOLS-05)', () => {
  let prisma: PrismaService;
  let points: PointsService;
  let spend: PointsSpendService;
  let sweep: PointsHoldSweepService;
  let settings: PlanSettingsService;
  const people: string[] = [];

  const person = (): string => {
    const id = `a05sw-${randomUUID()}`;
    people.push(id);
    return id;
  };
  const give = (wawuUserId: string, n: number) =>
    points.grant({
      wawuUserId,
      source: 'pack',
      sourceRef: randomUUID(),
      points: n,
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
  const ref = () => jobHoldReference(randomUUID(), 1);
  const balanceOf = (wawuUserId: string) => points.balanceOf(wawuUserId);
  const stateOf = async (holdId: string) =>
    (await prisma.pointHold.findUniqueOrThrow({ where: { id: holdId } })).state;
  /** A job row for a hold, as the Dubbing tool writes it. */
  const jobFor = (
    wawuUserId: string,
    holdId: string,
    tool: string,
    state: 'working' | 'done' | 'failed',
    startedAt: Date,
  ) =>
    prisma.aiToolJob.create({
      data: {
        wawuUserId,
        tool,
        idempotencyKey: randomUUID(),
        requestHash: 'a05sw',
        voiceId: 'a05sw',
        characters: 0,
        units: 1,
        costPoints: 1,
        state,
        holdId,
        failureCode: state === 'failed' ? 'provider_failed' : null,
        createdAt: startedAt,
      },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    points = new PointsService(prisma);
    spend = new PointsSpendService(prisma, config, points);
    // The plan's own defaults; nothing an admin saved.
    settings = new PlanSettingsService(
      { planSetting: { findMany: () => Promise.resolve([]) } } as never,
      loadPlanSettingsDefaults(),
    );
    sweep = new PointsHoldSweepService(spend, settings);
  }, 60_000);

  afterAll(async () => {
    for (const id of people) {
      await prisma.aiToolJob.deleteMany({ where: { wawuUserId: id } });
      await purgePersonPoints(prisma, id);
    }
    await prisma.$disconnect();
  }, 120_000);

  it('an ordinary hold reaches its release after one read of the holds, as it did before dubbing', async () => {
    const p = person();
    await give(p, 1000);
    const held = await spend.hold({
      wawuUserId: p,
      action: minuteTool.id,
      units: 1,
      reference: ref(),
    });
    const maxMinutes = settings.number(JOB_MAX_RUN_SETTING);

    // What the sweep reads, in order, until the first write opens the release.
    const order: string[] = [];
    const watch = <T extends object>(
      target: T,
      method: keyof T & string,
      label: string,
    ) => {
      const real = (target[method] as (...a: unknown[]) => unknown).bind(
        target,
      );
      return jest.spyOn(target as never, method as never).mockImplementation(((
        ...a: unknown[]
      ) => {
        order.push(label);
        return real(...a);
      }) as never);
    };
    const spies = [
      watch(prisma.pointHold, 'findMany', 'holds'),
      watch(prisma.aiToolJob, 'findMany', 'jobs'),
      watch(prisma, '$queryRaw', 'raw'),
      watch(prisma, '$transaction', 'release'),
    ];
    try {
      await sweep.run(new Date(Date.now() + (maxMinutes + 1) * MINUTE));
    } finally {
      for (const s of spies) s.mockRestore();
    }

    // One read finds the due holds (the dub's wait is part of that one read),
    // and the very next call is the release. No read stands between them.
    const beforeRelease = order.slice(0, order.indexOf('release'));
    expect(beforeRelease).toHaveLength(1);
    expect(await stateOf(held.holdId)).toBe('released');
  });

  it('a late commit and the sweep still race evenly: the sweep wins most of them, as it did before dubbing', async () => {
    // The scenario of the POINTS-03 contract test ("a late commit and the
    // sweep cannot both win"), counted over many rounds instead of five. That
    // test lets a person's four jobs' worth of points be spent, so it fails
    // (insufficient_points on the fifth hold) when the sweep loses its first
    // four races. Before dubbing the sweep won about three in four; with the
    // working jobs read ahead of the holds it won about one in four. Here the
    // bar is two in five, far from both.
    const maxMinutes = settings.number(JOB_MAX_RUN_SETTING);
    let swept = 0;
    let rounds = 0;
    for (let who = 0; who < 5; who += 1) {
      const p = person();
      await give(p, minuteTool.points * 20);
      for (let i = 0; i < 10; i += 1) {
        const later = new Date(Date.now() + (maxMinutes + 1) * MINUTE);
        const held = await spend.hold({
          wawuUserId: p,
          action: minuteTool.id,
          units: 1,
          reference: ref(),
        });
        const [commit] = await Promise.allSettled([
          spend.commit(held.holdId),
          sweep.run(later),
        ]);
        const state = await stateOf(held.holdId);
        // Exactly one settles the hold, and the loser is refused cleanly.
        expect(state).toBe(
          commit.status === 'fulfilled' ? 'committed' : 'released',
        );
        if (commit.status === 'rejected') {
          expect(commit.reason).toMatchObject({ code: 'points_hold_settled' });
        }
        if (state === 'released') swept += 1;
        rounds += 1;
      }
    }
    expect(swept).toBeGreaterThanOrEqual(Math.ceil(rounds * 0.4));
  });

  it('a WORKING dub keeps its hold until the dub run limit, then the sweep gives it back', async () => {
    const p = person();
    await give(p, dubTool.points * 3);
    const ordinaryMax = settings.number(JOB_MAX_RUN_SETTING);
    const dubMax = settings.number(DUB_MAX_RUN_SETTING);
    expect(dubMax).toBeGreaterThan(ordinaryMax);

    const startedAt = new Date();
    const dub = await spend.hold({
      wawuUserId: p,
      action: dubTool.id,
      units: 1,
      languages: 1,
      reference: ref(),
    });
    await jobFor(p, dub.holdId, DUB_ACTION_ID, 'working', startedAt);
    const before = await balanceOf(p);

    // Past the ordinary limit, inside the dub's: the dub's hold stays.
    await sweep.run(new Date(startedAt.getTime() + (ordinaryMax + 1) * MINUTE));
    expect(await stateOf(dub.holdId)).toBe('held');
    expect(await balanceOf(p)).toBe(before);

    // Past the dub's own limit: swept like any other hold.
    await sweep.run(new Date(startedAt.getTime() + (dubMax + 1) * MINUTE));
    expect(await stateOf(dub.holdId)).toBe('released');
    expect(await balanceOf(p)).toBe(before + dubTool.points);
  });

  it('only a working dub waits: a finished dub, a failed dub and a working job of another tool are swept at the ordinary limit', async () => {
    const p = person();
    await give(p, dubTool.points * 3 + minuteTool.points);
    const ordinaryMax = settings.number(JOB_MAX_RUN_SETTING);
    const startedAt = new Date();

    const done = await spend.hold({
      wawuUserId: p,
      action: dubTool.id,
      units: 1,
      languages: 1,
      reference: ref(),
    });
    await jobFor(p, done.holdId, DUB_ACTION_ID, 'done', startedAt);
    const failed = await spend.hold({
      wawuUserId: p,
      action: dubTool.id,
      units: 1,
      languages: 1,
      reference: ref(),
    });
    await jobFor(p, failed.holdId, DUB_ACTION_ID, 'failed', startedAt);
    const other = await spend.hold({
      wawuUserId: p,
      action: minuteTool.id,
      units: 1,
      reference: ref(),
    });
    await jobFor(p, other.holdId, minuteTool.id, 'working', startedAt);
    const bare = await spend.hold({
      wawuUserId: p,
      action: minuteTool.id,
      units: 1,
      reference: ref(),
    });

    // Just inside the ordinary limit nothing moves.
    await sweep.run(new Date(startedAt.getTime() + (ordinaryMax - 1) * MINUTE));
    for (const h of [done, failed, other, bare]) {
      expect(await stateOf(h.holdId)).toBe('held');
    }
    // Past it, all four are given back.
    await sweep.run(new Date(startedAt.getTime() + (ordinaryMax + 1) * MINUTE));
    for (const h of [done, failed, other, bare]) {
      expect(await stateOf(h.holdId)).toBe('released');
    }
  });
});

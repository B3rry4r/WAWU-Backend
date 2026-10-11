// Task POINTS-04: what the database itself refuses about a points-to-cash
// conversion (the migration's CHECKs and triggers), whatever the code does.
// Runs against the caller's DATABASE_URL with the real migration, like every
// other database spec here. Each run uses its own people (random ids) and
// removes every row it wrote.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PointsService } from '../../points.service';
import { purgePersonPoints } from '../../points-purge';

const RATE = 50_000n;
const cashOf = (points: number) => (BigInt(points) * RATE) / 1000n;

describe('POINTS-04: the database holds the rules of a conversion', () => {
  let prisma: PrismaService;
  let points: PointsService;
  const people: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    points = new PointsService(prisma);
  }, 60_000);

  afterAll(async () => {
    await prisma.pointConversion.deleteMany({
      where: { wawuUserId: { in: people } },
    });
    for (const id of people) await purgePersonPoints(prisma, id);
    await prisma.$disconnect();
  }, 120_000);

  /** A person with a lot of 5,000 points. */
  async function person(): Promise<string> {
    const id = `p04db-${randomUUID()}`;
    people.push(id);
    await points.grant({
      wawuUserId: id,
      source: 'pack',
      sourceRef: `p04db-${randomUUID()}`,
      points: 5000,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    return id;
  }

  const row = (
    id: string,
    who: string | null,
    over: Partial<Prisma.PointConversionUncheckedCreateInput> = {},
  ): Prisma.PointConversionUncheckedCreateInput => ({
    id,
    wawuUserId: who,
    points: 1000,
    cashKobo: cashOf(1000),
    per1000PointsKobo: RATE,
    merchantAccountNumber: '1102038668',
    provider: 'fintava',
    customerReference: `wawu-pts-${id}`,
    ...over,
  });

  /** The conversion and its hold, in one transaction, as the service writes them. */
  async function made(who: string, pts = 1000): Promise<string> {
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.pointConversion.create({
        data: row(id, who, { points: pts, cashKobo: cashOf(pts) }),
      });
      await points.hold(
        { wawuUserId: who, purpose: 'cash_out', reference: id, points: pts },
        { tx },
      );
    });
    return id;
  }

  const refused = async (p: Promise<unknown>, message: RegExp) => {
    await expect(p).rejects.toThrow(message);
  };

  it('a conversion needs its points hold by the time the transaction commits', async () => {
    const who = await person();
    const id = randomUUID();
    await refused(
      prisma.$transaction((tx) =>
        tx.pointConversion.create({ data: row(id, who) }),
      ),
      /there is no points hold for it/,
    );
    expect(await prisma.pointConversion.count({ where: { id } })).toBe(0);
    // With the hold, in either order, it stands.
    const ok = await made(who);
    expect(await prisma.pointConversion.count({ where: { id: ok } })).toBe(1);
  });

  it('paid needs a committed hold and cancelled a released one, whichever is written first', async () => {
    const who = await person();
    const a = await made(who);
    // Marked paid, the points not committed.
    await refused(
      prisma.$transaction((tx) =>
        tx.pointConversion.updateMany({
          where: { id: a },
          data: { status: 'paid', settledAt: new Date(), sentAt: new Date() },
        }),
      ),
      /the conversion is paid but its points are held/,
    );
    // Marked cancelled, the points committed (spent).
    await refused(
      prisma.$transaction(async (tx) => {
        await tx.pointConversion.updateMany({
          where: { id: a },
          data: {
            status: 'cancelled',
            settledAt: new Date(),
            failureReason: 'x',
          },
        });
        await points.commit({ purpose: 'cash_out', reference: a }, { tx });
      }),
      /the conversion is cancelled but its points are committed/,
    );
    // The hold alone moves on: the conversion still says held at commit.
    await refused(
      prisma.$transaction(async (tx) => {
        await points.commit({ purpose: 'cash_out', reference: a }, { tx });
        await tx.pointConversion.updateMany({
          where: { id: a },
          data: { nextAttemptAt: new Date() },
        });
        await tx.pointConversion.updateMany({
          where: { id: a },
          data: { status: 'held' },
        });
      }),
      /the conversion is held but its points are committed/,
    );
    // Written together, the right way round, both stand.
    await prisma.$transaction(async (tx) => {
      await tx.pointConversion.updateMany({
        where: { id: a },
        data: { status: 'paid', settledAt: new Date(), sentAt: new Date() },
      });
      await points.commit({ purpose: 'cash_out', reference: a }, { tx });
    });
    expect(
      (await prisma.pointConversion.findUniqueOrThrow({ where: { id: a } }))
        .status,
    ).toBe('paid');
    const b = await made(who);
    await prisma.$transaction(async (tx) => {
      await tx.pointConversion.updateMany({
        where: { id: b },
        data: {
          status: 'cancelled',
          settledAt: new Date(),
          failureReason: 'The payment did not go through.',
        },
      });
      await points.release({ purpose: 'cash_out', reference: b }, { tx });
    });
    expect(
      (await prisma.pointConversion.findUniqueOrThrow({ where: { id: b } }))
        .status,
    ).toBe('cancelled');
  });

  it('a settled conversion never changes how it ended, and a held one never changes what it is', async () => {
    const who = await person();
    const a = await made(who);
    await prisma.$transaction(async (tx) => {
      await tx.pointConversion.updateMany({
        where: { id: a },
        data: { status: 'paid', settledAt: new Date(), sentAt: new Date() },
      });
      await points.commit({ purpose: 'cash_out', reference: a }, { tx });
    });
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { status: 'held', settledAt: null },
      }),
      /a settled conversion never changes/,
    );
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { settledAt: new Date(Date.now() + 1000) },
      }),
      /a settled conversion never changes/,
    );
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { providerFeeKobo: 1n },
      }),
      /a settled conversion never changes/,
    );
    const c = await made(who);
    const fixed: Array<
      [string, Prisma.PointConversionUncheckedUpdateManyInput]
    > = [
      ['points', { points: 999 }],
      ['cashKobo', { cashKobo: 1n }],
      ['per1000PointsKobo', { per1000PointsKobo: 1n }],
      ['merchantAccountNumber', { merchantAccountNumber: '9999999999' }],
      ['provider', { provider: 'nuvion' }],
      ['customerReference', { customerReference: 'wawu-pts-other' }],
      ['createdAt', { createdAt: new Date(0) }],
    ];
    for (const [, data] of fixed) {
      await refused(
        prisma.pointConversion.updateMany({ where: { id: c }, data }),
        /what is converted, and for how much, never changes|violates check/,
      );
    }
    // The schedule and the notes stay writable on a held row.
    await prisma.pointConversion.updateMany({
      where: { id: c },
      data: { checks: { increment: 1 }, discrepancy: 'asked' },
    });
  });

  it('the person is never another person: only nobody, when the account is deleted', async () => {
    const who = await person();
    const other = await person();
    const a = await made(who);
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { wawuUserId: other },
      }),
      /never passes to another person/,
    );
    await prisma.pointConversion.updateMany({
      where: { id: a },
      data: { wawuUserId: null, destinationAccountNumber: null },
    });
    expect(
      (await prisma.pointConversion.findUniqueOrThrow({ where: { id: a } }))
        .wawuUserId,
    ).toBeNull();
  });

  it('a conversion whose points were deleted with the account can still be settled', async () => {
    const who = await person();
    const a = await made(who);
    await purgePersonPoints(prisma, who);
    await prisma.pointConversion.updateMany({
      where: { id: a },
      data: { wawuUserId: null },
    });
    await prisma.pointConversion.updateMany({
      where: { id: a },
      data: {
        status: 'cancelled',
        settledAt: new Date(),
        failureReason: 'The account was deleted.',
      },
    });
    expect(
      (await prisma.pointConversion.findUniqueOrThrow({ where: { id: a } }))
        .status,
    ).toBe('cancelled');
  });

  it('refuses an amount that is not the rate applied to the points, a reference that is not its own, and a row that is not born held', async () => {
    const who = await person();
    const bad: Array<
      [string, Prisma.PointConversionUncheckedCreateInput, RegExp]
    > = (() => {
      const mk = (over: Partial<Prisma.PointConversionUncheckedCreateInput>) =>
        row(randomUUID(), who, over);
      return [
        [
          'a kobo too many',
          mk({ cashKobo: cashOf(1000) + 1n }),
          /PointConversion_rate_check/,
        ],
        [
          'a kobo too few',
          mk({ cashKobo: cashOf(1000) - 1n }),
          /PointConversion_rate_check/,
        ],
        [
          'no points',
          mk({ points: 0, cashKobo: 0n }),
          /PointConversion_(amounts|rate)_check/,
        ],
        [
          'no rate',
          mk({ per1000PointsKobo: 0n, cashKobo: 0n }),
          /PointConversion_(amounts|rate)_check/,
        ],
        [
          'negative cash',
          mk({ cashKobo: -1n }),
          /PointConversion_(amounts|rate)_check/,
        ],
        [
          'another status word',
          mk({ status: 'done' }),
          /a conversion is made held/,
        ],
        [
          'born paid',
          mk({ status: 'paid', settledAt: new Date(), sentAt: new Date() }),
          /a conversion is made held/,
        ],
        ['born sent', mk({ sentAt: new Date() }), /a conversion is made held/],
        [
          'held with a settled time',
          mk({ settledAt: new Date() }),
          /a conversion is made held/,
        ],
        [
          'a reference that is not its own',
          { ...mk({}), customerReference: 'wawu-pts-someone-else' },
          /PointConversion_reference_check/,
        ],
      ];
    })();
    for (const [what, data, message] of bad) {
      await expect(
        prisma.$transaction((tx) => tx.pointConversion.create({ data })),
      ).rejects.toThrow(message);
      expect(what).toBeTruthy();
    }
    // Rows the checks must also hold for, written through a hold so only the
    // check under test can refuse them.
    const a = await made(who);
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { status: 'done' },
      }),
      /PointConversion_(settled|status)_check/,
    );
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { settledAt: new Date() },
      }),
      /PointConversion_settled_check/,
    );
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { status: 'paid', settledAt: new Date() },
      }),
      /PointConversion_paid_check/,
    );
    await refused(
      prisma.pointConversion.updateMany({
        where: { id: a },
        data: { status: 'cancelled', settledAt: new Date() },
      }),
      /PointConversion_cancelled_check/,
    );
  });
});

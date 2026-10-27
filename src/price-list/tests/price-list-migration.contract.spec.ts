// PRICE-LIST (R-101 point 8): the migration `20261212090000_price_list` moves every paid piece, paid-message price, pass price
// and unsold ticket type that is not on the price list to the nearest list price (the lower on a tie, the top above it), keeps
// the old price in "PriceListMove", is safe to run again, tells each owner once, and its rollback puts the old prices back
// and refuses when a moved price was changed since.
//
// Real database (the caller's DATABASE_URL), no provider and no HTTP. Each check runs inside one transaction that is always
// rolled back, so the database is left as found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { PriceMoveNoticeService } from '../price-move-notice.service';

jest.setTimeout(120_000);

const FOLDER = join(
  __dirname,
  '../../../prisma/migrations/20261212090000_price_list',
);
const script = (file: string) =>
  readFileSync(join(FOLDER, file), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
const MIGRATE = script('migration.sql');
const ROLLBACK = script('rollback.sql');
// The second run is the data part alone: the table already exists by then.
const DATA_PART = MIGRATE.slice(
  MIGRATE.indexOf('-- The list price nearest to p'),
);

describe('PRICE-LIST: the migration, the notices and the rollback', () => {
  let prisma: PrismaService;
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

  const tag = () =>
    `pl_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

  /** Live-shaped rows: the cases the ruling names. Returns the ids by label. */
  async function seed(tx: Tx) {
    const t = tag();
    const owner = `${t}_owner`;
    const piece = (
      label: string,
      price: number,
      status: 'live' | 'pending' | 'removed',
      accessType: 'paid' | 'free' = 'paid',
    ) =>
      tx.contentPiece.create({
        data: {
          slug: `${t}-${label}`,
          creatorWawuId: owner,
          contentType: 'video',
          title: `Piece ${label}`,
          description: 'd',
          category: 'c',
          accessType,
          price,
          status,
          previewAssetUrl: 'x',
        },
      });
    const ids: Record<string, string> = {};
    ids.live1200 = (await piece('a', 1200, 'live')).id;
    ids.tie1250 = (await piece('b', 1250, 'pending')).id;
    ids.above = (await piece('c', 2_000_000, 'live')).id;
    ids.onList = (await piece('d', 2500, 'live')).id;
    ids.free = (await piece('e', 0, 'live', 'free')).id;
    ids.removed = (await piece('f', 1300, 'removed')).id;
    await tx.creatorState.create({
      data: { wawuUserId: owner, dmPrice: 450, dmEnabled: true },
    });
    const dmOnList = `${t}_dm_ok`;
    await tx.creatorState.create({
      data: { wawuUserId: dmOnList, dmPrice: 500 },
    });
    const room = (label: string, priceKobo: bigint) =>
      tx.community.create({
        data: {
          name: `Room ${label}`,
          description: 'd',
          hostWawuId: owner,
          kind: 'private',
          passPrice: { create: { priceKobo } },
        },
      });
    ids.pass3500 = (await room('a', 350_000n)).id;
    ids.passOdd = (await room('b', 300_050n)).id;
    ids.passOk = (await room('c', 500_000n)).id;
    // Judged in kobo, not rounded to naira first (round 3): 175,049 kobo is nearer ₦2,000 (249.51 away) than ₦1,500 (250.49 away);
    // 175,000 is the exact midpoint, which goes lower.
    ids.pass17549 = (await room('d', 175_049n)).id;
    ids.pass1750 = (await room('e', 175_000n)).id;
    const event = await tx.event.create({
      data: {
        hostWawuId: owner,
        name: `Event ${t}`,
        description: 'd',
        hostOrg: 'Org',
        format: 'online',
        type: 'webinar',
        startsAt: new Date(Date.now() + 864e5),
        endsAt: new Date(Date.now() + 2 * 864e5),
        location: 'Online',
        status: 'published',
      } as never,
    });
    const ticket = (label: string, priceNaira: number, extra: object = {}) =>
      tx.eventTicketType.create({
        data: {
          eventId: event.id,
          tier: priceNaira === 0 ? 'free' : 'regular',
          name: label,
          priceNaira,
          quantity: 10,
          ...extra,
        },
      });
    ids.tUnsold = (await ticket('Unsold', 3500)).id;
    ids.tSold = (await ticket('Sold', 3500, { sold: 1 })).id;
    ids.tRetired = (
      await ticket('Retired', 3500, { retiredAt: new Date() })
    ).id;
    ids.tFree = (await ticket('Free', 0)).id;
    return { ids, owner, dmOnList };
  }

  const priceOf = async (tx: Tx, ids: Record<string, string>) => ({
    live1200: (
      await tx.contentPiece.findUniqueOrThrow({ where: { id: ids.live1200 } })
    ).price,
    tie1250: (
      await tx.contentPiece.findUniqueOrThrow({ where: { id: ids.tie1250 } })
    ).price,
    above: (
      await tx.contentPiece.findUniqueOrThrow({ where: { id: ids.above } })
    ).price,
    onList: (
      await tx.contentPiece.findUniqueOrThrow({ where: { id: ids.onList } })
    ).price,
    free: (await tx.contentPiece.findUniqueOrThrow({ where: { id: ids.free } }))
      .price,
    removed: (
      await tx.contentPiece.findUniqueOrThrow({ where: { id: ids.removed } })
    ).price,
    pass3500: (
      await tx.communityPassPrice.findUniqueOrThrow({
        where: { communityId: ids.pass3500 },
      })
    ).priceKobo,
    passOdd: (
      await tx.communityPassPrice.findUniqueOrThrow({
        where: { communityId: ids.passOdd },
      })
    ).priceKobo,
    passOk: (
      await tx.communityPassPrice.findUniqueOrThrow({
        where: { communityId: ids.passOk },
      })
    ).priceKobo,
    pass17549: (
      await tx.communityPassPrice.findUniqueOrThrow({
        where: { communityId: ids.pass17549 },
      })
    ).priceKobo,
    pass1750: (
      await tx.communityPassPrice.findUniqueOrThrow({
        where: { communityId: ids.pass1750 },
      })
    ).priceKobo,
    tUnsold: (
      await tx.eventTicketType.findUniqueOrThrow({ where: { id: ids.tUnsold } })
    ).priceNaira,
    tSold: (
      await tx.eventTicketType.findUniqueOrThrow({ where: { id: ids.tSold } })
    ).priceNaira,
    tRetired: (
      await tx.eventTicketType.findUniqueOrThrow({
        where: { id: ids.tRetired },
      })
    ).priceNaira,
    tFree: (
      await tx.eventTicketType.findUniqueOrThrow({ where: { id: ids.tFree } })
    ).priceNaira,
  });

  const OLD = {
    live1200: 1200,
    tie1250: 1250,
    above: 2_000_000,
    onList: 2500,
    free: 0,
    removed: 1300,
    pass3500: 350_000n,
    passOdd: 300_050n,
    passOk: 500_000n,
    pass17549: 175_049n,
    pass1750: 175_000n,
    tUnsold: 3500,
    tSold: 3500,
    tRetired: 3500,
    tFree: 0,
  };
  const NEW = {
    ...OLD,
    live1200: 1000,
    tie1250: 1000,
    above: 1_000_000,
    pass3500: 300_000n,
    passOdd: 300_000n,
    pass17549: 200_000n,
    pass1750: 150_000n,
    tUnsold: 3000,
  };

  async function migrate(tx: Tx) {
    await tx.$executeRawUnsafe('DROP TABLE IF EXISTS "PriceListMove"');
    await tx.$executeRawUnsafe(MIGRATE);
  }

  it('moves what is off the list, leaves the rest, and keeps every old price', async () => {
    await inRolledBackTx(async (tx) => {
      const { ids, owner } = await seed(tx);
      await migrate(tx);
      expect(await priceOf(tx, ids)).toEqual(NEW);
      const moves = await tx.priceListMove.findMany({
        where: { ownerWawuId: owner },
      });
      // 3 pieces, 1 paid-message price, 4 passes, 1 ticket type. The sold, retired, free and on-list items have no row.
      expect(moves.map((m) => m.kind).sort()).toEqual([
        'community_pass',
        'community_pass',
        'community_pass',
        'community_pass',
        'content',
        'content',
        'content',
        'paid_dm',
        'ticket_type',
      ]);
      const dm = moves.find((m) => m.kind === 'paid_dm')!;
      expect([dm.oldPriceKobo, dm.newPriceKobo]).toEqual([45_000n, 50_000n]);
      const above = moves.find((m) => m.subjectId === ids.above)!;
      expect([above.oldPriceKobo, above.newPriceKobo]).toEqual([
        200_000_000n,
        100_000_000n,
      ]);
      expect(moves.every((m) => m.notifiedAt === null)).toBe(true);
      const dmOk = await tx.creatorState.findFirstOrThrow({
        where: { dmPrice: 500, wawuUserId: { not: owner } },
      });
      expect(dmOk.dmPrice).toBe(500);
      expect(
        (
          await tx.creatorState.findUniqueOrThrow({
            where: { wawuUserId: owner },
          })
        ).dmPrice,
      ).toBe(500);
    });
  });

  it('uses the saved price list setting when one exists', async () => {
    await inRolledBackTx(async (tx) => {
      const { ids } = await seed(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM "PlanSetting" WHERE "key" = 'prices.list_naira'`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "PlanSetting" ("key","value","updatedAt") VALUES ('prices.list_naira', '["1200","2500"]'::jsonb, now())`,
      );
      await migrate(tx);
      // 1200 and 2500 are now on the list; 1250 is nearer 1200 than 2500.
      const p = await priceOf(tx, ids);
      expect([p.live1200, p.tie1250, p.onList, p.above]).toEqual([
        1200, 1200, 2500, 2500,
      ]);
    });
  });

  it('is safe to run again: a second run changes nothing and adds no rows', async () => {
    await inRolledBackTx(async (tx) => {
      const { ids, owner } = await seed(tx);
      await migrate(tx);
      const rows = await tx.priceListMove.count({
        where: { ownerWawuId: owner },
      });
      await tx.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS pg_temp.price_list_nearest(bigint, integer[])',
      );
      await tx.$executeRawUnsafe(DATA_PART);
      expect(await priceOf(tx, ids)).toEqual(NEW);
      expect(
        await tx.priceListMove.count({ where: { ownerWawuId: owner } }),
      ).toBe(rows);
    });
  });

  it('tells each owner once per item, in the house words, and never again', async () => {
    await inRolledBackTx(async (tx) => {
      const { owner } = await seed(tx);
      await migrate(tx);
      const notifications = new NotificationService({} as never);
      const service = new PriceMoveNoticeService(
        {
          priceListMove: tx.priceListMove,
          $transaction: (fn: (t: Tx) => unknown) => fn(tx),
        } as never,
        notifications,
      );
      const before = await tx.notification.count({
        where: { userWawuId: owner, kind: 'price_moved' },
      });
      expect(before).toBe(0);
      expect(await service.sendPending()).toBeGreaterThanOrEqual(9);
      const told = await tx.notification.findMany({
        where: { userWawuId: owner, kind: 'price_moved' },
      });
      expect(told).toHaveLength(9);
      expect(told.map((n) => n.body)).toEqual(
        expect.arrayContaining([
          'The price of Piece a is now ₦1,000, the nearest on the price list.',
          'The price of Piece c is now ₦1,000,000, the nearest on the price list.',
          'The price of paid messages is now ₦500, the nearest on the price list.',
          'The price of Room a is now ₦3,000, the nearest on the price list.',
        ]),
      );
      expect(told.every((n) => !/[–—]/.test(n.title + n.body))).toBe(true);
      expect(await service.sendPending()).toBe(0);
      expect(
        await tx.notification.count({
          where: { userWawuId: owner, kind: 'price_moved' },
        }),
      ).toBe(9);
    });
  });

  it('the rollback puts every old price back and drops the audit table', async () => {
    await inRolledBackTx(async (tx) => {
      const { ids } = await seed(tx);
      await migrate(tx);
      await tx.$executeRawUnsafe(ROLLBACK);
      expect(await priceOf(tx, ids)).toEqual(OLD);
      const gone = await tx.$queryRawUnsafe<{ t: string | null }[]>(
        `SELECT to_regclass('"PriceListMove"')::text AS t`,
      );
      expect(gone[0].t).toBeNull();
    });
  });

  it('the rollback refuses, and changes nothing, when a moved price was changed since', async () => {
    await inRolledBackTx(async (tx) => {
      const { ids } = await seed(tx);
      await migrate(tx);
      await tx.contentPiece.update({
        where: { id: ids.live1200 },
        data: { price: 1500 },
      });
      await tx.$executeRawUnsafe('SAVEPOINT before_rollback');
      await expect(tx.$executeRawUnsafe(ROLLBACK)).rejects.toThrow(
        /changed or locked since/,
      );
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT before_rollback');
      const p = await priceOf(tx, ids);
      expect(p.live1200).toBe(1500);
      expect(p.tie1250).toBe(1000);
      expect(
        await tx.priceListMove.count({ where: { subjectId: ids.tie1250 } }),
      ).toBe(1);
    });
  });
});

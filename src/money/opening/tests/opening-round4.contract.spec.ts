import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MoneyError } from '../../money-error';
import { EXPIRED_IDLE, EXPIRED_LIFETIME, EXPIRED_STATE } from '../bvn-claim';
import {
  expireIdleOpenings,
  HOLD_SWEEP_BATCH,
  type SweepCursor,
} from '../identity-hold';
import {
  OPENING_ATTEMPT_OUTCOME,
  OPENING_PLACE_OUTCOME,
  OpeningAttempts,
  PLACE_IN_FLIGHT_MS,
} from '../opening-attempts';

/**
 * NUV-02 round 4, N12 and N15 at the level of the parts, against a real
 * database. A second PrismaService is a second server: its own connection
 * pool, the same database, so what orders two requests here is what orders
 * two servers in production (the advisory lock in the database, not
 * anything in this process).
 */

jest.setTimeout(120_000);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('NUV-02 round 4: the address limit is one atomic step (N12), the sweep walks every due row (N15)', () => {
  let one: PrismaService;
  let two: PrismaService;
  const users: string[] = [];
  const keys: string[] = [];

  const newUser = () => {
    const id = randomUUID();
    users.push(id);
    return id;
  };
  const newKey = () => {
    const k = randomBytes(16).toString('hex');
    keys.push(k);
    return k;
  };
  const codeOf = (e: unknown) => (e instanceof MoneyError ? e.code : null);

  beforeAll(async () => {
    one = new PrismaService();
    two = new PrismaService();
    await one.$connect();
    await two.$connect();
  });

  afterAll(async () => {
    const where = { wawuUserId: { in: users } };
    await one.bvnCheckAttempt.deleteMany({
      where: { OR: [where, { addressKey: { in: keys } }] },
    });
    await one.nuvionEntity.deleteMany({ where });
    await one.fintavaWalletOpening.deleteMany({ where });
    await one.$disconnect();
    await two.$disconnect();
  });

  describe('N12: the place', () => {
    it('25 places asked for at once on two servers sharing a database, the limit 10: exactly 10 are given and 15 are open_address_limited', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const b = new OpeningAttempts(two, 3, 10);
      const key = newKey();
      const ids = Array.from({ length: 25 }, newUser);
      const results = await Promise.allSettled(
        ids.map((id, k) => (k % 2 === 0 ? a : b).reservePlace(id, key)),
      );
      const given = results.filter(
        (r) => r.status === 'fulfilled' && r.value.place !== null,
      );
      const refused = results.filter(
        (r) =>
          r.status === 'rejected' &&
          codeOf(r.reason) === 'open_address_limited',
      );
      expect(given).toHaveLength(10);
      expect(refused).toHaveLength(15);
      expect(
        await one.bvnCheckAttempt.count({
          where: { addressKey: key, outcome: OPENING_PLACE_OUTCOME },
        }),
      ).toBe(10);
      // The next one, from either server, is limited.
      await expect(a.reservePlace(newUser(), key)).rejects.toMatchObject({
        code: 'open_address_limited',
      });
      await expect(b.reservePlace(newUser(), key)).rejects.toMatchObject({
        code: 'open_address_limited',
      });
    });

    it('the same on one server, and again with the limit 1 (the last place is never seen free twice)', async () => {
      for (const limit of [10, 1]) {
        const a = new OpeningAttempts(one, 3, limit);
        const key = newKey();
        const results = await Promise.allSettled(
          Array.from({ length: 25 }, () => a.reservePlace(newUser(), key)),
        );
        expect(
          results.filter(
            (r) => r.status === 'fulfilled' && r.value.place !== null,
          ),
        ).toHaveLength(limit);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(
          25 - limit,
        );
      }
    });

    it('a place is the try once it is spent, and the person’s day counts it only then', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const key = newKey();
      const id = newUser();
      const { place } = await a.reservePlace(id, key);
      expect(place).not.toBeNull();
      const day = () =>
        one.bvnCheckAttempt.count({
          where: { wawuUserId: id, outcome: { not: OPENING_PLACE_OUTCOME } },
        });
      expect(await day()).toBe(0);
      await a.spend(id, false, place);
      expect(await day()).toBe(1);
      expect(
        await one.bvnCheckAttempt.findUnique({ where: { id: place!.id } }),
      ).toMatchObject({ outcome: OPENING_ATTEMPT_OUTCOME, addressKey: key });
    });

    it('a place spent with refuseOver is taken back out when it is over the day’s tries (KYC-01’s reserveDailyAttempt), and the 429 is the day’s', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const key = newKey();
      const id = newUser();
      for (let i = 0; i < 3; i += 1) {
        const { place } = await a.reservePlace(id, key);
        await a.spend(id, true, place);
      }
      // The place of a fourth try on another address: over the day.
      const other = newKey();
      const { place } = await a.reservePlace(id, other);
      await expect(a.spend(id, true, place)).rejects.toMatchObject({
        code: 'identity_checks_exhausted',
      });
      expect(
        await one.bvnCheckAttempt.count({ where: { addressKey: other } }),
      ).toBe(0);
    });

    it('the person’s day counts the tries made, not the places held: three places held on an address leave the day untouched, three tries use it up', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const id = newUser();
      const key = newKey();
      for (let i = 0; i < 3; i += 1) {
        await one.bvnCheckAttempt.create({
          data: {
            wawuUserId: id,
            addressKey: key,
            outcome: OPENING_PLACE_OUTCOME,
          },
        });
      }
      await expect(a.assertLeft(id, null)).resolves.toBeUndefined();
      expect(await a.opensAgainAt(id, null)).toBeNull();
      await one.bvnCheckAttempt.updateMany({
        where: { wawuUserId: id },
        data: { outcome: OPENING_ATTEMPT_OUTCOME },
      });
      await expect(a.assertLeft(id, null)).rejects.toMatchObject({
        code: 'identity_checks_exhausted',
      });
      expect(await a.opensAgainAt(id, null)).toBeInstanceOf(Date);
    });

    it('ten requests of one account at once take one place; the other nine are concurrent', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const key = newKey();
      const id = newUser();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, k) =>
          (k % 2 === 0 ? a : new OpeningAttempts(two, 3, 10)).reservePlace(
            id,
            key,
          ),
        ),
      );
      expect(results.filter((r) => r.place !== null)).toHaveLength(1);
      expect(results.filter((r) => r.concurrent)).toHaveLength(9);
      expect(
        await one.bvnCheckAttempt.count({ where: { addressKey: key } }),
      ).toBe(1);
    });

    it('R4-3: a place the same account holds on another address is no sign of a double tap: the request is let through, and the other place is untouched', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const keyA = newKey();
      const keyB = newKey();
      const id = newUser();
      const first = await a.reservePlace(id, keyA);
      expect(first.place).not.toBeNull();
      // Inside the minute, from another address: not concurrent, its own place.
      const second = await a.reservePlace(id, keyB);
      expect(second.concurrent).toBe(false);
      expect(second.place).not.toBeNull();
      expect(second.place!.id).not.toBe(first.place!.id);
      const rows = await one.bvnCheckAttempt.findMany({
        where: { wawuUserId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => [r.addressKey, r.outcome])).toEqual([
        [keyA, OPENING_PLACE_OUTCOME],
        [keyB, OPENING_PLACE_OUTCOME],
      ]);
      // The double tap is still the double tap, on either address.
      expect((await a.reservePlace(id, keyA)).concurrent).toBe(true);
      expect((await a.reservePlace(id, keyB)).concurrent).toBe(true);
    });

    it('R4-3: another account\u2019s fresh place on the address is no double tap either', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const key = newKey();
      expect((await a.reservePlace(newUser(), key)).place).not.toBeNull();
      const other = await a.reservePlace(newUser(), key);
      expect(other.concurrent).toBe(false);
      expect(other.place).not.toBeNull();
    });

    it('a place older than a request can last is no sign of a request in flight, but it still counts against the address', async () => {
      const a = new OpeningAttempts(one, 3, 2);
      const key = newKey();
      const id = newUser();
      await one.bvnCheckAttempt.create({
        data: {
          wawuUserId: id,
          addressKey: key,
          outcome: OPENING_PLACE_OUTCOME,
          createdAt: new Date(Date.now() - 2 * PLACE_IN_FLIGHT_MS),
        },
      });
      const { place, concurrent } = await a.reservePlace(id, key);
      expect(concurrent).toBe(false);
      expect(place).not.toBeNull();
      // Two places now stand against the address: the limit is 2.
      await expect(a.reservePlace(newUser(), key)).rejects.toMatchObject({
        code: 'open_address_limited',
      });
    });

    it('rows older than the hour do not count, the retry time is when the oldest frees, and no place is written over the limit', async () => {
      const a = new OpeningAttempts(one, 3, 2);
      const key = newKey();
      await one.bvnCheckAttempt.createMany({
        data: [
          {
            wawuUserId: newUser(),
            addressKey: key,
            outcome: OPENING_ATTEMPT_OUTCOME,
            createdAt: new Date(Date.now() - HOUR - 60_000),
          },
          {
            wawuUserId: newUser(),
            addressKey: key,
            outcome: OPENING_ATTEMPT_OUTCOME,
            createdAt: new Date(Date.now() - 40 * 60_000),
          },
          {
            wawuUserId: newUser(),
            addressKey: key,
            outcome: OPENING_ATTEMPT_OUTCOME,
            createdAt: new Date(Date.now() - 10 * 60_000),
          },
        ],
      });
      const before = await one.bvnCheckAttempt.count({
        where: { addressKey: key },
      });
      const err = await a.reservePlace(newUser(), key).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('open_address_limited');
      const wait = (
        (err as MoneyError).getResponse() as {
          reason: { retryAfterSeconds: number };
        }
      ).reason.retryAfterSeconds;
      // The oldest counted row is 40 minutes old: it frees in about 20.
      expect(wait).toBeGreaterThan(19 * 60);
      expect(wait).toBeLessThanOrEqual(20 * 60 + 5);
      expect(
        await one.bvnCheckAttempt.count({ where: { addressKey: key } }),
      ).toBe(before);
    });

    it('a request with no client address takes no place and writes nothing', async () => {
      const a = new OpeningAttempts(one, 3, 1);
      const id = newUser();
      expect(await a.reservePlace(id, null)).toEqual({
        place: null,
        concurrent: false,
      });
      await a.spend(id, false, null);
      expect(
        await one.bvnCheckAttempt.findMany({ where: { wawuUserId: id } }),
      ).toEqual([
        expect.objectContaining({
          outcome: OPENING_ATTEMPT_OUTCOME,
          addressKey: null,
        }),
      ]);
    });

    it('giving a place back removes only that place, and giving it twice, or giving none, is harmless', async () => {
      const a = new OpeningAttempts(one, 3, 10);
      const key = newKey();
      const { place: p1 } = await a.reservePlace(newUser(), key);
      const { place: p2 } = await a.reservePlace(newUser(), key);
      await a.give(p1);
      await a.give(p1);
      await a.give(null);
      expect(
        await one.bvnCheckAttempt.findMany({ where: { addressKey: key } }),
      ).toEqual([expect.objectContaining({ id: p2!.id })]);
    });
  });

  describe('N15: the sweep', () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
    /** `count` openings and their entities, written in two statements. */
    async function plantMany(
      count: number,
      startedAt: Date,
      entity: {
        status: string;
        documentStatus?: string;
        decidedAgoDays?: number;
      },
    ): Promise<string[]> {
      const ids = Array.from({ length: count }, newUser);
      await one.fintavaWalletOpening.createMany({
        data: ids.map((id, k) => ({
          wawuUserId: id,
          state: 'review',
          bvnHash: `planted-${id}`,
          bvnVerifiedAt: startedAt,
          phone: `+23481${String(randomInt(10_000_000, 99_999_999))}${k}`,
          attemptStartedAt: startedAt,
          provider: 'nuvion',
        })),
      });
      await one.nuvionEntity.createMany({
        data: ids.map((id) => ({
          wawuUserId: id,
          entityId: `01ENT${id.replace(/-/g, '').toUpperCase()}`.slice(0, 26),
          status: entity.status,
          documentStatus: entity.documentStatus ?? null,
          decidedAt:
            entity.decidedAgoDays === undefined
              ? null
              : daysAgo(entity.decidedAgoDays),
        })),
      });
      return ids;
    }
    const stateOf = async (ids: string[]) =>
      (
        await one.fintavaWalletOpening.findMany({
          where: { wawuUserId: { in: ids } },
          select: { state: true },
        })
      ).map((r) => r.state);
    const pass = (opts: { after?: SweepCursor | null; budgetMs?: number }) =>
      one.$transaction((tx) => expireIdleOpenings(tx, 14, new Date(), opts), {
        timeout: 60_000,
      });

    it('a pass that is out of time hands back where it stopped, and the next pass starts there: 305 openings it cannot expire in front of a due one are walked a page at a time', async () => {
      const ambiguous = await plantMany(305, daysAgo(60), {
        status: 'rejected',
        documentStatus: 'rejected',
        decidedAgoDays: 1,
      });
      const [due] = await plantMany(1, daysAgo(30), { status: 'incomplete' });
      let after: SweepCursor | null = null;
      let passes = 0;
      const told: string[] = [];
      do {
        const out = await pass({ after, budgetMs: 0 });
        passes += 1;
        told.push(...out.told);
        after = out.resumeAfter;
        if (passes === 1) {
          // One page was read and the pass stopped with a place to resume from.
          expect(after).not.toBeNull();
          expect(out.told).toEqual([]);
        }
      } while (after !== null && passes < 20);
      // 306 candidates in pages of 100: four passes, the last reading to the end.
      expect(passes).toBeGreaterThanOrEqual(Math.ceil(306 / HOLD_SWEEP_BATCH));
      expect(after).toBeNull();
      expect(told).toEqual([due]);
      expect(await stateOf([due])).toEqual([EXPIRED_STATE]);
      expect((await stateOf(ambiguous)).every((s) => s === 'review')).toBe(
        true,
      );
    });

    it('a pass with its time not used reads to the end in one go, with no cap on the rows it looks at', async () => {
      await plantMany(230, daysAgo(61), {
        status: 'rejected',
        documentStatus: 'rejected',
        decidedAgoDays: 1,
      });
      const [due] = await plantMany(1, daysAgo(30), { status: 'incomplete' });
      const out = await pass({});
      expect(out.resumeAfter).toBeNull();
      expect(out.told).toContain(due);
    });

    it('250 due openings at one instant are all expired across passes of one page: the cursor never skips one that shares its instant', async () => {
      const ids = await plantMany(250, daysAgo(25), { status: 'incomplete' });
      let after: SweepCursor | null = null;
      const told = new Set<string>();
      let passes = 0;
      do {
        const out = await pass({ after, budgetMs: 0 });
        passes += 1;
        for (const id of out.told) told.add(id);
        after = out.resumeAfter;
      } while (after !== null && passes < 20);
      for (const id of ids) expect(told.has(id)).toBe(true);
      expect((await stateOf(ids)).every((s) => s === EXPIRED_STATE)).toBe(true);
    });
  });

  describe('NUV-03 round 4, R4-2: the sweep releases a hold that has outlived its lifetime, whatever the person did', () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
    interface Planted {
      claimDays: number;
      /** Days since the person last did anything (the idle rule's clock). */
      workedDays: number;
      entity?: { status: string; bvnStatus?: string; documentStatus?: string };
    }
    async function plantHolds(count: number, o: Planted): Promise<string[]> {
      const ids = Array.from({ length: count }, newUser);
      await one.fintavaWalletOpening.createMany({
        data: ids.map((id, k) => ({
          wawuUserId: id,
          state: 'review',
          bvnHash: `planted-${id}`,
          bvnVerifiedAt: daysAgo(o.claimDays),
          phone: `+23481${String(randomInt(10_000_000, 99_999_999))}${k}`,
          attemptStartedAt: daysAgo(o.workedDays),
          provider: 'nuvion',
        })),
      });
      await one.nuvionEntity.createMany({
        data: ids.map((id) => ({
          wawuUserId: id,
          entityId: `01ENT${id.replace(/-/g, '').toUpperCase()}`.slice(0, 26),
          status: o.entity?.status ?? 'incomplete',
          bvnStatus: o.entity?.bvnStatus ?? null,
          documentStatus: o.entity?.documentStatus ?? null,
          decidedAt:
            o.entity?.status === 'rejected' ? daysAgo(o.workedDays) : null,
          progressAt: daysAgo(o.workedDays),
        })),
      });
      return ids;
    }
    const rowsOf = (ids: string[]) =>
      one.fintavaWalletOpening.findMany({
        where: { wawuUserId: { in: ids } },
        select: { wawuUserId: true, state: true, failure: true, bvnHash: true },
      });
    const pass = (
      lifetimeDays: number | null | undefined,
      opts: { after?: SweepCursor | null; budgetMs?: number } = {},
    ) =>
      one.$transaction(
        (tx) =>
          expireIdleOpenings(tx, 14, new Date(), { ...opts, lifetimeDays }),
        { timeout: 60_000 },
      );

    it('a claim older than the lifetime is released whatever was done an hour ago; a younger one, and the idle rule alone, are as they were', async () => {
      const [old] = await plantHolds(1, { claimDays: 31, workedDays: 0.04 });
      const [young] = await plantHolds(1, { claimDays: 29, workedDays: 0.04 });
      const [idle] = await plantHolds(1, { claimDays: 20, workedDays: 15 });
      const out = await pass(30);
      expect(out.told).toContain(old);
      expect(out.told).toContain(idle);
      expect(out.told).not.toContain(young);
      const rows = new Map(
        (await rowsOf([old, young, idle])).map((r) => [r.wawuUserId, r]),
      );
      expect(rows.get(old)).toMatchObject({
        state: EXPIRED_STATE,
        failure: EXPIRED_LIFETIME,
      });
      expect(rows.get(old)!.bvnHash).toMatch(/^released:/);
      expect(rows.get(idle)).toMatchObject({
        state: EXPIRED_STATE,
        failure: EXPIRED_IDLE,
      });
      expect(rows.get(young)).toMatchObject({ state: 'review', failure: null });
    });

    it('left out or null, no lifetime applies: only the idle rule releases', async () => {
      const [old] = await plantHolds(1, { claimDays: 400, workedDays: 0.04 });
      expect((await pass(undefined)).told).not.toContain(old);
      expect((await pass(null)).told).not.toContain(old);
      expect((await rowsOf([old]))[0].state).toBe('review');
      expect((await pass(30)).told).toContain(old);
    });

    it('both due: it is the idle rule that releases it', async () => {
      const [both] = await plantHolds(1, { claimDays: 40, workedDays: 20 });
      await pass(30);
      expect((await rowsOf([both]))[0]).toMatchObject({
        state: EXPIRED_STATE,
        failure: EXPIRED_IDLE,
      });
    });

    it('the edge is the lifetime to the second: an hour over is released, an hour under is not', async () => {
      const [over] = await plantHolds(1, {
        claimDays: 30 + 1 / 24,
        workedDays: 0.04,
      });
      const [under] = await plantHolds(1, {
        claimDays: 30 - 1 / 24,
        workedDays: 0.04,
      });
      const out = await pass(30);
      expect(out.told).toContain(over);
      expect(out.told).not.toContain(under);
    });

    it('only a hold that can be released is released: a refusal on the BVN holds nothing, one on the documents still does; being checked or approved never', async () => {
      const [bvn] = await plantHolds(1, {
        claimDays: 90,
        workedDays: 0.04,
        entity: { status: 'rejected', bvnStatus: 'rejected' },
      });
      const [docs] = await plantHolds(1, {
        claimDays: 90,
        workedDays: 0.04,
        entity: { status: 'rejected', documentStatus: 'rejected' },
      });
      const [checking] = await plantHolds(1, {
        claimDays: 90,
        workedDays: 0.04,
        entity: { status: 'pending' },
      });
      const [approved] = await plantHolds(1, {
        claimDays: 90,
        workedDays: 0.04,
        entity: { status: 'approved' },
      });
      const out = await pass(30);
      expect(out.told).toContain(docs);
      for (const id of [bvn, checking, approved]) {
        expect(out.told).not.toContain(id);
      }
    });

    it('250 holds past their lifetime at one instant are all released across passes of one page: the cursor skips none', async () => {
      const ids = await plantHolds(250, { claimDays: 45, workedDays: 0.04 });
      let after: SweepCursor | null = null;
      const told = new Set<string>();
      let passes = 0;
      do {
        const out = await pass(30, { after, budgetMs: 0 });
        passes += 1;
        for (const id of out.told) told.add(id);
        after = out.resumeAfter;
      } while (after !== null && passes < 20);
      for (const id of ids) expect(told.has(id)).toBe(true);
      expect(
        (await rowsOf(ids)).every((r) => r.failure === EXPIRED_LIFETIME),
      ).toBe(true);
    });
  });
});

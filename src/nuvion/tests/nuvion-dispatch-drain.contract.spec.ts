import { createHash, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NuvionHandlerRegistry } from '../handlers/nuvion-handler-registry';
import type {
  NuvionDelivery,
  NuvionHandlerResult,
} from '../handlers/nuvion-handler.interface';
import {
  NUVION_DISPATCH,
  NuvionWebhookDispatcher,
} from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * FIX-86 (SWEEP-MONEY FIX-80 N3): one tick of the dispatcher drains what is
 * due instead of taking 20 stored deliveries per 30 seconds (40 a minute,
 * about ten minutes for 400 people paid at once). On a real database, with
 * stored rows only (no Nuvion call); each test owns an event name nothing
 * else handles, and the registry lists only that name, so no other row in
 * the database is touched.
 *
 * Proved here: 400 due deliveries are all handled in one sweep, oldest
 * first, within the budget; a budget hit stops cleanly and the next tick
 * continues in order; a handler that waits or throws is not taken again in
 * the same sweep; two servers never run one delivery's handlers twice.
 */

jest.setTimeout(120_000);

const RUN = `fix86-${randomUUID().slice(0, 8)}`;
let n = 0;

describe('FIX-86: one sweep drains what is due', () => {
  let guard: OutboundGuard;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let registry: NuvionHandlerRegistry;
  let dispatcher: NuvionWebhookDispatcher;
  let event: string;
  let ids: string[];
  let calls: Map<string, number>;
  let order: string[];
  let behave: (
    d: NuvionDelivery,
    index: number,
  ) => Promise<NuvionHandlerResult>;

  beforeAll(async () => {
    guard = guardOutbound();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        NuvionWebhookModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    registry = moduleRef.get(NuvionHandlerRegistry);
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);
  });

  afterAll(async () => {
    await prisma.nuvionWebhookEvent.deleteMany({
      where: { eventId: { startsWith: RUN } },
    });
    await moduleRef.close();
    guard.restore();
  });

  /** A fresh event name, a handler for it, and the sweep limited to it. */
  function freshEvent() {
    n += 1;
    event = `spec.drain_${RUN}_${n}`;
    ids = [];
    calls = new Map();
    order = [];
    behave = () => Promise.resolve({ outcome: 'done', note: 'ok' });
    registry.add({
      task: 'SPEC',
      events: [event],
      handle: async (d) => {
        calls.set(d.id, (calls.get(d.id) ?? 0) + 1);
        order.push(d.id);
        return behave(d, ids.indexOf(d.id));
      },
    });
    jest.spyOn(registry, 'events').mockReturnValue([event]);
  }

  /** `count` due rows, received one millisecond apart, oldest first. */
  async function store(count: number) {
    const first = Date.now() - 3_600_000;
    await prisma.nuvionWebhookEvent.createMany({
      data: Array.from({ length: count }, (_, i) => {
        const body = JSON.stringify({
          event,
          data: { id: `${RUN}-${n}-${i}` },
        });
        return {
          eventId: `${RUN}-${n}-${i}`,
          event,
          signedAt: new Date(first + i).toISOString(),
          bodySha256: createHash('sha256').update(body).digest('hex'),
          rawBody: new Uint8Array(Buffer.from(body)),
          payload: JSON.parse(body) as object,
          receivedAt: new Date(first + i),
        };
      }),
    });
    ids = (
      await prisma.nuvionWebhookEvent.findMany({
        where: { event },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    ).map((r) => r.id);
  }

  const statusCount = (status: 'pending' | 'processed' | 'failed') =>
    prisma.nuvionWebhookEvent.count({
      where: { event, processingStatus: status },
    });

  beforeEach(freshEvent);
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('400 due deliveries are all handled in one sweep, oldest first, within the budget', async () => {
    await store(400);
    const started = Date.now();
    const counts = await dispatcher.sweep();
    expect(Date.now() - started).toBeLessThan(NUVION_DISPATCH.budgetMs);
    expect(counts).toEqual({
      processed: 400,
      failed: 0,
      waiting: 0,
      skipped: 0,
    });
    expect(order).toEqual(ids);
    expect(await statusCount('processed')).toBe(400);
    expect(await statusCount('pending')).toBe(0);
    // The second tick finds nothing and takes nothing.
    expect((await dispatcher.sweep()).processed).toBe(0);
    expect(order).toHaveLength(400);
  });

  it('a budget hit stops cleanly, and the next tick continues in order', async () => {
    await store(100);
    // Each handled delivery "costs" a fortieth of the budget: two batches of
    // 20 spend it, so a sweep takes 40 and stops between batches.
    const realNow = Date.now;
    let skew = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    behave = () => {
      skew += NUVION_DISPATCH.budgetMs / 40;
      return Promise.resolve({ outcome: 'done', note: 'ok' });
    };

    skew = 0;
    expect((await dispatcher.sweep()).processed).toBe(40);
    expect(order).toEqual(ids.slice(0, 40));
    // Clean: nothing half done, nothing still held, the rest untouched.
    expect(
      await prisma.nuvionWebhookEvent.count({
        where: { event, claimedUntil: { not: null } },
      }),
    ).toBe(0);
    expect(
      await prisma.nuvionWebhookEvent.count({
        where: { event, processingStatus: 'pending', attempts: 0 },
      }),
    ).toBe(60);

    skew = 0;
    expect((await dispatcher.sweep()).processed).toBe(40);
    expect(order).toEqual(ids.slice(0, 80));
    skew = 0;
    expect((await dispatcher.sweep()).processed).toBe(20);
    expect(order).toEqual(ids);
    expect([...calls.values()].every((c) => c === 1)).toBe(true);
    expect(await statusCount('processed')).toBe(100);
  });

  it('a handler that waits or throws is not taken again in the same sweep', async () => {
    await store(60);
    // Worst case for a loop: whatever waited is made due again by someone
    // else (another server's rest, a clock that is behind) while the sweep
    // is still running. Row k+1's handler frees row k, so a sweep that
    // asked the database again for "what is due" would take row k twice.
    behave = async (_d, i) => {
      if (i > 0) {
        await prisma.nuvionWebhookEvent.update({
          where: { id: ids[i - 1] },
          data: { nextAttemptAt: null, claimedUntil: null },
        });
      }
      if (i % 3 === 0) return { outcome: 'wait', note: 'not yet' };
      if (i % 3 === 1) throw new TypeError('boom');
      return { outcome: 'done', note: 'ok' };
    };
    const counts = await dispatcher.sweep();
    expect(counts).toEqual({
      processed: 20,
      failed: 0,
      waiting: 40,
      skipped: 0,
    });
    expect(calls.size).toBe(60);
    expect([...calls.values()].every((c) => c === 1)).toBe(true);
    expect(order).toEqual(ids);
  });

  it('a delivery another server holds is left to it, and the rest are still drained', async () => {
    await store(50);
    await prisma.nuvionWebhookEvent.update({
      where: { id: ids[10] },
      data: { claimedUntil: new Date(Date.now() + 5 * 60_000) },
    });
    const counts = await dispatcher.sweep();
    expect(counts.processed).toBe(49);
    expect(calls.has(ids[10])).toBe(false);
    expect(await statusCount('pending')).toBe(1);
  });

  it("two servers at once never run one delivery's handlers twice", async () => {
    await store(200);
    behave = async () => {
      await new Promise((r) => setImmediate(r));
      return { outcome: 'done', note: 'ok' };
    };
    const second = new NuvionWebhookDispatcher(prisma, registry);
    const [a, b] = await Promise.all([dispatcher.sweep(), second.sweep()]);
    expect(a.processed + b.processed).toBe(200);
    expect(calls.size).toBe(200);
    expect([...calls.values()].every((c) => c === 1)).toBe(true);
    expect(await statusCount('processed')).toBe(200);
    expect(
      await prisma.nuvionWebhookEvent.count({
        where: { event, attempts: { not: 1 } },
      }),
    ).toBe(0);
  });

  it('no connection left this machine', () => {
    expect(guard.violations).toEqual([]);
  });
});

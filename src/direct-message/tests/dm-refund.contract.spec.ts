// Run against wawu_hub_test — same precedent as direct-message.contract.spec.ts.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationModule } from '../../notification/notification.module';
import { NotificationService } from '../../notification/notification.service';
import { DmRefundService, MAX_REFUND_ATTEMPTS } from '../dm-refund.service';
import { FLUTTERWAVE_CLIENT } from '../flutterwave-client.interface';
import {
  MockFlutterwaveAdapter,
  MOCK_REFUND_PENDING_TRANSACTION_ID,
  MOCK_REFUND_PERMANENT_TRANSACTION_ID,
  MOCK_REFUND_RETRYABLE_TRANSACTION_ID,
} from '../mock-flutterwave.adapter';

const SENDER = '00000000-0000-4000-8000-000000000001';
const CREATOR = '00000000-0000-4000-8000-000000000003';

/**
 * The refund path, which is the part of paid messaging that handles money
 * LEAVING the platform. Every test here corresponds to a way the previous
 * implementation was wrong, or a way this one could become wrong:
 *
 *  - it told the payer they were refunded when nothing had moved
 *  - it had no concept of a refund that Flutterwave accepts but has not paid
 *  - it had nowhere to put a refund that cannot be sent at all
 *  - and a naive fix would refund twice, which is the one mistake here with
 *    real money attached
 */
describe('Paid DM refunds (contract)', () => {
  let prisma: PrismaService;
  let refunds: DmRefundService;
  let notifications: NotificationService;
  let emitted: Array<{ kind: string; userWawuId: string; amount?: number }>;
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;
  const created: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        NotificationModule,
      ],
      providers: [
        DmRefundService,
        MockFlutterwaveAdapter,
        { provide: FLUTTERWAVE_CLIENT, useExisting: MockFlutterwaveAdapter },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    refunds = moduleRef.get(DmRefundService);
    notifications = moduleRef.get(NotificationService);
  }, 40000);

  beforeEach(() => {
    emitted = [];
    jest.spyOn(notifications, 'emit').mockImplementation((event: never) => {
      emitted.push(event);
      return Promise.resolve();
    });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.directMessage.deleteMany({ where: { id: { in: created } } });
    }
    await moduleRef?.close();
  });

  /** An expired DM already flipped by the sweep, owing `amount` back. */
  async function owedDm(txId: string | null, overrides = {}) {
    const id = crypto.randomUUID();
    created.push(id);
    await prisma.directMessage.create({
      data: {
        id,
        creatorWawuId: CREATOR,
        senderWawuId: SENDER,
        text: 'refund path fixture',
        amount: 300,
        status: 'refunded',
        refundStatus: 'owed',
        sentAt: new Date(Date.now() - 48 * 3600_000),
        deadlineAt: new Date(Date.now() - 24 * 3600_000),
        flutterwaveTxRef: `test-refund-${id}`,
        flutterwaveTxId: txId,
        responseWindowHours: 24,
        ...overrides,
      },
    });
    return id;
  }

  const read = (id: string) =>
    prisma.directMessage.findUniqueOrThrow({ where: { id } });

  // ---------------------------------------------------------------------
  it('settles the refund and only then tells the payer', async () => {
    const id = await owedDm('flw-tx-happy');

    await refunds.processOwedRefunds();

    const dm = await read(id);
    expect(dm.refundStatus).toBe('settled');
    expect(dm.refundedAt).not.toBeNull();
    expect(dm.refundReference).toMatch(/^mock-refund-/);
    expect(dm.refundError).toBeNull();
    expect(dm.refundLockedAt).toBeNull();

    expect(emitted).toEqual([
      { kind: 'dm_refunded', userWawuId: SENDER, amount: 300 },
    ]);
  });

  // ---------------------------------------------------------------------
  it('does NOT tell the payer while the refund is only submitted', async () => {
    // The original bug, in its subtler form. Flutterwave answering 200 is
    // not the money arriving, and announcing it here is the same lie the
    // old sweep told, just later in the flow.
    const id = await owedDm(MOCK_REFUND_PENDING_TRANSACTION_ID);

    await refunds.processOwedRefunds();

    const dm = await read(id);
    expect(dm.refundStatus).toBe('submitted');
    expect(dm.refundedAt).toBeNull();
    expect(dm.refundReference).not.toBeNull();
    expect(emitted).toEqual([]);
  });

  // ---------------------------------------------------------------------
  it('settles a submitted refund from the webhook, and notifies exactly once', async () => {
    const id = await owedDm(MOCK_REFUND_PENDING_TRANSACTION_ID);
    await refunds.processOwedRefunds();
    expect(emitted).toEqual([]);

    const reference = (await read(id)).refundReference as string;

    const first = await refunds.settleFromWebhook(reference);
    expect(first).toBe(true);
    expect((await read(id)).refundStatus).toBe('settled');
    expect(emitted).toHaveLength(1);

    // Flutterwave redelivers. The payer must not be told twice, and the
    // settled row must not be rewritten.
    const second = await refunds.settleFromWebhook(reference);
    expect(second).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  it('sends a refund exactly once even when two workers run concurrently', async () => {
    // The claim is a conditional write, so this is the test that would fail
    // if anyone replaced it with read-then-write. A double refund is real
    // money out of the door.
    const id = await owedDm('flw-tx-race');
    const adapter = (
      refunds as unknown as { flutterwave: MockFlutterwaveAdapter }
    ).flutterwave;
    const spy = jest.spyOn(adapter, 'refundCharge');

    await Promise.all([
      refunds.processOwedRefunds(),
      refunds.processOwedRefunds(),
    ]);

    const callsForThisDm = spy.mock.calls.filter(
      ([p]) => p.transactionId === 'flw-tx-race',
    );
    expect(callsForThisDm).toHaveLength(1);
    expect((await read(id)).refundStatus).toBe('settled');
    expect(emitted.filter((e) => e.kind === 'dm_refunded')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  it('retries a retryable failure, then gives up to a human', async () => {
    const id = await owedDm(MOCK_REFUND_RETRYABLE_TRANSACTION_ID);

    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i += 1) {
      await refunds.processOwedRefunds();
    }

    const dm = await read(id);
    expect(dm.refundAttempts).toBe(MAX_REFUND_ATTEMPTS);
    expect(dm.refundStatus).toBe('failed');
    expect(dm.refundError).toContain('temporarily unavailable');
    // Never announced — the payer does not have their money.
    expect(emitted).toEqual([]);
  });

  // ---------------------------------------------------------------------
  it('escalates a permanent refusal immediately instead of looping', async () => {
    const id = await owedDm(MOCK_REFUND_PERMANENT_TRANSACTION_ID);

    await refunds.processOwedRefunds();

    const dm = await read(id);
    expect(dm.refundStatus).toBe('failed');
    expect(dm.refundError).toContain('already been refunded');
    // One pass was enough; it is not left to burn four more attempts on an
    // answer that will not change.
    expect(dm.refundAttempts).toBe(MAX_REFUND_ATTEMPTS);
    expect(emitted).toEqual([]);
  });

  // ---------------------------------------------------------------------
  it('escalates a payment with no captured transaction id', async () => {
    // Rows the migration enrolled: charged before the id was stored, still
    // genuinely owed. They cannot be refunded by API, and must not vanish.
    const id = await owedDm(null);

    await refunds.processOwedRefunds();

    const dm = await read(id);
    expect(dm.refundStatus).toBe('failed');
    expect(dm.refundError).toContain('cannot be refunded automatically');
    expect(emitted).toEqual([]);
  });

  // ---------------------------------------------------------------------
  it('leaves an unexpired DM alone', async () => {
    const id = await owedDm('flw-tx-untouched', {
      status: 'awaiting_response',
      refundStatus: 'not_owed',
      deadlineAt: new Date(Date.now() + 3600_000),
    });

    await refunds.processOwedRefunds();

    const dm = await read(id);
    expect(dm.refundStatus).toBe('not_owed');
    expect(dm.status).toBe('awaiting_response');
    expect(emitted).toEqual([]);
  });
});

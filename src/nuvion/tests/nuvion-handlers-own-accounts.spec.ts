import { PrismaService } from '../../common/prisma/prisma.service';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionCapitalHandler } from '../handlers/capital.handler';
import { NuvionFxHandler } from '../handlers/fx.handler';
import type { NuvionDelivery } from '../handlers/nuvion-handler.interface';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';

/**
 * A delivery goes to the handler whose account it is. The dispatcher leaves a
 * delivery `pending` while ANY handler answers `wait`, so a handler that waits
 * for a service it does not need (Capital's service, for a naira wallet's
 * transfer) holds back the naira handlers' work on the same delivery: naira
 * money in stopped being credited and settled sends stopped being processed
 * (CI of PR #199, NUV-04 and FIX-86). The foreign-account and Capital handlers
 * answer `done` for what is not theirs, with the services they need unmounted.
 */

const NAIRA_ENTITY = '01NAIRAENTITY0000000000001';

function delivery(
  event: string,
  data: Record<string, unknown>,
): NuvionDelivery {
  return {
    id: 'd',
    eventId: `e-${event}`,
    event,
    resourceId: String(data.id),
    entityId: NAIRA_ENTITY,
    data,
    receivedAt: new Date(),
    attempts: 1,
  };
}

const transfer = (type: 'inflow' | 'outflow', paymentType: string) => ({
  id: '01NAIRATRANSFER00000000001',
  amount: 150_000,
  currency: 'NGN',
  unique_reference: 'ref-1',
  counterparty_id: '01CP000000000000000000001',
  account_id: '01NAIRAACCOUNT0000000000001',
  entity_id: NAIRA_ENTITY,
  status: 'successful',
  status_reason: 'Successful.',
  narration: 'x',
  type,
  payment_type: paymentType,
  applicable_fee: 0,
  meta: {},
  created: Date.now(),
  updated: Date.now(),
});

describe('handlers answer for their own accounts only', () => {
  const prisma = new PrismaService();
  const provider = new NuvionWalletProvider(
    new NuvionClient(
      new NuvionStandin().settings(),
      'nv_test_sk_ownaccountsKEY000000000',
    ),
  );
  // Nothing but the wallet provider is mounted: no Capital service, no foreign-account service, no ledger.
  const moduleRef = {
    get: (token: unknown) => {
      if (token === WALLET_PROVIDER) return provider;
      throw new Error('not mounted');
    },
  };
  const capital = new NuvionCapitalHandler(prisma, moduleRef as never);
  const fx = new NuvionFxHandler(prisma, moduleRef as never);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each([
    ['inflows.completed', 'inflow', 'bank-transfer'],
    ['inflows.failed', 'inflow', 'bank-transfer'],
    ['outflows.completed', 'outflow', 'book-transfer'],
    ['outflows.failed', 'outflow', 'bank-transfer'],
    ['outflows.refunded', 'inflow', 'card-debit-reversal'],
  ] as const)(
    "a naira wallet's %s is done for Capital and for the foreign accounts, never a wait",
    async (event, type, rail) => {
      const d = delivery(event, transfer(type, rail));
      expect((await capital.handle(d)).outcome).toBe('done');
      expect((await fx.handle(d)).outcome).toBe('done');
    },
  );

  it("a Capital rail of a person Capital does not know is done too, and one whose wallet cannot be read yet still waits (it is Capital's)", async () => {
    const d = delivery(
      'outflows.completed',
      transfer('outflow', 'capital-purchase'),
    );
    expect((await capital.handle(d)).outcome).toBe('done');
  });

  it("an event that is Capital's waits for Capital's service, as before", async () => {
    const d = delivery('capital_orders.created', {
      id: '01ORDER00000000000000000001',
    });
    expect((await capital.handle(d)).outcome).toBe('wait');
  });
});

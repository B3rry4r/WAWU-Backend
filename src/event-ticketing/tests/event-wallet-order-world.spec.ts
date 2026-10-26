import { MoneyError } from '../../money/money-error';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { PaySourceMiddleware } from '../../money/payments/pay-source-context';
import { EventWalletOrderService } from '../wallet/event-wallet-order.service';

/**
 * PAY-FX round 3 (F6): a buyer who opened from outside Nigeria has no naira
 * account (R-87). If their request names no account to pay from, a priced
 * order is refused BEFORE an order is made, so no order is left behind with
 * nothing that can pay it. Named (`X-Pay-Source-Currency`), the order is made
 * and quoted as for anyone.
 */

const WORLD: OpenWallet = {
  wawuUserId: 'buyer',
  customerId: '',
  walletId: '',
  accountNumber: '',
};
const NAIRA: OpenWallet = {
  wawuUserId: 'buyer',
  customerId: 'c',
  walletId: 'w',
  accountNumber: '8200000001',
};

function build(wallet: OpenWallet) {
  const created: string[] = [];
  const tier = {
    id: 't1',
    name: 'Regular',
    priceNaira: 7_500,
    quantity: 10,
    sold: 0,
    salesStartAt: null,
    salesEndAt: null,
    retiredAt: null,
  };
  const prisma = {
    event: {
      findUnique: () =>
        Promise.resolve({
          id: 'e1',
          hostWawuId: 'host',
          status: 'published',
          cancelledAt: null,
          startsAt: new Date(Date.now() + 86_400_000),
        }),
    },
    eventTicketType: { findMany: () => Promise.resolve([tier]) },
    walletPayment: { findMany: () => Promise.resolve([]) },
    eventOrder: { count: () => Promise.resolve(0) },
    $transaction: () => {
      created.push('order');
      return Promise.reject(new Error('stop: an order would be made here'));
    },
  };
  const service = new EventWalletOrderService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    { requireOpenOrWorld: () => Promise.resolve(wallet) } as never,
    { assertVisible: () => Promise.resolve() } as never,
    {} as never,
    { number: () => 3 } as never,
  );
  return { service, created };
}

const DTO = { lines: [{ ticketTypeId: 't1', quantity: 1 }] } as never;

/** Runs `fn` as a request that carries (or does not carry) the pay-source header. */
function asRequest<T>(
  header: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    new PaySourceMiddleware().use(
      { headers: header ? { 'x-pay-source-currency': header } : {} } as never,
      {} as never,
      () => {
        fn().then(resolve, reject);
      },
    );
  });
}

describe('PAY-FX round 3: a world buyer with no paying account is refused before an order exists', () => {
  it('refuses a priced order with wallet_not_open and makes no order', async () => {
    const { service, created } = build(WORLD);
    const err = await asRequest(undefined, () =>
      service.create('buyer', 'e1', DTO),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).getResponse()).toMatchObject({
      reason: { code: 'wallet_not_open' },
    });
    expect(created).toEqual([]);
  });

  it('refuses the naira way named outright too', async () => {
    const { service, created } = build(WORLD);
    const err = await asRequest('NGN', () =>
      service.create('buyer', 'e1', DTO),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MoneyError);
    expect(created).toEqual([]);
  });

  it('goes on to make the order when an account to pay from is named', async () => {
    const { service, created } = build(WORLD);
    await expect(
      asRequest('USD', () => service.create('buyer', 'e1', DTO)),
    ).rejects.toThrow('stop: an order would be made here');
    expect(created).toEqual(['order']);
  });

  it('a person with a naira account is not asked for one', async () => {
    const { service, created } = build(NAIRA);
    await expect(
      asRequest(undefined, () => service.create('buyer', 'e1', DTO)),
    ).rejects.toThrow('stop: an order would be made here');
    expect(created).toEqual(['order']);
  });
});

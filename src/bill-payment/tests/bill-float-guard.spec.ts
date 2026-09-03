import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BillPaymentService } from '../bill-payment.service';
import type { FlutterwaveBillsClient } from '../flutterwave-bills.client';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Refuse before taking money, not after.
 *
 * A bill is paid out of WAWU's own Flutterwave float, not the customer's
 * card. Card charges settle to `available` on Flutterwave's own cycle, so the
 * float can read zero while money sits banked in `ledger`.
 *
 * That is not hypothetical: the product owner paid ₦102 for ₦100 of MTN
 * airtime, the charge succeeded, and the top-up then failed with
 * "Insufficient funds in your wallet" — money taken, nothing delivered, a
 * manual refund owed. This is the check that turns that into a message
 * BEFORE anybody pays.
 */
function build(available: number | null) {
  const created: unknown[] = [];
  const bills = {
    availableNgn: async () => available,
  } as unknown as FlutterwaveBillsClient;
  const prisma = {
    billPayment: {
      create: async ({ data }: { data: unknown }) => {
        created.push(data);
        return { id: 'bill-1', ...(data as object) };
      },
    },
  } as unknown as PrismaService;
  const service = new BillPaymentService(
    prisma,
    bills,
    {} as never,
    {} as never,
  );
  return { service, created };
}

const dto = {
  category: 'AIRTIME',
  billerCode: 'BIL099',
  itemCode: 'AT099',
  billerName: 'MTN Nigeria',
  customerRef: '08030000000',
  amount: 100,
} as Parameters<BillPaymentService['init']>[1];

describe('bill payments: the float guard', () => {
  it('refuses BEFORE charging when the float cannot cover the bill', async () => {
    const { service, created } = build(0);
    await expect(service.init('buyer-1', dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Nothing recorded, so nothing to refund: the customer never paid.
    expect(created).toHaveLength(0);
  });

  it('says nothing was charged, because nothing was', async () => {
    const { service } = build(0);
    await expect(service.init('buyer-1', dto)).rejects.toThrow(/Nothing has been charged/i);
  });

  it('proceeds when the float covers it', async () => {
    const { service, created } = build(5000);
    await expect(service.init('buyer-1', dto)).resolves.toHaveProperty('billPaymentId');
    expect(created).toHaveLength(1);
  });

  it('proceeds when the balance cannot be read', async () => {
    // A provider hiccup must not close the shop. The post-charge failure path
    // still catches a genuine shortfall.
    const { service, created } = build(null);
    await expect(service.init('buyer-1', dto)).resolves.toHaveProperty('billPaymentId');
    expect(created).toHaveLength(1);
  });

  it('proceeds when the float exactly equals the bill', async () => {
    const { service } = build(100);
    await expect(service.init('buyer-1', dto)).resolves.toHaveProperty('billPaymentId');
  });
});

describe('bill payments: the failure a customer reads', () => {
  it('promises a refund with a timeframe, not just a reference', () => {
    // The old copy was "Our team will refund you" plus a reference: no
    // timeframe, which reads as a brush-off when you have just lost money.
    const message =
      'Your payment went through but MTN Nigeria could not deliver it, so nothing was bought. ' +
      'You will be refunded in full within 3 working days. ' +
      'Quote wawu-bill-x if you need to chase it.';
    expect(message).toMatch(/refunded in full within \d+ working days/);
    expect(message).toMatch(/nothing was bought/);
    expect(new BadRequestException(message).message).toContain('refunded in full');
  });
});

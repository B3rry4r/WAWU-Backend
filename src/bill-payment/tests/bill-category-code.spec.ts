import { BadGatewayException } from '@nestjs/common';
import { BillPaymentService } from '../bill-payment.service';
import type { FlutterwaveBillsClient } from '../flutterwave-bills.client';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * "Invalid category code" — the bug that broke four of the six bill
 * categories.
 *
 * The provider matches on the category CODE (AIRTIME, INTSERVICE). The client
 * sent the display NAME, because the client's own BillCategory type did not
 * declare `code` at all, so `name` was the only string available. Airtime
 * worked by coincidence — "Airtime" equals AIRTIME — which is why this looked
 * like one broken category rather than four.
 *
 * The client now sends the code. This covers the server's half: a name is
 * resolved and retried rather than handed back as a provider error nobody can
 * act on.
 */
const CATEGORIES = [
  { id: 1, name: 'Airtime', code: 'AIRTIME' },
  { id: 2, name: 'Internet Service', code: 'INTSERVICE' },
  { id: 3, name: 'Cable Bill Payment', code: 'CABLEBILLS' },
];

function build(opts: { categoriesFail?: boolean } = {}) {
  const calls: string[] = [];
  const bills = {
    listCategories: async () => {
      if (opts.categoriesFail) throw new Error('categories unavailable');
      return CATEGORIES;
    },
    listBillers: async (category: string) => {
      calls.push(category);
      // Mirrors the provider: only a real code returns billers.
      if (!CATEGORIES.some((c) => c.code === category)) {
        throw new BadGatewayException('Invalid category code');
      }
      return [{ id: 9, name: 'SPECTRANET LIMITED', biller_code: 'BIL124' }];
    },
  } as unknown as FlutterwaveBillsClient;

  const service = new BillPaymentService(
    {} as unknown as PrismaService,
    bills,
    {} as never,
    {} as never,
  );
  return { service, calls };
}

describe('bill categories', () => {
  it('returns billers for a category CODE', async () => {
    const { service, calls } = build();
    await expect(service.listBillers('INTSERVICE')).resolves.toHaveLength(1);
    expect(calls).toEqual(['INTSERVICE']);
  });

  it('recovers when a caller sends the display NAME instead of the code', async () => {
    // The exact failure the user hit: picking "Internet" dead-ended on
    // "Invalid category code".
    const { service, calls } = build();
    await expect(service.listBillers('Internet Service')).resolves.toHaveLength(1);
    expect(calls).toEqual(['Internet Service', 'INTSERVICE']);
  });

  it('recovers for every category whose name is not its code', async () => {
    for (const name of ['Internet Service', 'Cable Bill Payment']) {
      const { service } = build();
      await expect(service.listBillers(name)).resolves.toHaveLength(1);
    }
  });

  it('does not retry when the value is already the code', async () => {
    // Retrying the same string doubles the latency to reach the same failure.
    const { service, calls } = build();
    await expect(service.listBillers('NOT_A_CATEGORY')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(calls).toEqual(['NOT_A_CATEGORY']);
  });

  it('keeps the provider error when the category list cannot be read', async () => {
    const { service } = build({ categoriesFail: true });
    await expect(service.listBillers('Internet Service')).rejects.toThrow(
      /Invalid category code/,
    );
  });
});

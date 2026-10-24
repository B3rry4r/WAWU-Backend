import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from '../data-export-sections';

/**
 * The person's own foreign-currency and Capital records are in the data export
 * (WALLET-21, NUV-12; R-17): a section each, their own rows only, written as
 * JSON (amounts are numbers, not bigint), and none of the provider's ids,
 * references, routing numbers, admin notes or the whole outside address.
 */
const ME = 'b18fx-export-me';
const OTHER = 'b18fx-export-other';

describe('the data export carries the money records (WALLET-21, NUV-12)', () => {
  const prisma = new PrismaService();

  async function clean() {
    for (const who of [ME, OTHER]) {
      await prisma.fxMovement.deleteMany({ where: { wawuUserId: who } });
      await prisma.fxOperation.deleteMany({ where: { wawuUserId: who } });
      await prisma.fxQuote.deleteMany({ where: { wawuUserId: who } });
      await prisma.fxAccount.deleteMany({ where: { wawuUserId: who } });
      await prisma.capitalOrder.deleteMany({ where: { wawuUserId: who } });
    }
  }

  beforeAll(async () => {
    await clean();
    for (const who of [ME, OTHER]) {
      await prisma.fxAccount.create({
        data: {
          wawuUserId: who,
          currency: 'USD',
          providerCustomerId: 'cust-secret',
          providerAccountId: `acc-secret-${who}`,
          ban: '0012345678',
          status: 'frozen',
          frozenReason: 'internal note',
          detailsId: 'det-secret',
        },
      });
      await prisma.fxQuote.create({
        data: {
          wawuUserId: who,
          providerQuoteId: 'q-secret',
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          amountFromMinor: 100_000n,
          amountToMinor: 74n,
          rate: '0.000741',
          wawuFeeMinor: 5n,
          expiresAt: new Date(),
        },
      });
      await prisma.fxOperation.create({
        data: {
          wawuUserId: who,
          kind: 'send',
          status: 'completed',
          reference: `ref-secret-${who}`,
          fromCurrency: 'USDT',
          amountFromMinor: 1_000n,
          wawuFeeMinor: 0n,
          chain: 'eth',
          address: `0x${'ab'.repeat(20)}`,
          providerTransferId: 'tr-secret',
          day: '2026-10-24',
        },
      });
      await prisma.fxMovement.create({
        data: {
          providerTransferId: `mv-secret-${who}`,
          wawuUserId: who,
          fxAccountId: 'x',
          currency: 'USD',
          direction: 'in',
          status: 'completed',
          amountMinor: 74n,
          reference: 'mv-ref-secret',
          occurredAt: new Date(),
        },
      });
      await prisma.capitalOrder.create({
        data: {
          wawuUserId: who,
          reserveKey: `rk-secret-${who}`,
          fingerprint: 'fp-secret',
          state: 'confirmed',
          nuvionOrderId: `ord-secret-${who}`,
          productId: 'p1',
          productName: 'Fixed return',
          productType: 'fixed',
          currency: 'USD',
          amountMinor: 50_000n,
          feeKobo: 0n,
          purchaseTransferId: 'pt-secret',
          frozenReason: 'internal note',
        },
      });
    }
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it.each([
    ['foreignAccounts', 1],
    ['foreignQuotes', 1],
    ['foreignSwapsAndSends', 1],
    ['foreignMovements', 1],
    ['capitalOrders', 1],
  ])(
    '%s: only my rows, as JSON, with no provider id, reference or note',
    async (key, count) => {
      const section = EXPORT_SECTIONS.find((s) => s.key === key)!;
      const rows = (await section.load(prisma, ME)) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(count);
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/secret|internal note|0012345678/);
      expect(text).not.toContain(OTHER);
      expect(text).not.toContain('abababababababababababababababababababab');
    },
  );

  it('gives an outside address as its last six characters only, and amounts as numbers', async () => {
    const send = EXPORT_SECTIONS.find((s) => s.key === 'foreignSwapsAndSends')!;
    const [row] = (await send.load(prisma, ME)) as Array<
      Record<string, unknown>
    >;
    expect(row).toMatchObject({
      kind: 'send',
      fromCurrency: 'USDT',
      amountFromMinor: 1000,
      addressEnd: 'ababab',
    });
    expect('address' in row).toBe(false);
    const capital = EXPORT_SECTIONS.find((s) => s.key === 'capitalOrders')!;
    const [order] = (await capital.load(prisma, ME)) as Array<
      Record<string, unknown>
    >;
    expect(order).toMatchObject({
      productName: 'Fixed return',
      amountMinor: 50000,
      totalDebitMinor: null,
    });
  });
});

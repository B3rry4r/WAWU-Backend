import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';

/**
 * THE SWEEP MUST NOT STALL ONCE THE LIMIT IS FULL.
 *
 * This runs the real SQL against a real database, because the bug it guards
 * only appears past the batch size: taking the oldest N rows and filtering the
 * funded ones out afterwards works perfectly until N sales have been paid, and
 * from then on every run reads the same N funded rows and pays nobody. Nothing
 * in a mocked test would have shown that.
 */
const url = process.env.DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('funding sweep, against a real database', () => {
  // Same adapter the app's own PrismaService uses; this client is not
  // instantiable without one.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const CREATOR = 'sweep-creator-1';
  const MAX = 100;

  beforeAll(async () => {
    await prisma.walletLedgerEntry.deleteMany({ where: { wawuUserId: CREATOR } });
    await prisma.purchase.deleteMany({ where: { creatorWawuId: CREATOR } });

    // MAX already-paid sales, then one newer sale that has not been paid.
    for (let i = 0; i < MAX; i++) {
      const p = await prisma.purchase.create({
        data: {
          creatorWawuId: CREATOR, buyerWawuId: 'buyer-1', type: 'content',
          amount: 1000, commissionRate: 0.15, status: 'completed',
          flutterwaveTxRef: `sweep-paid-${i}`,
          purchasedAt: new Date(Date.now() - (MAX - i) * 60_000),
        },
      });
      await prisma.walletLedgerEntry.create({
        data: {
          wawuUserId: CREATOR, kind: 'earning', amount: 850,
          reference: `purchase:${p.id}`, sourceType: 'purchase', sourceId: p.id,
          status: 'completed',
        },
      });
    }
    await prisma.purchase.create({
      data: {
        creatorWawuId: CREATOR, buyerWawuId: 'buyer-1', type: 'content',
        amount: 2000, commissionRate: 0.15, status: 'completed',
        flutterwaveTxRef: 'sweep-unpaid-1',
        purchasedAt: new Date(),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.walletLedgerEntry.deleteMany({ where: { wawuUserId: CREATOR } });
    await prisma.purchase.deleteMany({ where: { creatorWawuId: CREATOR } });
    await prisma.$disconnect();
  });

  it('still finds the newest unpaid sale with the batch already full of paid ones', async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string; amount: number }>>`
      SELECT p."id", p."amount"
        FROM "Purchase" p
       WHERE p."status" = 'completed'
         AND p."creatorWawuId" = ${CREATOR}
         AND NOT EXISTS (
               SELECT 1 FROM "WalletLedgerEntry" e
                WHERE e."sourceType" = 'purchase' AND e."sourceId" = p."id"
             )
       ORDER BY p."purchasedAt" ASC
       LIMIT ${MAX}
    `;
    // The old query returned the 100 oldest rows, all of them already funded,
    // and this sale would never have been paid.
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(2000);
  }, 30_000);
});

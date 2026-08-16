// Non-destructive test-hygiene script: deletes ONLY rows created by
// contract-test runs (identifiable because seed.ts uses a fixed, known
// set of UUIDs and every seeded table's test data starts with predictable
// prefixes -- see prisma/seed.ts). Never touches a row whose id is in the
// known-seeded set. Intended for the local wawu_hub_test database only --
// refuses to run against anything else.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL.includes('wawu_hub_test')) {
  console.error('Refusing to run: DATABASE_URL does not point at wawu_hub_test.');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Known seeded IDs (from prisma/seed.ts) -- everything else in these
// tables was created by a contract test run and is safe to clear.
const SEEDED_COMMENT_IDS = ['12000000-0000-4000-8000-000000000001'];
const SEEDED_PURCHASE_IDS = ['80000000-0000-4000-8000-000000000001'];

async function main() {
  const deletedComments = await prisma.comment.deleteMany({
    where: { id: { notIn: SEEDED_COMMENT_IDS } },
  });
  const deletedPurchases = await prisma.purchase.deleteMany({
    where: { id: { notIn: SEEDED_PURCHASE_IDS } },
  });
  console.log(`Cleaned ${deletedComments.count} test-generated comments, ${deletedPurchases.count} test-generated purchases.`);
}

main().finally(() => prisma.$disconnect());

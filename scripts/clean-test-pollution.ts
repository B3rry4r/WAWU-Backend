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
const SEEDED_CONTENT_PIECE_IDS = [
  '10000000-0000-4000-8000-000000000001', // CONTENT_CAC_COURSE
  '10000000-0000-4000-8000-000000000002', // CONTENT_MAKEUP_VIDEO
  '10000000-0000-4000-8000-000000000003', // CONTENT_PDF_TEMPLATE
];

// CreditPurchase's contract tests increment the seeded users' CreditsState
// row in place (real Flutterwave-verify -> credit grant path) rather than
// creating a fresh row, so deleteMany can't undo it -- reset the balance
// seed.ts's upsert set on first create (prisma/seed.ts line ~626).
const SEEDED_CREDIT_USER_IDS = [
  '00000000-0000-4000-8000-000000000001', // USER_PLAIN
  '00000000-0000-4000-8000-000000000002', // USER_CREATOR_BASIC
  '00000000-0000-4000-8000-000000000003', // USER_CREATOR_PRO
];
const SEEDED_CREDIT_BALANCE = 48;

async function main() {
  // Purchase FIRST. Comment and SavedItem do cascade off ContentPiece, but
  // Purchase -> ContentPiece is `onDelete: Restrict` (schema.prisma), so a
  // stray purchase BLOCKS the delete of the content it points at. This used
  // to be ordered the other way round on the assumption that everything
  // cascaded, which made the script throw a foreign-key error the moment a
  // run left a purchase behind.
  const deletedPurchases = await prisma.purchase.deleteMany({
    where: { id: { notIn: SEEDED_PURCHASE_IDS } },
  });
  const deletedContent = await prisma.contentPiece.deleteMany({
    where: { id: { notIn: SEEDED_CONTENT_PIECE_IDS } },
  });
  const deletedComments = await prisma.comment.deleteMany({
    where: { id: { notIn: SEEDED_COMMENT_IDS } },
  });
  // CreditPurchase rows are created fresh by every credit-purchase run and
  // seed.ts creates none, so anything here is test-generated.
  const deletedCreditPurchases = await prisma.creditPurchase.deleteMany({});
  const resetCredits = await prisma.creditsState.updateMany({
    where: { userWawuId: { in: SEEDED_CREDIT_USER_IDS } },
    data: { creditBalance: SEEDED_CREDIT_BALANCE },
  });
  console.log(`Cleaned ${deletedContent.count} test-generated content pieces, ${deletedComments.count} test-generated comments, ${deletedPurchases.count} test-generated purchases, ${deletedCreditPurchases.count} test-generated credit purchases, reset ${resetCredits.count} CreditsState balances to ${SEEDED_CREDIT_BALANCE}.`);
}

main().finally(() => prisma.$disconnect());

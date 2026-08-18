-- Purchase.contentId: SetNull -> Restrict.
--
-- A Purchase is a financial record. Under SetNull, deleting a ContentPiece
-- silently nulled the link on every buyer's purchase row: the payment record
-- survived but no longer recorded WHAT was bought, breaking entitlement
-- checks and receipts after the fact. Restrict makes the database refuse the
-- delete instead, so sold content must be unpublished rather than destroyed.
ALTER TABLE "Purchase" DROP CONSTRAINT IF EXISTS "Purchase_contentId_fkey";

ALTER TABLE "Purchase"
  ADD CONSTRAINT "Purchase_contentId_fkey"
  FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

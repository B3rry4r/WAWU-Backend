\set ON_ERROR_STOP on
-- Rollback of 20270102090000_email_brand_delivery (EMAIL-03). Run with: psql -1 -f rollback.down.sql, only after the
-- Hub build that reads these columns is gone.
--
-- It refuses (changing nothing) while anything it would lose exists: any row in "EmailEvent" or
-- "EmailBrandSuppression", or any value in a column this migration added. Export that first (COPY ... TO).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EmailEvent") THEN
    RAISE EXCEPTION 'EmailEvent holds rows; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "EmailBrandSuppression") THEN
    RAISE EXCEPTION 'EmailBrandSuppression holds rows; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "EmailTemplate" WHERE "brand" IS NOT NULL OR "buttonText" IS NOT NULL OR "buttonUrl" IS NOT NULL) THEN
    RAISE EXCEPTION 'EmailTemplate holds brand or button values; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "EmailCampaign" WHERE "brand" IS NOT NULL OR "buttonText" IS NOT NULL OR "buttonUrl" IS NOT NULL
      OR "pausedUntil" IS NOT NULL OR "pauseReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'EmailCampaign holds brand, button or pause values; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "EmailRecipient" WHERE "delivery" IS NOT NULL OR "deliveryAt" IS NOT NULL OR "deliveryNote" IS NOT NULL) THEN
    RAISE EXCEPTION 'EmailRecipient holds delivery results; export them first';
  END IF;
END $$;

DROP INDEX IF EXISTS "EmailRecipient_providerId_idx";
DROP TABLE "EmailEvent";
DROP TABLE "EmailBrandSuppression";
ALTER TABLE "EmailRecipient" DROP COLUMN "delivery", DROP COLUMN "deliveryAt", DROP COLUMN "deliveryNote";
ALTER TABLE "EmailCampaign" DROP COLUMN "brand", DROP COLUMN "buttonText", DROP COLUMN "buttonUrl", DROP COLUMN "pausedUntil", DROP COLUMN "pauseReason";
ALTER TABLE "EmailTemplate" DROP COLUMN "brand", DROP COLUMN "buttonText", DROP COLUMN "buttonUrl";

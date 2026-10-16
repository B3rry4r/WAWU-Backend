-- FIX-20: provider webhook deliveries are not kept for ever.
--
-- "FintavaWebhookEvent" and "NuvionWebhookEvent" keep each delivery's raw body
-- and a parsed copy (names, account numbers, narrations) with no person column
-- and no end date, so neither the account purge nor the data export can find
-- them. Retention covers them instead: a daily job (src/webhook-retention/)
-- clears the body and the parsed copy of a delivery once it is older than
-- WEBHOOK_RETENTION_DAYS (90 by default) and the delivery is finished with.
--
-- What the job keeps is what makes a delivery sent again after clearing still a
-- repeat: the Fintava "bodySha256" (the unique key a repeat lands on), the
-- Nuvion "eventId" and ("signedAt", "bodySha256") keys, the received time, the
-- outcome ("processingStatus", "note", "processedAt") and the references the
-- ledger's absent check reads ("dataReference", "dataCustomerReference").
--
-- Additive only:
-- - one NULLABLE column on each table, "bodyClearedAt": when the body was
--   cleared. Null for every existing row, and for every new one. Nothing is
--   cleared by this migration; an older instance never reads or writes it, and
--   no route the web or the dashboard calls touches either table;
-- - one CHECK on each table: a row marked cleared really has no body. A
--   cleared row has an empty "rawBody" (not NULL: the column stays NOT NULL)
--   and a JSON null "payload", and a Fintava row also keeps its "bodySha256",
--   the key its repeat check reads. Every existing row has "bodyClearedAt"
--   NULL, so it passes, and the check reads one small column of each row;
-- - one PARTIAL index on each table, so a run finds the rows still to clear
--   without walking the ones already cleared (which stay in the table).
--   Prisma cannot write a partial index, so it is here only, like the
--   waitlist's partial unique indexes.
--
-- Rollback (also in rollback.sql): drop the indexes, the CHECKs and the
-- columns, then delete this migration's row from "_prisma_migrations". Bodies
-- already cleared are not restored; nothing reads them.

-- AlterTable
ALTER TABLE "FintavaWebhookEvent" ADD COLUMN "bodyClearedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NuvionWebhookEvent" ADD COLUMN "bodyClearedAt" TIMESTAMP(3);

-- A row marked cleared has no body, and a Fintava row keeps the key its repeat
-- check reads. Every arm is a boolean that is never NULL ("rawBody" and
-- "payload" are NOT NULL), so a NULL cannot make a bad row pass.
ALTER TABLE "FintavaWebhookEvent" ADD CONSTRAINT "FintavaWebhookEvent_body_cleared_check"
    CHECK (
      "bodyClearedAt" IS NULL
      OR (
        "bodySha256" IS NOT NULL
        AND octet_length("rawBody") = 0
        AND "payload" = 'null'::jsonb
      )
    );

ALTER TABLE "NuvionWebhookEvent" ADD CONSTRAINT "NuvionWebhookEvent_body_cleared_check"
    CHECK (
      "bodyClearedAt" IS NULL
      OR (
        octet_length("rawBody") = 0
        AND "payload" = 'null'::jsonb
      )
    );

-- The rows the retention job may still clear, by state and age.
CREATE INDEX "FintavaWebhookEvent_body_retention_idx"
    ON "FintavaWebhookEvent"("processingStatus", "receivedAt")
    WHERE "bodyClearedAt" IS NULL;

CREATE INDEX "NuvionWebhookEvent_body_retention_idx"
    ON "NuvionWebhookEvent"("processingStatus", "receivedAt")
    WHERE "bodyClearedAt" IS NULL;

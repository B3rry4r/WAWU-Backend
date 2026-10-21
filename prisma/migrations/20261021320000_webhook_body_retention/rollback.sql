\set ON_ERROR_STOP on
-- Rollback for 20261021320000_webhook_body_retention (FIX-20). Run with: psql -1 -f rollback.sql
-- Bodies the job already cleared are not restored.
DROP INDEX "FintavaWebhookEvent_body_retention_idx";
DROP INDEX "NuvionWebhookEvent_body_retention_idx";
ALTER TABLE "FintavaWebhookEvent" DROP CONSTRAINT "FintavaWebhookEvent_body_cleared_check";
ALTER TABLE "NuvionWebhookEvent" DROP CONSTRAINT "NuvionWebhookEvent_body_cleared_check";
ALTER TABLE "FintavaWebhookEvent" DROP COLUMN "bodyClearedAt";
ALTER TABLE "NuvionWebhookEvent" DROP COLUMN "bodyClearedAt";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021320000_webhook_body_retention';

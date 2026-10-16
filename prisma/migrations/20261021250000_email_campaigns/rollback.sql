-- Rollback for 20261021250000_email_campaigns (EMAIL-01). Run with: psql -1 -f rollback.sql
DROP TABLE "EmailRecipient", "EmailCampaign", "EmailTemplate", "EmailSuppression";
DROP TYPE "EmailCampaignStatus", "EmailRecipientStatus", "EmailSuppressionReason";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021250000_email_campaigns';

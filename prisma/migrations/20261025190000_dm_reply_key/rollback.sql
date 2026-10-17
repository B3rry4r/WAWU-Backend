-- Rollback of 20261025190000_dm_reply_key (INBOX-18 round 2). Nothing else references the table.
DROP TABLE "DmReplyKey";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025190000_dm_reply_key';

-- Rollback of 20261020120000_community_message_key (INBOX-05 round 5). Nothing else references the table.
DROP TABLE "CommunityMessageKey";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261020120000_community_message_key';

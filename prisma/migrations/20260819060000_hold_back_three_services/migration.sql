-- Telemedicine, Grants and Travel are held back until they are ready to
-- announce; they ship as updates rather than sitting in the catalogue as
-- promises. The code behind Telemedicine stays in place, it is simply not
-- listed.
DELETE FROM "PartnerService" WHERE "slug" IN ('care', 'grants', 'travel');

-- The CredPal partnership behind EasyBuy has ended, so the service is removed
-- from the catalogue. Safe to delete outright: no application had ever been
-- submitted against it.
--
-- The 'easybuy' value stays in the ServiceApplicationKind enum. Dropping an
-- enum value in Postgres means rewriting the type and every column that uses
-- it, which is a destructive operation to buy nothing: the value is now
-- unreachable because no code path accepts it.
DELETE FROM "PartnerService" WHERE "slug" = 'easybuy';

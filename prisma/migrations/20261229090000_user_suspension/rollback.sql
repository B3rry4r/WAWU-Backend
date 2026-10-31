\set ON_ERROR_STOP on
-- Rollback for 20261229090000_user_suspension (USER-SUSPEND, R-121). It refuses while any suspension is in force: dropping
-- the table would silently lift it and show the person's profile, pieces and messages again. Lift each one first
-- (POST /admin/users/:id/lift). A lifted row is history that the admin audit trail (AdminOpsAudit, resource
-- user_suspension) also holds, so it is dropped with the table. Run with: psql -1 -f rollback.sql
-- The enum values added to AdminOpsResource and AdminOpsAction are left in place (Postgres cannot drop an enum value).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UserSuspension" WHERE "liftedAt" IS NULL) THEN
    RAISE EXCEPTION 'rollback refused: a UserSuspension is still in force';
  END IF;
END $$;

DROP TABLE "UserSuspension";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261229090000_user_suspension';

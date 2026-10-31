\set ON_ERROR_STOP on
-- Rollback for 20261229090000_user_suspension (USER-SUSPEND, R-121). It refuses ONE thing: while any suspension is in
-- force (a UserSuspension row with "liftedAt" null) it raises and changes nothing, because dropping the table would
-- silently lift it and show the person's profile, pieces and messages again. Lift each one first
-- (POST /admin/users/:id/lift). It does NOT check anything else: a lifted row is history that the admin audit trail
-- (AdminOpsAudit, resource user_suspension) also holds, and it is dropped with the table. Run with: psql -1 -f rollback.sql
-- The enum values added to AdminOpsResource and AdminOpsAction are left in place (Postgres cannot drop an enum value);
-- the migration's ADD VALUE lines are IF NOT EXISTS, so applying it again afterwards works.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UserSuspension" WHERE "liftedAt" IS NULL) THEN
    RAISE EXCEPTION 'rollback refused: a UserSuspension is still in force';
  END IF;
END $$;

DROP TABLE "UserSuspension";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261229090000_user_suspension';

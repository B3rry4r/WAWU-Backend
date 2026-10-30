\set ON_ERROR_STOP on
-- Rollback for 20261223090000_receptionist (AITOOLS-06). It refuses while any row exists: a row is an agent, a document
-- or a message a person gave their Receptionist, and the provider may still hold a copy. Clear the Receptionists first
-- (the person's DELETE /ai-tools/receptionist, or the account purge), let the Hub delete the rows, then run this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ReceptionistAgent")
    OR EXISTS (SELECT 1 FROM "ReceptionistKnowledge")
    OR EXISTS (SELECT 1 FROM "ReceptionistTurn") THEN
    RAISE EXCEPTION 'rollback refused: a receptionist row exists';
  END IF;
END $$;

DROP TABLE "ReceptionistTurn";
DROP TABLE "ReceptionistKnowledge";
DROP TABLE "ReceptionistAgent";

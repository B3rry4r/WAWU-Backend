-- SETTINGS-05. Additive. Why a person said they are leaving (Z7's optional
-- choice), kept on their deletion row. Nullable: existing rows have none, and
-- a person who does not choose stores nothing.
ALTER TABLE "AccountDeletion"
  ADD COLUMN "leavingReason" TEXT;

-- Playbooks and guides existed only as text seeded into the database, with no
-- file behind them: nothing could actually be uploaded or downloaded. These
-- hold the uploaded document and who last replaced it, so the dashboard can
-- publish a real PDF rather than only editing copy.
ALTER TABLE "Playbook" ADD COLUMN IF NOT EXISTS "fileUrl" TEXT;
ALTER TABLE "Playbook" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);
ALTER TABLE "Playbook" ADD COLUMN IF NOT EXISTS "updatedBy" TEXT;
ALTER TABLE "LearnGuide" ADD COLUMN IF NOT EXISTS "fileUrl" TEXT;
ALTER TABLE "LearnGuide" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);
ALTER TABLE "LearnGuide" ADD COLUMN IF NOT EXISTS "updatedBy" TEXT;

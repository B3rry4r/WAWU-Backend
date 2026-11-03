-- WEB-HOLD (R-126): additive. Two nullable columns on "ContentPiece"; nothing else changes. Nothing the web, the dashboard or
-- the live app calls reads them: a piece with both null is read and written exactly as before.
--
-- "uploadedVia": 'site' for a piece made by the new web upload flow (it sends X-Wawu-Client: site). Null for everything else.
-- "heldForWalletAt": set when a moderator approved a 'site' piece whose creator has no open wallet. The piece stays 'pending'.
--
-- Rollback: rollback.sql in this folder. It REFUSES while any piece carries either value. Run with: psql -1 -f rollback.sql

-- AlterTable
ALTER TABLE "ContentPiece" ADD COLUMN "uploadedVia" TEXT,
ADD COLUMN "heldForWalletAt" TIMESTAMP(3);

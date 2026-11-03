-- Rollback for 20261231090000_content_wallet_hold. Refuses while a piece still carries either value, because dropping the
-- columns would silently turn a held piece back into an ordinary pending one (and lose which pieces came from the web flow).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "ContentPiece" WHERE "uploadedVia" IS NOT NULL OR "heldForWalletAt" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'content_wallet_hold rollback refused: % piece(s) carry uploadedVia or heldForWalletAt', n;
  END IF;
END $$;
ALTER TABLE "ContentPiece" DROP COLUMN "heldForWalletAt", DROP COLUMN "uploadedVia";

-- Creator-initiated content delete needed a status, not a row DELETE:
-- Purchase.content is `onDelete: Restrict` (a sold piece's row cannot be
-- removed from the table at all), so a hard DELETE /content/:id would 500 on
-- anything a buyer ever unlocked. 'removed' is the same uniform answer for
-- every piece regardless of purchase history.
ALTER TYPE "ContentStatus" ADD VALUE 'removed';

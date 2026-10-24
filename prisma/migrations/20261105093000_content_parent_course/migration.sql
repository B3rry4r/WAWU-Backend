-- FIX-111 (H24, G-HOME-08-1). A piece can say it comes from one of its creator's own courses ("From the course VFX for
-- Beginners"). Additive only: one nullable column on the piece's side row ("ContentDetail", not "ContentPiece": every live
-- content response is the piece's row, so a column there would widen what the web reads). A row without it is what every row
-- is today; nothing the web or the dashboard calls reads or writes it.

ALTER TABLE "ContentDetail" ADD COLUMN "parentCourseId" TEXT;

CREATE INDEX "ContentDetail_parentCourseId_idx" ON "ContentDetail"("parentCourseId");

ALTER TABLE "ContentDetail" ADD CONSTRAINT "ContentDetail_parentCourseId_fkey" FOREIGN KEY ("parentCourseId") REFERENCES "ContentPiece"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A speaker's photo. Optional: a speaker with no photo still renders, as
-- their initials, same as before this column existed.
ALTER TABLE "EventSpeaker" ADD COLUMN "photoUrl" TEXT;

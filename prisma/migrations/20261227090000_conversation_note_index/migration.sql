-- REC-DELETE round 1: the copy sweep reads the notes of Receptionist conversations (AiToolJob."providerRef" starting
-- with 'conversation:') by job age every minute. This index holds only those rows, in order of age, so the read stays
-- small however many other AiToolJob rows there are. Additive: one partial index, no column, no data change.
-- Prisma's schema cannot draw a partial index, so it is not in schema.prisma (as the webhook retention indexes are not).
CREATE INDEX "AiToolJob_conversation_note_idx"
    ON "AiToolJob"("createdAt")
    WHERE "providerRef" LIKE 'conversation:%';

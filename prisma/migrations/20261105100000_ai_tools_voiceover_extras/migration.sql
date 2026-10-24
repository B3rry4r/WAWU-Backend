-- AITOOLS-07: VoiceOver's four undrawn parts. Four nullable columns, additive
-- only: every existing row keeps every value it has and reads back with the new
-- columns NULL, so nothing a route answers today changes.
--   "AiToolJob"."savedAt"                 when the person saved the result to their library
--   "VoiceProfile"."ownVoiceConsentAt"    when they agreed WAWU may speak their VoiceOver in an AI version of their own voice
--   "VoiceProfile"."ownVoiceConsentLine"  the exact words they agreed to
--   "ProductDraft"."mediaJobId"           the AI tool job whose audio they chose to use in the draft
-- Rollback: rollback.sql beside this file (it refuses while any of them holds a value).

ALTER TABLE "AiToolJob" ADD COLUMN "savedAt" TIMESTAMP(3);

ALTER TABLE "VoiceProfile"
  ADD COLUMN "ownVoiceConsentAt" TIMESTAMP(3),
  ADD COLUMN "ownVoiceConsentLine" TEXT;

ALTER TABLE "ProductDraft" ADD COLUMN "mediaJobId" TEXT;

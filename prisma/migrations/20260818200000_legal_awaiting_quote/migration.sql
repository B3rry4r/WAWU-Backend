-- A simple service with no fixed price is not a draft: the client has
-- submitted it and is waiting on WAWU to price the work. That is its own
-- state, so it reads as "we have it, a price is coming" rather than looking
-- like an abandoned form.
ALTER TYPE "LegalRequestStatus" ADD VALUE IF NOT EXISTS 'awaiting_quote' AFTER 'draft';

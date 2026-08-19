-- Banking returns to the catalogue, named simply "Banking".
INSERT INTO "PartnerService"
  ("id","slug","name","tagline","blurb","icon","status","turnaround","priceFrom","partner","comingNote","eligibility","benefits","steps","ctaLabel","ctaHref")
VALUES
  (gen_random_uuid(),'banking','Banking','Accounts, savings, loans and SME products',
   'Open accounts, save, and access loans and SME products built for small businesses.',
   'Landmark','live','Reviewed in 3 to 5 days','Free account opening','WEMA Bank',NULL,
   ARRAY['Verified WAWUAfrica account','Valid government ID','BVN'],
   ARRAY['Free account opening','SME focused loan products','Savings with competitive interest','Digital banking tools'],
   '[["Apply","Submit a short request through WAWUAfrica"],["Review","The partner checks your eligibility"],["Access","Get onboarded and start banking"]]'::jsonb,
   'Apply now','/services/banking/apply')
ON CONFLICT ("slug") DO UPDATE SET
  "name"=EXCLUDED."name", "tagline"=EXCLUDED."tagline", "blurb"=EXCLUDED."blurb",
  "icon"=EXCLUDED."icon", "status"=EXCLUDED."status", "turnaround"=EXCLUDED."turnaround",
  "priceFrom"=EXCLUDED."priceFrom", "partner"=EXCLUDED."partner",
  "eligibility"=EXCLUDED."eligibility", "benefits"=EXCLUDED."benefits", "steps"=EXCLUDED."steps",
  "ctaLabel"=EXCLUDED."ctaLabel", "ctaHref"=EXCLUDED."ctaHref";

-- A consultation now books a specific slot, so two clients cannot be given the
-- same hour. Partial: only booked slots occupy one, and a cancelled request
-- releases it by clearing scheduledFor.
CREATE UNIQUE INDEX IF NOT EXISTS "LegalRequest_scheduledFor_key"
  ON "LegalRequest"("scheduledFor")
  WHERE "scheduledFor" IS NOT NULL;

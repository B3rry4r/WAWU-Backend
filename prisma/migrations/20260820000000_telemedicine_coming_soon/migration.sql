-- Telemedicine returns to the catalogue as coming soon: named, so people know
-- it is on the way, but not yet openable. The WellaHealth integration behind it
-- is already built and waiting.
INSERT INTO "PartnerService"
  ("id","slug","name","tagline","blurb","icon","status","turnaround","priceFrom","partner","comingNote","eligibility","benefits","steps","ctaLabel","ctaHref")
VALUES
  (gen_random_uuid(),'care','Telemedicine','See a doctor, get covered',
   'Virtual consultations with licensed doctors, medication cover and screening, paid monthly rather than yearly.',
   'Stethoscope','coming',NULL,NULL,'WellaHealth',
   'We are finishing the partner rollout. It opens here first.',
   ARRAY[]::TEXT[], ARRAY[]::TEXT[], NULL, NULL, NULL)
ON CONFLICT ("slug") DO UPDATE SET
  "name"=EXCLUDED."name", "tagline"=EXCLUDED."tagline", "blurb"=EXCLUDED."blurb",
  "icon"=EXCLUDED."icon", "status"=EXCLUDED."status", "comingNote"=EXCLUDED."comingNote",
  "turnaround"=NULL, "priceFrom"=NULL, "ctaLabel"=NULL, "ctaHref"=NULL;

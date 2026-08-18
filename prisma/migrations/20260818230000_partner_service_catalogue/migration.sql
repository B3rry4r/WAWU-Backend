-- The PartnerService table was empty in production, so GET /services returned
-- [] and the services screen rendered nothing but its two hardcoded free rows.
-- The catalogue lived only in the web app's mock fixtures, which never run
-- against a real backend.
--
-- This adds the routing/detail columns the previous platform had and seeds the
-- full catalogue: the services carried over from that platform plus the three
-- built here. Idempotent on slug so it can be re-run.

ALTER TABLE "PartnerService" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "PartnerService" ADD COLUMN IF NOT EXISTS "eligibility" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PartnerService" ADD COLUMN IF NOT EXISTS "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PartnerService" ADD COLUMN IF NOT EXISTS "steps" JSONB;
ALTER TABLE "PartnerService" ADD COLUMN IF NOT EXISTS "ctaLabel" TEXT;
ALTER TABLE "PartnerService" ADD COLUMN IF NOT EXISTS "ctaHref" TEXT;

UPDATE "PartnerService" SET "slug" = "id" WHERE "slug" IS NULL;
ALTER TABLE "PartnerService" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerService_slug_key" ON "PartnerService"("slug");

INSERT INTO "PartnerService"
  ("id","slug","name","tagline","blurb","icon","status","turnaround","priceFrom","partner","comingNote","eligibility","benefits","steps","ctaLabel","ctaHref")
VALUES
  (gen_random_uuid(),'cac','CAC registration','Register your business in Nigeria',
   'WAWU works with a registered agent to file your CAC business registration for you. You upload your details, an agent reviews them by hand, and your certificate lands on WAWU.',
   'Stamp','live','7 to 14 days','From NGN 25,000','CAC',NULL,
   ARRAY['Verified WAWUAfrica account','Proposed business name','Proprietor ID and passport photograph'],
   ARRAY['Guided CAC registration','Name availability handling','Document upload and tracking','Official registration outcome'],
   '[["Apply","Fill the CAC form and pay"],["Process","We submit to the CAC on your behalf"],["Receive","Get your registration outcome"]]'::jsonb,
   'Apply now','/services/cac/apply'),

  (gen_random_uuid(),'nepc','NEPC export support','Start exporting from Nigeria',
   'Guidance for creators who want to sell their work abroad. An agent walks you through documentation and connects you with the right NEPC desk.',
   'Ship','live','3 to 5 days to first reply','Free to start','NEPC',NULL,
   ARRAY['Verified WAWUAfrica account','A registered business'],
   ARRAY['Export documentation guidance','Introduction to the right NEPC desk','Ongoing follow up'],
   '[["Apply","Tell us what you export"],["Review","An agent reviews your documents"],["Connect","We introduce you to NEPC"]]'::jsonb,
   'Start now','/services/nepc/apply'),

  (gen_random_uuid(),'mentors','Mentors','Book time with people who have done it',
   'Sit with someone who has already built what you are building. Free while we are getting started.',
   'UserRoundSearch','live','Usually within a week','Free','WAWUAfrica',NULL,
   ARRAY['Verified WAWUAfrica account'],
   ARRAY['One to one mentor matching','Industry specific guidance','Access to support programmes','Ongoing follow up'],
   '[["Request","Tell us what you need help with"],["Match","We pair you with a mentor"],["Connect","Start your mentorship"]]'::jsonb,
   'Find a mentor','/services/mentors'),

  (gen_random_uuid(),'pay','WAWUPay','Airtime, data, electricity and cable',
   'Pay any bill without leaving WAWU. Confirm the meter or number first, pay with your card, and the top-up lands straight away.',
   'Zap','live','Instant','No added fee','Flutterwave',NULL,
   ARRAY['A signed-in WAWU account'],
   ARRAY['Airtime and data on every network','Electricity tokens','Cable and internet subscriptions','The number is confirmed before you pay'],
   '[["Choose","Pick the biller and package"],["Confirm","We check the number with the biller"],["Pay","The top-up lands straight away"]]'::jsonb,
   'Pay a bill','/services/pay'),

  (gen_random_uuid(),'care','WAWUCare','See a doctor, get covered',
   'Virtual consultations with licensed doctors, medication cover and screening. Built for people whose income comes in irregularly, so it is paid monthly rather than yearly.',
   'HeartPulse','live','Active same day','From NGN 600 a month','WellaHealth',NULL,
   ARRAY['A signed-in WAWU account','A Nigerian phone number','Your date of birth'],
   ARRAY['Virtual consultations with licensed doctors','Medication cover at partner pharmacies','Health screening','Paid monthly, not yearly'],
   '[["Choose","Pick a plan"],["Register","Give us the details your cover is issued against"],["Use it","Talk to a doctor whenever you need"]]'::jsonb,
   'See plans','/services/care'),

  (gen_random_uuid(),'legal','WAWU Legal','Filings without a lawyer, lawyers when you need one',
   'Register a business, file your tax or NDPR return with no lawyer call at all. For contracts, trademarks, royalties and entertainment law, book a consultation and get a quote.',
   'Scale','live','Consultation within days','Consultations from NGN 25,000','WAWUAfrica',NULL,
   ARRAY['A signed-in WAWU account','Supporting documents for filings'],
   ARRAY['CAC, tax and NDPR filings with no lawyer call','Contracts, trademarks and IP','Entertainment and creative law','Nothing charged until you sign'],
   '[["Choose","Pick the service you need"],["Talk or file","Simple filings go straight through; the rest start with a consultation"],["Sign and pay","Read the engagement letter, sign, then pay"]]'::jsonb,
   'Browse legal services','/services/legal'),

  (gen_random_uuid(),'easybuy','EasyBuy','Device and equipment financing',
   'Spread the cost of phones, laptops, and farm equipment over manageable monthly instalments.',
   'Smartphone','live','Reviewed in 3 to 5 days','Pay in 3 to 12 instalments','CredPal',NULL,
   ARRAY['Verified WAWUAfrica account','Valid government ID','Proof of income or 3 month bank statement'],
   ARRAY['Pay in 3 to 12 monthly instalments','No paperwork beyond your WAWU ID','Approved devices delivered to you','Build a repayment track record'],
   '[["Apply","Submit a short request through WAWUAfrica"],["Review","The partner checks your eligibility"],["Access","Collect your device and start paying"]]'::jsonb,
   'Apply now','/services/easybuy/apply'),

  (gen_random_uuid(),'pension','Pension','Micro-pension access',
   'Start a micro-pension and save towards retirement, even with irregular income.',
   'PiggyBank','live','Reviewed in 3 to 5 days','Free to start','ARM Pension',NULL,
   ARRAY['Verified WAWUAfrica account','Valid government ID'],
   ARRAY['Flexible contributions','Withdraw a portion when needed','Long term retirement savings','Professionally managed funds'],
   '[["Apply","Submit a short request through WAWUAfrica"],["Review","The partner checks your eligibility"],["Access","Get onboarded and start saving"]]'::jsonb,
   'Apply now','/services/pension/apply'),

  (gen_random_uuid(),'banking','Banking','Accounts, savings, loans and SME products',
   'Open accounts, save, and access loans and SME products built for small businesses.',
   'Landmark','live','Reviewed in 3 to 5 days','Free account opening','WEMA Bank',NULL,
   ARRAY['Verified WAWUAfrica account','Valid government ID','BVN'],
   ARRAY['Free account opening','SME focused loan products','Savings with competitive interest','Digital banking tools'],
   '[["Apply","Submit a short request through WAWUAfrica"],["Review","The partner checks your eligibility"],["Access","Get onboarded and start banking"]]'::jsonb,
   'Apply now','/services/banking/apply'),

  (gen_random_uuid(),'grants','Grants and funding','Application support and eligibility guidance',
   'Get help finding, applying for, and qualifying for grants and funding opportunities.',
   'HandCoins','live','Matched in 5 to 7 days','Free','WAWUAfrica',NULL,
   ARRAY['Verified WAWUAfrica account','A registered or registering business'],
   ARRAY['Curated grant opportunities','Application support','Eligibility guidance','Deadline reminders'],
   '[["Apply","Tell us what you are working on"],["Review","We check what you qualify for"],["Access","Receive matched opportunities and support"]]'::jsonb,
   'Apply now','/services/grants/apply')
ON CONFLICT ("slug") DO UPDATE SET
  "name"        = EXCLUDED."name",
  "tagline"     = EXCLUDED."tagline",
  "blurb"       = EXCLUDED."blurb",
  "icon"        = EXCLUDED."icon",
  "status"      = EXCLUDED."status",
  "turnaround"  = EXCLUDED."turnaround",
  "priceFrom"   = EXCLUDED."priceFrom",
  "partner"     = EXCLUDED."partner",
  "eligibility" = EXCLUDED."eligibility",
  "benefits"    = EXCLUDED."benefits",
  "steps"       = EXCLUDED."steps",
  "ctaLabel"    = EXCLUDED."ctaLabel",
  "ctaHref"     = EXCLUDED."ctaHref";

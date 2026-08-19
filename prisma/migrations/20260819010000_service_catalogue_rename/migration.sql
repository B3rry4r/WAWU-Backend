-- The catalogue is now exactly seven named services. Slugs are unchanged where
-- one already existed so live routes keep working; only the display names and
-- copy move.
--
-- Dropped as top-level services: CAC registration and NEPC (CAC now lives
-- inside Legal), Mentors (still reachable from the "free with any account"
-- rows), and Banking.

ALTER TYPE "ServiceApplicationKind" ADD VALUE IF NOT EXISTS 'loans';

DELETE FROM "PartnerService" WHERE "slug" IN ('cac', 'nepc', 'mentors', 'banking');

INSERT INTO "PartnerService"
  ("id","slug","name","tagline","blurb","icon","status","turnaround","priceFrom","partner","comingNote","eligibility","benefits","steps","ctaLabel","ctaHref")
VALUES
  (gen_random_uuid(),'legal','Legal','Filings without a lawyer, lawyers when you need one',
   'Register a business, file your tax or NDPR return with no lawyer call at all. For contracts, trademarks, royalties and entertainment law, book a consultation and get a quote.',
   'Scale','live','Consultation within days','Consultations from NGN 25,000','WAWUAfrica',NULL,
   ARRAY['A signed-in WAWU account','Supporting documents for filings'],
   ARRAY['CAC, tax and NDPR filings with no lawyer call','Contracts, trademarks and IP','Entertainment and creative law','Nothing charged until you sign'],
   '[["Choose","Pick the service you need"],["Talk or file","Simple filings go straight through; the rest start with a consultation"],["Sign and pay","Read the engagement letter, sign, then pay"]]'::jsonb,
   'Browse legal services','/services/legal'),

  (gen_random_uuid(),'loans','Loans/EasyBuy','Spread the cost over instalments',
   'Finance a phone, laptop or equipment and pay it back monthly instead of all at once.',
   'Smartphone','live','Reviewed in 3 to 5 days','Pay in 3 to 12 instalments',NULL,NULL,
   ARRAY['Verified WAWUAfrica account','Valid government ID','Proof of income or 3 month bank statement'],
   ARRAY['Pay in 3 to 12 monthly instalments','No paperwork beyond your WAWU ID','Approved items delivered to you','Build a repayment track record'],
   '[["Apply","Submit a short request through WAWUAfrica"],["Review","The partner checks your eligibility"],["Access","Collect your item and start paying"]]'::jsonb,
   'Apply now','/services/loans/apply'),

  (gen_random_uuid(),'care','Telemedicine','See a doctor, get covered',
   'Virtual consultations with licensed doctors, medication cover and screening. Built for people whose income comes in irregularly, so it is paid monthly rather than yearly.',
   'HeartPulse','live','Active same day','From NGN 600 a month','WellaHealth',NULL,
   ARRAY['A signed-in WAWU account','A Nigerian phone number','Your date of birth'],
   ARRAY['Virtual consultations with licensed doctors','Medication cover at partner pharmacies','Health screening','Paid monthly, not yearly'],
   '[["Choose","Pick a plan"],["Register","Give us the details your cover is issued against"],["Use it","Talk to a doctor whenever you need"]]'::jsonb,
   'See plans','/services/care'),

  (gen_random_uuid(),'travel','Travel and logistics','Flights, shipping and moving things',
   'Book and pay for travel, and move goods, without leaving the app.',
   'Plane','coming',NULL,NULL,NULL,'We are finishing the partner integration. It will open here first.',
   ARRAY[]::TEXT[], ARRAY[]::TEXT[], NULL, NULL, NULL),

  (gen_random_uuid(),'pay','Bills Payment','Airtime, data, electricity and cable',
   'Pay any bill without leaving WAWU. Confirm the meter or number first, pay with your card, and the top-up lands straight away.',
   'Zap','live','Instant','No added fee','Flutterwave',NULL,
   ARRAY['A signed-in WAWU account'],
   ARRAY['Airtime and data on every network','Electricity tokens','Cable and internet subscriptions','The number is confirmed before you pay'],
   '[["Choose","Pick the biller and package"],["Confirm","We check the number with the biller"],["Pay","The top-up lands straight away"]]'::jsonb,
   'Pay a bill','/services/pay'),

  (gen_random_uuid(),'grants','Grants','Application support and eligibility guidance',
   'Get help finding, applying for, and qualifying for grants and funding opportunities.',
   'HandCoins','live','Matched in 5 to 7 days','Free','WAWUAfrica',NULL,
   ARRAY['Verified WAWUAfrica account','A registered or registering business'],
   ARRAY['Curated grant opportunities','Application support','Eligibility guidance','Deadline reminders'],
   '[["Apply","Tell us what you are working on"],["Review","We check what you qualify for"],["Access","Receive matched opportunities and support"]]'::jsonb,
   'Apply now','/services/grants/apply'),

  (gen_random_uuid(),'pension','Pensions','Micro-pension access',
   'Start a micro-pension and save towards retirement, even with irregular income.',
   'PiggyBank','live','Reviewed in 3 to 5 days','Free to start','ARM Pension',NULL,
   ARRAY['Verified WAWUAfrica account','Valid government ID'],
   ARRAY['Flexible contributions','Withdraw a portion when needed','Long term retirement savings','Professionally managed funds'],
   '[["Apply","Submit a short request through WAWUAfrica"],["Review","The partner checks your eligibility"],["Access","Get onboarded and start saving"]]'::jsonb,
   'Apply now','/services/pension/apply')
ON CONFLICT ("slug") DO UPDATE SET
  "name"=EXCLUDED."name", "tagline"=EXCLUDED."tagline", "blurb"=EXCLUDED."blurb",
  "icon"=EXCLUDED."icon", "status"=EXCLUDED."status", "turnaround"=EXCLUDED."turnaround",
  "priceFrom"=EXCLUDED."priceFrom", "partner"=EXCLUDED."partner", "comingNote"=EXCLUDED."comingNote",
  "eligibility"=EXCLUDED."eligibility", "benefits"=EXCLUDED."benefits", "steps"=EXCLUDED."steps",
  "ctaLabel"=EXCLUDED."ctaLabel", "ctaHref"=EXCLUDED."ctaHref";

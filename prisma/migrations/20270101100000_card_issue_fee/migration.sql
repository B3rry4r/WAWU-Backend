-- FEE-07 (R-140, owner, 12 Nov 2026): WAWU's own fee for making a card is a fee in the dashboard's fee page, with the
-- history every fee has. Starting fee (the lead's default; an admin changes it): NGN 5,000 per card, one fixed
-- amount, so percentage 0 and minimum and maximum both 500000 kobo.
--
-- Additive only: one new row in "FeeSchedule". No table or column changes. The row is the first of its kind and is
-- inserted only while no "card_issue" row exists, so running this again adds nothing. It starts when this runs.
-- "intl_wire_in" is untouched: its rows stay and its history stays readable (R-140 point 1 stops using it).
INSERT INTO "FeeSchedule" ("id", "kind", "currency", "percentPpm", "minMinor", "maxMinor", "passThrough", "startsAt", "changedBy", "note")
SELECT gen_random_uuid()::text, 'card_issue', 'NGN', 0, 500000::bigint, 500000::bigint, false,
       (now() AT TIME ZONE 'UTC'), 'R-140 seed', 'Starting fee, R-140 point 2'
WHERE NOT EXISTS (SELECT 1 FROM "FeeSchedule" WHERE "kind" = 'card_issue');

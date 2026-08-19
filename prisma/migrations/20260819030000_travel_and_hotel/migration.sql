-- "Travel and logistics" is "Travel and hotel".
UPDATE "PartnerService"
SET "name" = 'Travel and hotel',
    "tagline" = 'Flights and places to stay',
    "blurb" = 'Book and pay for flights and hotels without leaving the app.'
WHERE "slug" = 'travel';

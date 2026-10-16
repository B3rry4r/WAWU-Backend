-- FIX-09 (owner rule R-5): no em-dash in anything a person can read.
--
-- The code no longer writes an em-dash into a ServiceApplication's status label
-- or into the first note of its timeline. Rows written before this change still
-- carry one, and the app shows both, so they are rewritten here to the wording
-- the code now writes.
--
-- Data only. No table, column, index or constraint changes, so an older
-- instance keeps working and the web and the dashboard read the same shapes.
-- Idempotent: a second run matches no row. The dash is written as chr(8212) so
-- this file does not depend on how it is read.

-- 'Submitted <dash> under review'  ->  'Submitted, under review'
UPDATE "ServiceApplication"
SET "statusLabel" = 'Submitted, under review'
WHERE "statusLabel" = 'Submitted ' || chr(8212) || ' under review';

-- '<n> name choice(s) submitted for <type> <dash> <nature>.'  ->  '... <type>: <nature>.'
-- Only the dash that follows the registration type in that one note is touched;
-- every other entry, and any text the applicant typed into the nature, is left
-- exactly as it was. The pattern stops at a colon, so once a note is rewritten
-- it no longer matches and a second run changes nothing.
UPDATE "ServiceApplication" AS sa
SET "timeline" = (
  SELECT jsonb_agg(
    CASE
      WHEN t.entry ->> 'note' ~ ('^[0-9]+ name choice\(s\) submitted for [^:' || chr(8212) || ']+ ' || chr(8212) || ' ')
      THEN jsonb_set(
        t.entry,
        '{note}',
        to_jsonb(regexp_replace(
          t.entry ->> 'note',
          '^([0-9]+ name choice\(s\) submitted for [^:' || chr(8212) || ']+) ' || chr(8212) || ' ',
          '\1: '
        ))
      )
      ELSE t.entry
    END
    ORDER BY t.position
  )
  FROM jsonb_array_elements(sa."timeline") WITH ORDINALITY AS t(entry, position)
)
WHERE jsonb_typeof(sa."timeline") = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(sa."timeline") AS e(entry)
    WHERE e.entry ->> 'note' ~ ('^[0-9]+ name choice\(s\) submitted for [^:' || chr(8212) || ']+ ' || chr(8212) || ' ')
  );

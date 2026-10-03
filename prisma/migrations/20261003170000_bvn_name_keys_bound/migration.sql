-- WALLET-14 round 2: clear BVN name keys written by the first scheme.
--
-- The first scheme hashed each word of the BVN name on its own
-- (HMAC("name:" + WORD)), so the same word gave the same hash for everyone,
-- and a reader of the database without the key could line hashes up with
-- names stored in plain text elsewhere. The code now writes
-- `{ "v": 2, "check", "first", "last" }` with every word bound to the person
-- and the check, and reads anything else as "no BVN name". This removes the
-- old values at rest. Such rows exist only on databases that ran the
-- branch's first migration (dev and test); the column is WALLET-14's own,
-- nothing else reads it, and a person's next passed BVN check writes the new
-- shape. No other column or row is touched.
--
-- Rollback: none needed (the cleared values are the ones being retired).

UPDATE "WalletIdentity"
SET "bvnNameKeys" = NULL
WHERE "bvnNameKeys" IS NOT NULL
  AND ("bvnNameKeys"->>'v') IS DISTINCT FROM '2';

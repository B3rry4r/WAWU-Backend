-- Supporting documents uploaded with a service application (CAC / NEPC).
-- Additive and nullable-by-default: existing rows get an empty array.
ALTER TABLE "ServiceApplication" ADD COLUMN "documents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

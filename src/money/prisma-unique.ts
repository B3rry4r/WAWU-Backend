/**
 * Reading Prisma's unique-constraint refusal (P2002), in ONE place.
 *
 * Which unique key a P2002 hit is not where Prisma 6 put it. Prisma 7's `pg`
 * driver adapter leaves `meta.target` unset and reports the clash under
 * `meta.driverAdapterError.cause.constraint` instead, as `fields` (the
 * column names, each in double quotes: `["\"openKey\""]`) or as `index` (the
 * constraint's name: `WalletPayment_openKey_key`). A mapping that reads only
 * `meta.target` never runs: a lost race on `WalletPayment.openKey` then
 * answered a bare "That record already exists." (MONEY-17, verifier round 2,
 * defect R2-2). `meta.target` stays as the fallback for an adapter or a
 * Prisma that still sets it.
 *
 * Every place the money code maps a P2002 goes through this file.
 */

type UniqueMeta = {
  target?: unknown;
  driverAdapterError?: {
    cause?: { constraint?: { fields?: unknown; index?: unknown } };
  };
};

/** Prisma's unique-constraint refusal (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string'
      ? [v]
      : [];

/** `"openKey"` and `` `openKey` `` read as `openKey`. */
const bare = (s: string) => s.replace(/["'`]/g, '').trim();

/**
 * The columns (or, when Prisma gives only the constraint's name, that name)
 * a P2002 names, without quotes; empty for anything else. Adapter report
 * first, `meta.target` as the fallback.
 */
export function uniqueViolationTargets(e: unknown): string[] {
  if (!isUniqueViolation(e)) return [];
  const meta = (e as { meta?: UniqueMeta }).meta;
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  const fromAdapter = [
    ...strings(constraint?.fields),
    ...strings(constraint?.index),
  ].map(bare);
  if (fromAdapter.length > 0) return fromAdapter;
  return strings(meta?.target).map(bare);
}

/**
 * Whether a P2002 is a clash on `column`: the column is one of the fields
 * named, or is inside the constraint's name (Postgres names a unique index
 * `<Table>_<column>_key`).
 */
export function isUniqueViolationOn(e: unknown, column: string): boolean {
  return uniqueViolationTargets(e).some(
    (t) => t === column || t.split('_').includes(column),
  );
}

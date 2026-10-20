/**
 * What a failed database call says about itself, safe to put in a log line
 * (task FIX-69, G-FIX-68-3).
 *
 * The release sweep used to log only the error's class name, so a connection
 * or transaction timeout (P2024, P2028) could not be told from a deadlock
 * (Postgres 40P01) or a write conflict (P2034). This names the Prisma code,
 * the Postgres SQLSTATE when the driver gave one, and the model when Prisma
 * knew it. Each part is checked against a strict shape before it is printed,
 * and the error's message, its query and its arguments are left out on
 * purpose: Prisma puts the arguments of the failed call in the message, and
 * those can hold a person's details.
 */

const PRISMA_CODE = /^P\d{4}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MODEL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type Meta = {
  modelName?: unknown;
  code?: unknown;
  driverAdapterError?: {
    cause?: { originalCode?: unknown; code?: unknown };
  };
};

const pick = (v: unknown, shape: RegExp): string | null =>
  typeof v === 'string' && shape.test(v) ? v : null;

/** The Postgres SQLSTATE of a failed call, wherever this Prisma and adapter put it. */
function sqlstateOf(meta: Meta | undefined): string | null {
  return (
    pick(meta?.driverAdapterError?.cause?.originalCode, SQLSTATE) ??
    pick(meta?.driverAdapterError?.cause?.code, SQLSTATE) ??
    pick(meta?.code, SQLSTATE)
  );
}

/**
 * For example `PrismaClientKnownRequestError, prisma P2010, postgres 40P01,
 * model CourseIntake`. Anything that is not an object answers `not an error`.
 */
export function describeDatabaseFailure(e: unknown): string {
  if (typeof e !== 'object' || e === null) return 'not an error';
  const x = e as { name?: unknown; code?: unknown; errorCode?: unknown };
  const meta = (e as { meta?: Meta }).meta;
  const parts = [pick(x.name, CLASS_NAME) ?? 'Error'];
  const code = pick(x.code, PRISMA_CODE) ?? pick(x.errorCode, PRISMA_CODE);
  if (code) parts.push(`prisma ${code}`);
  const state = sqlstateOf(meta);
  if (state) parts.push(`postgres ${state}`);
  const model = pick(meta?.modelName, MODEL);
  if (model) parts.push(`model ${model}`);
  return parts.join(', ');
}

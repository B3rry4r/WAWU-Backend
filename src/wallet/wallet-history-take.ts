import { BadRequestException } from '@nestjs/common';

/** Prisma refuses a `take` at or below this (a 64-bit integer's lowest value). */
const LOWEST_TAKE = -(2 ** 63);

/**
 * The `take` on GET /wallet/history, read the way the route always read it
 * (FIX-18): absent or empty is "not sent", and anything else is `Number(...)`.
 * The route declares `take?: string` (that is what the contract says), but a
 * repeated `take` really arrives as an array, so this takes `unknown`.
 *
 * What used to reach Prisma and answer 500 now answers 400 naming `take`: a
 * value that is not a number (`abc`), `take` sent twice (Express hands that
 * over as an array, which is `NaN` as a number), and a negative so large that
 * Prisma cannot take it (`-Infinity`, `-1e21`).
 *
 * Every other value is passed on exactly as before, including the ones that
 * look odd but never failed: a fraction (`1.5`, Prisma truncates it), a
 * negative (the last rows, reversed), a number written `1e2` or `0x10`,
 * `Infinity` (capped at 200 by the service).
 */
export function readHistoryTake(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new BadRequestException('take must be a single number.');
  }
  const take = Number(raw);
  if (Number.isNaN(take)) {
    throw new BadRequestException('take must be a single number.');
  }
  if (take <= LOWEST_TAKE) {
    throw new BadRequestException('take is out of range.');
  }
  return take;
}

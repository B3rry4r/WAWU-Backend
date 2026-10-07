import { BadRequestException } from '@nestjs/common';

/**
 * The day an ad event belongs to is the UTC calendar day of the server's clock
 * (ADS-05). One place, so recording, the read helper and the specs agree.
 */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` that is a real calendar date. */
export function isDayString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && utcDay(d) === value;
}

/** Reads a day string a caller passed, or refuses it with the API's 400. */
export function requireDay(value: string): string {
  if (!isDayString(value)) {
    throw new BadRequestException('Days are written YYYY-MM-DD.');
  }
  return value;
}

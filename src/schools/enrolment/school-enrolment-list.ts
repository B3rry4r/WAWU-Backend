import { BadRequestException } from '@nestjs/common';
import type { EnrolmentStatus } from './school-enrolment-rules';

/**
 * My courses (task SCHOOLS-09, SC8): the student's enrolments, newest first,
 * in two tabs. The rules here need no database.
 *
 * - **Current**: a held or paid place whose class has not finished.
 * - **Finished**: a paid place whose class has finished, and an enrolment
 *   whose fee went back (the class filled, or was cancelled): it is not a
 *   course the student is taking.
 * - An order that was released (a place given back unpaid) is not a course
 *   and is never listed.
 */
export const LIST_TABS = ['current', 'finished'] as const;
export type EnrolmentTab = (typeof LIST_TABS)[number];

/** The statuses a student sees in My courses. */
export const LISTED_STATUSES: readonly EnrolmentStatus[] = [
  'reserved',
  'enrolled',
  'refunded',
];

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;

const DAY_MS = 86_400_000;

/**
 * The last day of a course taught from `startDate` (YYYY-MM-DD) for `weeks`
 * weeks: the start plus `weeks` x 7 days, less the one day the start counts.
 */
export function endDateOf(startDate: string, weeks: number): string {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  return new Date(start + (Math.max(weeks, 1) * 7 - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Which tab an enrolment sits in, given today's date in Lagos (YYYY-MM-DD). */
export function tabOf(
  status: EnrolmentStatus,
  endDate: string,
  today: string,
): EnrolmentTab {
  if (status === 'refunded') return 'finished';
  return endDate < today ? 'finished' : 'current';
}

/** The position after the last row of a page: its time and id. */
export function encodeListCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify([row.createdAt.toISOString(), row.id]),
    'utf8',
  ).toString('base64url');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor this server did not give out (or altered) is a 400, never a 500. */
export function decodeListCursor(cursor: string): {
  createdAt: Date;
  id: string;
} {
  const bad = () =>
    new BadRequestException('cursor is not one this server gave out');
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !UUID_RE.test(parsed[1])
  ) {
    throw bad();
  }
  const at = new Date(parsed[0]);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== parsed[0]) throw bad();
  return { createdAt: at, id: parsed[1] };
}

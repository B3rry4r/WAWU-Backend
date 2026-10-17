import { randomInt } from 'node:crypto';
import { PAYEE_SHARE_BPS } from '../../money/payments/payment-config';

/**
 * The rules of a school enrolment that need no database (task SCHOOLS-07).
 */

export const ENROLMENT_STATUSES = [
  'reserved',
  'enrolled',
  'released',
  'refunded',
] as const;
export type EnrolmentStatus = (typeof ENROLMENT_STATUSES)[number];

/** The payment kind that pays for an enrolment (docs/contract/WALLET.md). */
export const SCHOOL_FEE_KIND = 'school_fee' as const;

/**
 * PROVISIONAL(SCHOOL-RESERVATION-MINUTES, owner=YOU, why=no ruling says how long an unpaid place is kept: the seat is claimed when the student taps Continue, so a place nobody pays for has to go back to the class)
 *
 * How long a claimed seat waits for its payment before it goes back to the
 * class: long enough to open a wallet's first top-up and type a PIN, short
 * enough that an abandoned screen does not hold the last seat for the day.
 * A payment that has started keeps the seat whatever this says. Overridable
 * with SCHOOL_RESERVATION_MINUTES (5 to 1440).
 */
export const DEFAULT_RESERVATION_MINUTES = 30;
export const RESERVATION_MINUTES_RANGE = { min: 5, max: 1440 } as const;

/**
 * PROVISIONAL(SCHOOL-MAX-OPEN-RESERVATIONS, owner=YOU, why=no ruling caps the places one student may hold unpaid; without a cap one account could hold every seat of every class for the reservation window)
 *
 * How many unpaid places one student may hold at once, across courses.
 * Overridable with SCHOOL_MAX_OPEN_RESERVATIONS (1 to 20).
 */
export const DEFAULT_MAX_OPEN_RESERVATIONS = 3;
export const MAX_OPEN_RESERVATIONS_RANGE = { min: 1, max: 20 } as const;

/** What the student reads. No em-dash, no provider name. */
export const ENROLMENT_MESSAGES = {
  notFound: 'We could not find that enrolment.',
  intakeNotFound: 'We could not find that class.',
  classFull: 'This class is full.',
  intakeClosed: 'This class has already started.',
  alreadyEnrolled: "You're already enrolled in this course.",
  tooManyOpen:
    'You already have unpaid places held. Pay for one or let it lapse before you hold another.',
  notOpen: "This class isn't open for enrolment now.",
  released: 'Your place was released. Choose a class again.',
  refunded: 'This enrolment was refunded. Choose a class again.',
  paid: "You're already enrolled in this class.",
  free: 'This course has no fee to pay.',
  confirming:
    "Your payment for this course is still being confirmed. Don't pay again.",
} as const;

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function group(): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return out;
}

/** The reference a student quotes (SC7): `WAW-` and two groups of four characters nobody mistakes for another. */
export function newEnrolmentReference(): string {
  return `WAW-${group()}-${group()}`;
}

/**
 * The 85/15 split of a course fee (R-12, the one split of R-5): the school's
 * 85% rounded down, WAWU's 15% the rest, so the two always add up to the fee.
 * Of the fee only, never of Fintava's charge on top of it (R-10).
 */
export function splitCourseFee(priceKobo: number): {
  schoolShareKobo: number;
  wawuShareKobo: number;
  commissionBps: number;
} {
  if (!Number.isSafeInteger(priceKobo) || priceKobo < 0) {
    throw new RangeError('splitCourseFee: the fee is whole kobo, 0 or more.');
  }
  const schoolShareKobo = Math.floor((priceKobo * PAYEE_SHARE_BPS) / 10_000);
  return {
    schoolShareKobo,
    wawuShareKobo: priceKobo - schoolShareKobo,
    commissionBps: 10_000 - PAYEE_SHARE_BPS,
  };
}

const LAGOS_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in Lagos as YYYY-MM-DD, the day an intake's start date is a calendar date of. */
export function lagosToday(now: Date): string {
  return LAGOS_DATE.format(now);
}

/** An intake takes enrolments up to and including the day it starts. */
export function intakeStillOpen(startDate: Date, now: Date): boolean {
  return startDate.toISOString().slice(0, 10) >= lagosToday(now);
}

export function reservedUntil(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/** A whole-number setting from the environment inside its range, else its default. */
export function integerSetting(
  raw: string | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < range.min || n > range.max) return fallback;
  return n;
}

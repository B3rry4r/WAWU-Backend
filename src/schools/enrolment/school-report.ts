import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

/**
 * The rules of the enrolment report that need no database (task SCHOOLS-09).
 *
 * The report is the one mail a school gets for an enrolment: the student's
 * name, email and phone, the course and the intake, and the time the student
 * agreed to share these details (SC4 says "the school gets these details so
 * they can follow up with you" beside Continue). The words are ours; nothing
 * is promised on the school's behalf (no follow-up time).
 */

/** Tries before a report is given up on (the rest doubles, a minute to an hour). */
export const REPORT_MAX_ATTEMPTS = 10;

/** How long one try is claimed: longer than the relay's timeout, so a second server waits for it. */
export const REPORT_LEASE_MS = 2 * 60_000;

/** Reports one pass of the sweep sends. */
export const REPORT_SWEEP_BATCH = 25;

/** A released order's copy of the student's details is cleared after this long. */
export const REPORT_UNUSED_KEEP_DAYS = 30;

/** What the student's token gives the report: nothing is read from the request body. */
export interface StudentContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** A control character, or a line or paragraph separator, becomes a space. */
function spaced(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c === 127 || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  }
  return out;
}

/** One line of plain text: no line breaks, no control characters, at most `max` characters. */
export function oneLine(text: string | null | undefined, max: number): string {
  if (typeof text !== 'string') return '';
  return spaced(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The student's name, email and phone as the sign-in token gave them. */
export function contactOf(claims: WawuJwtClaims): StudentContact {
  const name = oneLine(
    [claims.firstName, claims.middleName ?? '', claims.lastName]
      .filter((p) => typeof p === 'string' && p.trim() !== '')
      .join(' '),
    200,
  );
  const email = oneLine(claims.email, 254);
  const phone = oneLine(claims.phone, 32);
  return {
    name: name === '' ? null : name,
    email: email === '' ? null : email,
    phone: phone === '' ? null : phone,
  };
}

/** The rest before the next try after the n-th failed one: 1, 2, 4 ... 60 minutes. */
export function reportRestMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(60, 2 ** Math.min(n - 1, 6)) * 60_000;
}

/** The key the mail relay answers a repeat with the first mail for: one enrolment, one mail. */
export function reportMailKey(enrolmentId: string): string {
  return `school-report-${enrolmentId}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-11-03` as `3 November 2026`. */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const LAGOS_STAMP = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `17 October 2026, 10:15` in Lagos time. */
export function lagosStamp(at: Date): string {
  return LAGOS_STAMP.format(at).replace(' at ', ', ');
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface ReportFacts {
  schoolName: string;
  courseTitle: string;
  /** YYYY-MM-DD. */
  intakeStartDate: string;
  intakeSchedule: string;
  intakeLocation: string | null;
  reference: string;
  consentAt: Date;
  student: StudentContact;
}

export interface ReportMail {
  subject: string;
  text: string;
  html: string;
}

const NOT_GIVEN = 'not given';

/**
 * The mail. No em-dashes (a school reads it). The student's details are
 * printed as the token gave them, one line each; a missing one says so.
 */
export function reportMail(f: ReportFacts): ReportMail {
  const course = oneLine(f.courseTitle, 200);
  const when = longDay(f.intakeStartDate);
  const where = f.intakeLocation ? `, ${oneLine(f.intakeLocation, 120)}` : '';
  const lines = [
    `A student enrolled in ${course} through WAWU.`,
    `Student: ${f.student.name ?? NOT_GIVEN}`,
    `Email: ${f.student.email ?? NOT_GIVEN}`,
    `Phone: ${f.student.phone ?? NOT_GIVEN}`,
    `Course: ${course}`,
    `Intake: starts ${when} (${oneLine(f.intakeSchedule, 120)}${where})`,
    `Reference: ${f.reference}`,
    `The student agreed to share these details with ${oneLine(f.schoolName, 200)} on ${lagosStamp(f.consentAt)} (Lagos time).`,
    'Please follow up with the student directly. Quote the reference in any message about this enrolment.',
  ];
  return {
    subject: `New WAWU enrolment: ${course}, starting ${when}`,
    text: lines.join('\n'),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
  };
}

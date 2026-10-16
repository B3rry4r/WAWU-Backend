import { createHash, randomUUID } from 'node:crypto';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import type { StatementView } from './statement-view.type';

/**
 * Emailing a statement (task WALLET-35). Pure parts: who the mail may go to,
 * how the address is named back, and the mail's words.
 */

/**
 * The address a statement may be mailed to: the token's own email, and only
 * when WAWU ID says it was confirmed (`emailVerified`). A mobile sign-up
 * never confirms its email by itself, and WAWU ID holds mail back from such
 * an address for the same reason. Never an address from the request.
 */
export function provenEmailOf(claims: WawuJwtClaims): string | null {
  const flags = claims as unknown as { emailVerified?: unknown };
  if (flags.emailVerified !== true) return null;
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  const at = email.lastIndexOf('@');
  if (email.length > 254 || at < 1 || at === email.length - 1) return null;
  if (/[\s\r\n<>,;"]/.test(email)) return null;
  return email;
}

/** `a***@example.com`: the first letter and the domain. */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email[0]}***@${email.slice(at + 1)}`;
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

/** `2026-09-01` as `1 September 2026`. The day was checked before this runs. */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface StatementMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The words of the mail. Copy the canvas does not draw (listed in the task
 * file). No em-dashes: a person reads this.
 */
export function statementMail(view: StatementView): StatementMail {
  const period = `${longDay(view.from)} to ${longDay(view.to)}`;
  const movements =
    view.rowCount === 1
      ? '1 movement is listed'
      : `${view.rowCount} movements are listed`;
  const lines = [
    `Your wallet statement for ${period} is attached.`,
    `${movements}, in Lagos time.`,
    `File: ${view.fileName}`,
    'You asked for this statement in the app. If that was not you, change your password and your transaction PIN.',
  ];
  return {
    subject: `Your wallet statement, ${period}`,
    text: lines.join('\n\n'),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
  };
}

/**
 * The key WAWU ID's sender uses to answer a repeat with the first mail. The
 * app's own `Idempotency-Key` for this request (if it sent one) is hashed
 * with the person's id, so one person's key never meets another's; without
 * one every request is its own mail.
 */
export function mailIdempotencyKey(
  wawuUserId: string,
  clientKey: string | undefined,
): string {
  const key = clientKey?.trim();
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    return `stmt-${randomUUID()}`;
  return `stmt-${createHash('sha256').update(`${wawuUserId}:${key}`).digest('hex').slice(0, 48)}`;
}

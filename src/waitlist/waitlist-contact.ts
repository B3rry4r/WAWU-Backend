import { toLocalNigerianPhone } from '../wallet-provider/nigerian-phone';
import { ACCESS_CODE_LENGTH, EMAIL_MAX } from './waitlist-config';

/**
 * A phone as the registration stores it (JOIN-01). Nigerian mobiles in any of
 * the four forms (`08031234567`, `8031234567`, `2348031234567`,
 * `+2348031234567`, with spaces, dashes and brackets) become `+234...`; any
 * other number must carry its country code (`+` or `00`) and is kept in
 * E.164 (`+447700900123`). Null when it is neither.
 */
export function normalisePhone(raw: string): string | null {
  const local = toLocalNigerianPhone(raw);
  if (local !== null) return `+234${local.slice(1)}`;
  const d = raw.trim().replace(/[\s\-().]/g, '');
  const abroad = /^(?:\+|00)([1-9]\d{7,14})$/.exec(d);
  if (abroad === null) return null;
  // A 234 number that is not a valid Nigerian mobile is not kept as one.
  if (abroad[1].startsWith('234')) return null;
  return `+${abroad[1]}`;
}

/** An email as the registration stores it: trimmed and lower case. Null when it is not one. */
export function normaliseEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > EMAIL_MAX) return null;
  // One @, a dot in the domain, no spaces: the same plain test the sign-up forms apply.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e) ? e : null;
}

/** `+234 *** *** 4412`-style mask for anything that must be logged: the last 4 digits only. */
export function maskPhone(e164: string): string {
  return `***${e164.replace(/\D/g, '').slice(-4)}`;
}

/** The first word of a full name, for the pages that greet the person. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

/**
 * The launch access code as the payer reads it: "XXXX XXXX". `code` is the
 * stored 8 character, upper-case code (the database computes it from the
 * reference, see `WaitlistRegistration.accessCode`).
 */
export function accessCodeLabel(code: string): string {
  const half = ACCESS_CODE_LENGTH / 2;
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

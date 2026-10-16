import { REFERRAL_CODE_MAX, REFERRAL_CODE_MIN } from '../waitlist-config';

/**
 * A referral code as the registrations store it (REF-01): trimmed, upper case,
 * 3 to 20 letters and digits. Null when what was typed is not that shape, which
 * the routes treat exactly like a code we do not have.
 */
export function readReferralCode(raw: string): string | null {
  const t = raw.trim();
  if (t.length < REFERRAL_CODE_MIN || t.length > REFERRAL_CODE_MAX) return null;
  return /^[A-Za-z0-9]+$/.test(t) ? t.toUpperCase() : null;
}

/** Why a code that exists did not apply. */
export type ReferralNotApplied = 'full' | 'inactive';

import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { normaliseEmail, normalisePhone } from './waitlist-contact';

/**
 * The phone and email a signed-in account has PROVEN to WAWU ID, as the
 * access token states it (JOIN-03).
 *
 * The token carries the account's phone and email whether or not they were
 * proven: a mobile sign-up proves one of them (the code it sends goes to the
 * phone, or by email since AUTH-07), and a web sign-up types both. So the
 * token's `phone` and `email` alone prove nothing; the claim reads two flags
 * beside them, `phoneVerified` and `emailVerified`, and a contact counts only
 * when its flag is exactly `true`. A token without the flag (WAWU ID today
 * does not send them, BACKEND_GAPS G-629) proves nothing, so the claim
 * fails closed with `contact_not_verified` rather than trusting a typed number.
 *
 * Kept out of `src/common/auth/wawu-jwt-claims.interface.ts` (fenced): the
 * flags are read here from the verified token's payload, never from the
 * request body or a header.
 */
export interface VerifiedContacts {
  /** E.164, as a registration stores it; null when the phone is not proven. */
  phone: string | null;
  /** Lower case, as a registration stores it; null when the email is not proven. */
  email: string | null;
}

export function verifiedContactsOf(claims: WawuJwtClaims): VerifiedContacts {
  const flags = claims as unknown as {
    phoneVerified?: unknown;
    emailVerified?: unknown;
  };
  return {
    phone:
      flags.phoneVerified === true && typeof claims.phone === 'string'
        ? normalisePhone(claims.phone)
        : null,
    email:
      flags.emailVerified === true && typeof claims.email === 'string'
        ? normaliseEmail(claims.email)
        : null,
  };
}

/** Whether a proven contact is the one the registration was made with. */
export function holdsRegisteredContact(
  proven: VerifiedContacts,
  registered: { phone: string; email: string },
): boolean {
  return (
    (proven.phone !== null && proven.phone === registered.phone) ||
    (proven.email !== null && proven.email === registered.email)
  );
}

/**
 * The access code as the launch page shows it ("5F6C 15E4") read back to the
 * stored form: 8 hex digits, upper case. Null when it is not that.
 */
export function readAccessCode(raw: string): string | null {
  const compact = raw.replace(/[\s\-_.]/g, '').toUpperCase();
  return /^[0-9A-F]{8}$/.test(compact) ? compact : null;
}

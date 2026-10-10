import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { normaliseEmail, normalisePhone } from './waitlist-contact';

/**
 * The phones and the email a signed-in account has PROVEN, the only contacts a
 * claim may match a registration with (JOIN-03).
 *
 * WHAT "PROVEN" MEANS HERE, for each contact:
 *  - EMAIL: the access token's `emailVerified` is exactly `true` (WAWU ID's
 *    `email_verified`) and the token's `email` is the address.
 *  - PHONE, either of two proofs, never a number that was only typed:
 *      1. the token's `phoneVerified` is exactly `true` (WAWU ID's
 *         `phone_verified_at` is set: its sign-up code went to that phone); or
 *      2. the Hub's own `WalletIdentity` for the caller holds a `verifiedPhone`
 *         with `bvnVerifiedAt` set (the BVN check matched the BVN's phone to
 *         the account's phone, BACKEND_GAPS G-11) AND that phone is still the
 *         account's current phone (the token's `phone`), so a number the
 *         account has since given up proves nothing.
 *
 * The token carries the account's `phone` and `email` whether or not either was
 * proven: a mobile sign-up proves one (the code it sends goes to the phone, or
 * by email since AUTH-07), and a web sign-up types both. A phone that was only
 * typed can even be taken by a newer sign-up (AUTH-07). So `phone` and `email`
 * alone prove nothing: a typed phone that equals the registration's is refused
 * like any other contact that is not the caller's. A token without the flags
 * (WAWU ID today sends neither, BACKEND_GAPS G-629) proves no email and no
 * phone by the first route, so the claim fails closed rather than trusting a
 * typed number.
 *
 * Kept out of `src/common/auth/wawu-jwt-claims.interface.ts` (fenced): the
 * flags are read here from the verified token's payload, never from the
 * request body or a header.
 */
export interface VerifiedContacts {
  /** E.164, as a registration stores it; every phone the account has proven (none, one or two). */
  phones: string[];
  /** Lower case, as a registration stores it; null when the email is not proven. */
  email: string | null;
}

/** What the Hub's own wallet identity says about the caller's phone, read by the claim service. */
export interface HubPhoneProof {
  verifiedPhone: string | null;
  bvnVerifiedAt: Date | null;
}

export function verifiedContactsOf(
  claims: WawuJwtClaims,
  hub: HubPhoneProof | null = null,
): VerifiedContacts {
  const flags = claims as unknown as {
    phoneVerified?: unknown;
    emailVerified?: unknown;
  };
  const tokenPhone =
    typeof claims.phone === 'string' ? normalisePhone(claims.phone) : null;
  const phones = new Set<string>();
  if (flags.phoneVerified === true && tokenPhone !== null)
    phones.add(tokenPhone);
  if (
    hub !== null &&
    hub.bvnVerifiedAt !== null &&
    hub.verifiedPhone !== null &&
    tokenPhone !== null &&
    normalisePhone(hub.verifiedPhone) === tokenPhone
  )
    phones.add(tokenPhone);
  return {
    phones: [...phones],
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
    proven.phones.includes(registered.phone) ||
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

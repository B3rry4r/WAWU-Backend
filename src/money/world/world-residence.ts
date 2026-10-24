import { MoneyError } from '../money-error';

/**
 * Residence decides which opening a person may start (task WALLET-41 round 1; R-87, R-85), not the request and not
 * the phone. The Hub reads the country of residence stored on the account: WAWU ID's `countryCode` claim now, and
 * GEO-02's `/me/location` once it lands. A person who lives in Nigeria opens with their BVN and nothing else; a
 * world opening (no BVN) needs a stored residence that is not Nigeria, and the country the request names must be
 * it. A +234 phone says nothing here: Nigerians abroad have one.
 */
export const RESIDENCE_NOT_SET_MESSAGE =
  'Add the country you live in to your account, then try again.';
export const RESIDENCE_NIGERIA_MESSAGE =
  'Your account says you live in Nigeria, so your wallet opens with your BVN.';
export const RESIDENCE_MISMATCH_MESSAGE =
  'The country you chose is not the country on your account. Change it on your account first, then try again.';

/** The stored country of residence, ISO 3166-1 alpha-2 upper case; null when the account carries none. */
export function residenceOf(
  claims: { countryCode?: unknown } | null | undefined,
): string | null {
  const raw = claims?.countryCode;
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Refuses (409, nothing sent on) a world opening the stored residence does not allow. */
export function assertWorldResidence(
  residence: string | null,
  requested: string,
): void {
  if (residence === null) {
    throw new MoneyError('residence_not_set', RESIDENCE_NOT_SET_MESSAGE);
  }
  if (residence === 'NG') {
    throw new MoneyError('residence_mismatch', RESIDENCE_NIGERIA_MESSAGE);
  }
  if (residence !== requested) {
    throw new MoneyError('residence_mismatch', RESIDENCE_MISMATCH_MESSAGE);
  }
}

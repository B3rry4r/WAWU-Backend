/**
 * How the transfer that moves WAWU's fee on a send is named at Nuvion
 * (FIX-52, FIX-66): the send's reference plus a suffix. Pure, so the
 * handlers that book the legs and the statement reader that tells the nightly
 * check which line is a leg read the same words.
 */

/** Added to a send's reference for the transfer that moves WAWU's fee (FIX-52). */
export const FEE_LEG_SUFFIX = '-fee';

/** Added to a send's reference for the transfer that gives the fee back (FIX-66). */
export const FEE_RETURN_SUFFIX = '-fee-back';

/** The send a fee transfer's reference belongs to, or null when it is not one. */
export function sendReferenceOfFee(reference: string): string | null {
  return reference.endsWith(FEE_LEG_SUFFIX) &&
    reference.length > FEE_LEG_SUFFIX.length
    ? reference.slice(0, -FEE_LEG_SUFFIX.length)
    : null;
}

/** The send a fee-back transfer's reference belongs to, or null when it is not one. */
export function sendReferenceOfFeeBack(reference: string): string | null {
  return reference.endsWith(FEE_RETURN_SUFFIX) &&
    reference.length > FEE_RETURN_SUFFIX.length
    ? reference.slice(0, -FEE_RETURN_SUFFIX.length)
    : null;
}

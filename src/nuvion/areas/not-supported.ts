import { NuvionError } from '../nuvion-error';

/**
 * The answer of a WalletProvider method the Nuvion adapter does not perform
 * (task NUV-01): a `not_supported` failure, never a guess and never a silent
 * success. Nothing was sent to Nuvion, so nothing can have moved
 * (`recordMayExist` is false). Each area file under src/nuvion/areas/ says
 * which task (NUV-02 to NUV-08) gives its methods their Nuvion calls; a
 * method Nuvion has no equivalent for (a BVN lookup, a selfie match)
 * answers this for good, and `capabilities` says so in advance.
 */
export function nuvionNotSupported(
  operation: string,
  area: string,
): NuvionError {
  return new NuvionError({
    kind: 'not_supported',
    operation,
    messages: [`${area}: not performed by the Nuvion adapter`],
    recordMayExist: false,
  });
}

/** The same, as a rejected promise, for the async methods. */
export function rejectNotSupported<T>(
  operation: string,
  area: string,
): Promise<T> {
  return Promise.reject(nuvionNotSupported(operation, area));
}

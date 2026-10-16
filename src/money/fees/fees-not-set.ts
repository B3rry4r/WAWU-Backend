import { MoneyError } from '../money-error';

/**
 * What a person reads while the running provider's fees are not set
 * (task NUV-07, R-42). No provider name, no figure.
 */
export const FEES_NOT_SET_MESSAGE =
  'Payments are not switched on yet. Try again later.';

/**
 * `503 fees_not_set`: the running provider's charges are settings that are
 * not filled in yet, so nothing is quoted and nothing moves (R-42). Not a
 * provider failure, so no `retryAfterSeconds`: it lasts until the owner sets
 * them and the server restarts.
 */
export function feesNotSet(): MoneyError {
  return new MoneyError('fees_not_set', FEES_NOT_SET_MESSAGE);
}

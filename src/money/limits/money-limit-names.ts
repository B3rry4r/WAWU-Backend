/**
 * The three limits a movement can pass (task NUV-07), in the words the
 * `limit_reached` refusal names them with (`reason.limit`). Nuvion refuses a
 * transfer with one of the same three (`error_transfer_transaction_limit_exceeded`,
 * `error_transfer_daily_limit_exceeded`, `error_transfer_monthly_volume_exceeded`),
 * and that refusal reaches the app as the same answer.
 *
 * A leaf file with no imports: the error DTO, the seam's limit error and the
 * limits service all read it, and none of them may import another.
 */
export const MONEY_LIMIT_NAMES = [
  'per_transaction',
  'daily',
  'monthly',
] as const;
export type MoneyLimitName = (typeof MONEY_LIMIT_NAMES)[number];

import { nairaText } from '../insufficient-funds';
import { MoneyError } from '../money-error';
import type { MoneyLimitName } from './money-limit-names';

/**
 * What a person reads when a movement passes a limit (task NUV-07), one
 * sentence per limit. The same sentence whether WAWU's own setting stopped it
 * before anything was sent or the provider refused it with its own limit, so
 * the app never tells the two apart: it switches on `reason.limit`.
 */
export const LIMIT_REACHED_MESSAGES: Readonly<Record<MoneyLimitName, string>> =
  {
    per_transaction:
      'This is more than one transaction can be. Try a smaller amount.',
    daily:
      "This would pass today's limit. Try a smaller amount, or try again tomorrow.",
    monthly:
      "This would pass this month's limit. Try a smaller amount, or try again next month.",
  };

/** `403 limit_reached`, naming the limit. Nothing has moved when it is thrown. */
export function limitReached(limit: MoneyLimitName): MoneyError {
  return new MoneyError('limit_reached', LIMIT_REACHED_MESSAGES[limit], {
    limit,
  });
}

/**
 * `403 limit_reached` for the limit the wallet provider puts on the account
 * for a day (task WALLET-23). It names the limit (`limit: daily`) and shows
 * it, in the sentence and in `limitKobo`, with what is left of it today in
 * `remainingTodayKobo`. Nothing has moved when it is thrown.
 */
export function accountLimitReached(
  limitKobo: number,
  remainingKobo: number,
): MoneyError {
  const left =
    remainingKobo > 0
      ? `You can still move ${nairaText(remainingKobo)} today.`
      : 'Try again tomorrow.';
  return new MoneyError(
    'limit_reached',
    `This would pass your daily limit of ${nairaText(limitKobo)}. ${left}`,
    { limit: 'daily', limitKobo, remainingTodayKobo: remainingKobo },
  );
}

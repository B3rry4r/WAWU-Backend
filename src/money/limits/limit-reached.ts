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

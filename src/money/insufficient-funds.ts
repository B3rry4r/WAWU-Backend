import { MoneyError } from './money-error';

/**
 * "Not enough in your wallet", said one way on every route that takes money
 * from a wallet (task MONEY-19: H17, I6, S11, W13).
 *
 * The answer is `402 insufficient_funds` with three figures in `reason`:
 * `balanceKobo` (the wallet provider's available balance, read for this
 * request, never a sum of our own records), `totalKobo` (what the movement
 * needs: the amount plus every fee the person pays, R-10) and `shortfallKobo`
 * (`totalKobo` minus `balanceKobo`, what to add before trying again). The
 * shortfall is therefore never 0 or below: the helpers refuse to build an
 * answer that would show "₦0.00 more" (a refusal is only made for a total the
 * balance does not cover).
 *
 * A route throws the error from `insufficientFunds`, or from
 * `insufficientAfterProviderRefusal` when the provider itself refused for
 * funds after our own read said there was enough. Nothing here reads a
 * balance or calls a provider.
 */

/** The provider refused for funds although a fresh balance read covers the total (lead ruling D3). */
export const BALANCE_CHANGED_MESSAGE =
  'Your balance changed. Check it and try again.';

/** ₦1,323.25 from 132325, integer arithmetic only (no float, no locale). */
export function nairaText(kobo: number): string {
  const naira = Math.floor(kobo / 100);
  const rest = String(kobo % 100).padStart(2, '0');
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${grouped}.${rest}`;
}

/** "You need ₦523.25 more in your wallet." */
export function shortfallMessage(shortfallKobo: number): string {
  return `You need ${nairaText(shortfallKobo)} more in your wallet.`;
}

/**
 * The balance is below the total: how much short, as figures and as a
 * sentence. `balanceKobo` and `totalKobo` are whole kobo, the balance below
 * the total (a provider that reports a negative balance is shown as it is).
 */
export function insufficientFunds(
  balanceKobo: number,
  totalKobo: number,
): MoneyError {
  if (
    !Number.isSafeInteger(balanceKobo) ||
    !Number.isSafeInteger(totalKobo) ||
    balanceKobo >= totalKobo
  ) {
    throw new RangeError(
      'insufficientFunds: the balance must be a whole number of kobo below the total.',
    );
  }
  const shortfallKobo = totalKobo - balanceKobo;
  return new MoneyError('insufficient_funds', shortfallMessage(shortfallKobo), {
    balanceKobo,
    totalKobo,
    shortfallKobo,
  });
}

/**
 * The provider refused for funds after our read said there was enough (lead
 * ruling D3): a real shortfall on a fresh read is shown; otherwise the
 * balance moved or the provider took more than quoted, and nothing below 1
 * kobo is ever shown as a shortfall.
 */
export function insufficientAfterProviderRefusal(
  freshBalanceKobo: number | null,
  totalKobo: number,
): MoneyError {
  if (freshBalanceKobo !== null && freshBalanceKobo < totalKobo) {
    return insufficientFunds(freshBalanceKobo, totalKobo);
  }
  return new MoneyError('insufficient_funds', BALANCE_CHANGED_MESSAGE, {
    ...(freshBalanceKobo === null ? {} : { balanceKobo: freshBalanceKobo }),
    totalKobo,
  });
}

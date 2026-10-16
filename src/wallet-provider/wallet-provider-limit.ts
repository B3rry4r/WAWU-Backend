import type { HttpException } from '@nestjs/common';
import { limitReached } from '../money/limits/limit-reached';
import {
  MONEY_LIMIT_NAMES,
  type MoneyLimitName,
} from '../money/limits/money-limit-names';
import { WalletProviderError } from './wallet-provider-error';
import type { WalletProviderName } from './wallet-provider.interface';

/**
 * A provider's refusal because a movement passes one of the provider's own
 * limits (task NUV-07). Nuvion refuses a transfer with
 * `error_transfer_transaction_limit_exceeded`, `error_transfer_daily_limit_exceeded`
 * or `error_transfer_monthly_volume_exceeded` (its errors page; no values are
 * published), and WAWU answers each exactly as it answers its own limit:
 * `403 limit_reached` naming the limit (src/money/limits/).
 *
 * It is a `WalletProviderError` of kind `refused` with nothing moved
 * (`recordMayExist` false: the provider refused the request, so the send is
 * failed, never "pending, reconcile"), and its `toHttpException()` is the
 * `limit_reached` answer, so a service that answers a provider failure with
 * `error.toHttpException()` needs no code of its own for it.
 *
 * A separate file, beside the seam's error rather than inside it, so the seam
 * file itself is unchanged.
 */
export class WalletProviderLimitError extends WalletProviderError {
  readonly limit: MoneyLimitName;

  constructor(args: {
    provider: WalletProviderName;
    operation: string;
    limit: MoneyLimitName;
    httpStatus?: number | null;
    messages?: string[];
    reference?: string | null;
  }) {
    super({
      kind: 'refused',
      provider: args.provider,
      operation: args.operation,
      httpStatus: args.httpStatus,
      messages: args.messages,
      reference: args.reference,
      recordMayExist: false,
    });
    this.name = 'WalletProviderLimitError';
    this.limit = args.limit;
  }

  /** `403 limit_reached` naming the limit, the same answer as WAWU's own limit. */
  override toHttpException(): HttpException {
    return limitReached(this.limit);
  }
}

/**
 * Each provider's own limit errors, by the error type it answers with, and
 * the limit each one is. Fintava reports no limit by a type of its own.
 * Nuvion's three are from its errors page (docs.nuvion.co/errors, saved in
 * the lead's scratchpad `nuvion/docs/errors.md`).
 */
export const PROVIDER_LIMIT_ERROR_TYPES: Readonly<
  Record<WalletProviderName, Readonly<Record<string, MoneyLimitName>>>
> = {
  fintava: {},
  nuvion: {
    error_transfer_transaction_limit_exceeded: 'per_transaction',
    error_transfer_daily_limit_exceeded: 'daily',
    error_transfer_monthly_volume_exceeded: 'monthly',
  },
};

/**
 * The limit a provider's error type is, or null when it is not one of the
 * provider's limit errors. Own keys only: `toString` or `constructor` is
 * never a limit.
 */
export function providerLimitOf(
  provider: WalletProviderName,
  errorType: string,
): MoneyLimitName | null {
  const table = PROVIDER_LIMIT_ERROR_TYPES[provider];
  if (!Object.prototype.hasOwnProperty.call(table, errorType)) return null;
  const limit = table[errorType];
  return MONEY_LIMIT_NAMES.includes(limit) ? limit : null;
}

/**
 * For an adapter's error mapping: the `WalletProviderLimitError` for this
 * error type, or null when the type is not a limit (the adapter then maps it
 * as it maps any other). The Nuvion adapter's error mapping
 * (src/nuvion/nuvion-error.ts, task NUV-01) asks this first.
 */
export function providerLimitError(
  provider: WalletProviderName,
  errorType: string,
  args: {
    operation: string;
    httpStatus?: number | null;
    messages?: string[];
    reference?: string | null;
  },
): WalletProviderLimitError | null {
  const limit = providerLimitOf(provider, errorType);
  return limit === null
    ? null
    : new WalletProviderLimitError({ provider, limit, ...args });
}

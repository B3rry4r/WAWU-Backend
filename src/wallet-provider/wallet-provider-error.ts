import {
  ConflictException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MoneyError } from '../money/money-error';
import type { WalletProviderName } from './wallet-provider.interface';

/**
 * Every way a wallet provider call can fail, in neutral words (MONEY-20).
 * An adapter maps its provider's failures onto these; a service decides
 * on the kind alone and never sees a provider's error type. The first
 * seventeen are the kinds the Fintava client already told apart (MONEY-06),
 * kept word for word so nothing a service does on them changes.
 */
export const WALLET_PROVIDER_ERROR_KINDS = [
  /** No key or no base URL in config: nothing was sent. */
  'not_configured',
  /** The key is missing or wrong. */
  'auth',
  /** WAWU's own account at the provider is not active. */
  'merchant_inactive',
  /** The provider refused our request body. */
  'validation',
  'insufficient_funds',
  /** A frozen or inactive sender or receiver. */
  'wallet_inactive',
  /** Our reference was used before: money may have moved; reconcile. */
  'duplicate_reference',
  'not_found',
  'below_minimum',
  /** An identity check said no. */
  'identity_refused',
  /**
   * An identity check is with the provider's compliance review: not a
   * refusal of the person and nothing to correct. Wait for the provider's
   * decision; never send the details again meanwhile (NUV-01, lead ruling 4).
   */
  'under_review',
  /** The provider will not pay out right now. */
  'payouts_blocked',
  /** A 2xx on a write without the expected data in it: not proof either way. */
  'not_confirmed',
  /** Any other refusal. */
  'refused',
  'rate_limited',
  /** A read that did not work: safe to try again. */
  'unavailable',
  /** A write whose answer was lost: reconcile first. */
  'outcome_unknown',
  /** An answer we could not read on a read call. */
  'bad_response',
  /** The provider has no such operation (`capabilities` says so ahead). */
  'not_supported',
] as const;
export type WalletProviderErrorKind =
  (typeof WALLET_PROVIDER_ERROR_KINDS)[number];

/**
 * The kinds after which a write may have happened: the caller treats each
 * as "pending, reconcile", never as a failure to refund or retry blindly.
 */
export const WALLET_PROVIDER_UNKNOWN_OUTCOMES: readonly WalletProviderErrorKind[] =
  ['outcome_unknown', 'not_confirmed', 'duplicate_reference'];

/** The default wait a refusal tells the app, when the provider gives none. */
export const DEFAULT_PROVIDER_RETRY_AFTER_SECONDS = 30;

/**
 * A failed provider call. Like the provider errors it replaces, it carries
 * no request or response body and no header: `messages` are the provider's
 * texts already masked by the adapter, so it can be logged as it is.
 */
export class WalletProviderError extends Error {
  readonly kind: WalletProviderErrorKind;
  readonly provider: WalletProviderName;
  readonly operation: string;
  /** HTTP status, or null when no answer came back. */
  readonly httpStatus: number | null;
  readonly messages: string[];
  /** Our reference, on a send that carried one. */
  readonly reference: string | null;
  /**
   * True when money may have moved or a record may exist although the call
   * failed. A caller never refunds or charges again while this is true.
   */
  readonly recordMayExist: boolean;
  /** What a refusal built from this error tells the app to wait. */
  readonly retryAfterSeconds: number;

  constructor(args: {
    kind: WalletProviderErrorKind;
    provider: WalletProviderName;
    operation: string;
    httpStatus?: number | null;
    messages?: string[];
    reference?: string | null;
    recordMayExist?: boolean;
    retryAfterSeconds?: number;
  }) {
    const status = args.httpStatus ?? null;
    super(
      `${args.provider} ${args.operation} failed: ${args.kind}` +
        (status === null ? '' : ` (HTTP ${status})`),
    );
    this.name = 'WalletProviderError';
    this.kind = args.kind;
    this.provider = args.provider;
    this.operation = args.operation;
    this.httpStatus = status;
    this.messages = args.messages ?? [];
    this.reference = args.reference ?? null;
    this.recordMayExist =
      args.recordMayExist ??
      WALLET_PROVIDER_UNKNOWN_OUTCOMES.includes(args.kind);
    this.retryAfterSeconds =
      args.retryAfterSeconds ?? DEFAULT_PROVIDER_RETRY_AFTER_SECONDS;
  }

  /** The error in this backend's own shape, for a route to throw. */
  toHttpException(detail: { retryAfterSeconds?: number } = {}): HttpException {
    return walletProviderErrorToHttp(this.kind, {
      retryAfterSeconds: detail.retryAfterSeconds ?? this.retryAfterSeconds,
    });
  }
}

/**
 * A provider failure as the error a route answers with (docs/contract/
 * CONVENTIONS.md section 3). Money conditions use the money envelope
 * (`MoneyError`, with `reason.code`); an identity refusal is a plain 422.
 * Messages are plain sentences: no provider name, no provider text, no
 * em-dash. The Fintava error's own mapping (`fintavaErrorToHttp`) is this
 * one, so the two never drift.
 */
export function walletProviderErrorToHttp(
  kind: string,
  detail: { retryAfterSeconds?: number } = {},
): HttpException {
  const retryAfterSeconds =
    detail.retryAfterSeconds ?? DEFAULT_PROVIDER_RETRY_AFTER_SECONDS;
  switch (kind) {
    case 'insufficient_funds':
      return new MoneyError(
        'insufficient_funds',
        'There is not enough money in the wallet for this.',
      );
    case 'wallet_inactive':
      return new MoneyError(
        'wallet_frozen',
        'This wallet cannot send or receive money right now.',
      );
    case 'not_found':
      return new MoneyError('not_found', 'We could not find that.');
    case 'below_minimum':
      return new MoneyError(
        'amount_out_of_range',
        'That amount is below the minimum.',
      );
    case 'identity_refused':
      return new UnprocessableEntityException(
        'We could not confirm those identity details.',
      );
    case 'under_review':
      // Default (agent), owner may override: a plain 409 like the plain
      // 422 above, so no money reason code is added to the contract.
      return new ConflictException(
        'Your details are being reviewed. We will let you know when the review is done.',
      );
    case 'outcome_unknown':
    case 'not_confirmed':
    case 'duplicate_reference':
      return new MoneyError(
        'provider_unreachable',
        'We are still confirming this payment. Check your history before you try again.',
        { retryAfterSeconds },
      );
    default:
      return new MoneyError(
        'provider_unreachable',
        'Payments are not available right now. Try again in a moment.',
        { retryAfterSeconds },
      );
  }
}

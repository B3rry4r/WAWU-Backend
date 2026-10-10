import { HttpException } from '@nestjs/common';

/**
 * The refusals of the bill catalogue routes, in the Hub's one error shape (docs/contract/CONVENTIONS.md section 3):
 * `{ statusCode, message, data: null, reason: { code, message, ... } }`. The app switches on `reason.code`. `message`
 * is a sentence the app may show: no em-dash, no provider name, nothing the caller sent.
 */
export const BILLS_ERROR_STATUS = {
  /** The company is not on the list now (unknown code, or no longer available). */
  biller_not_found: 404,
  /** Fintava does not know this meter for this company (S10). */
  meter_not_found: 422,
  /** Fintava's bills service cannot be used at all: S13. */
  bills_unavailable: 503,
  /** Fintava did not answer, or answered something unreadable. */
  provider_unreachable: 503,
  /** The person has asked for their meter check too often. */
  bills_rate_limited: 429,
} as const;

export type BillsErrorCode = keyof typeof BILLS_ERROR_STATUS;

export interface BillsErrorReason {
  code: BillsErrorCode;
  message: string;
  /** With `provider_unreachable` and `bills_rate_limited`: whole seconds to wait. */
  retryAfterSeconds?: number;
}

export class BillsError extends HttpException {
  readonly code: BillsErrorCode;

  constructor(
    code: BillsErrorCode,
    message: string,
    detail: { retryAfterSeconds?: number } = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      BILLS_ERROR_STATUS[code],
    );
    this.code = code;
  }
}

/** How long the app waits before it asks again after Fintava did not answer. */
export const BILLS_RETRY_AFTER_SECONDS = 30;

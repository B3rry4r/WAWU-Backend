import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Why a claim was refused (task REF-02). The body is the contract's one error
 * shape, `{ statusCode, message, data: null, reason: { code, message, ... } }`
 * (docs/contract/CONVENTIONS.md section 3); the app switches on `reason.code`.
 * The messages are plain sentences with no em-dash.
 */
export type ReferralErrorCode =
  /** No one has that code. */
  | 'referral_code_unknown'
  /** The code is the caller's own. */
  | 'referral_own_code'
  /** The caller already used a code (a different one from this). */
  | 'referral_already_claimed'
  /** The caller signed up longer ago than the setting's days. */
  | 'referral_claim_closed'
  /** The caller has already paid for a tier: they are not new. */
  | 'referral_not_new'
  /** The code's owner was invited by the caller. */
  | 'referral_loop';

export const REFERRAL_ERROR_STATUS: Record<ReferralErrorCode, HttpStatus> = {
  referral_code_unknown: HttpStatus.NOT_FOUND,
  referral_own_code: HttpStatus.BAD_REQUEST,
  referral_already_claimed: HttpStatus.CONFLICT,
  referral_claim_closed: HttpStatus.CONFLICT,
  referral_not_new: HttpStatus.CONFLICT,
  referral_loop: HttpStatus.CONFLICT,
};

export interface ReferralErrorDetail {
  /** For `referral_claim_closed`: the days after sign-up a code can be used. */
  claimDays?: number;
}

export class ReferralError extends HttpException {
  readonly code: ReferralErrorCode;

  constructor(
    code: ReferralErrorCode,
    message: string,
    detail: ReferralErrorDetail = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      REFERRAL_ERROR_STATUS[code],
    );
    this.code = code;
  }
}

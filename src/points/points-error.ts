import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Why the points service refused (task POINTS-01). The routes that spend or
 * grant points (POINTS-02 to POINTS-04, TIER-03, REF-01) let these through as
 * they are: the body is the contract's one error shape, `{ statusCode,
 * message, data: null, reason: { code, message, ...detail } }`, which
 * AllExceptionsFilter carries through untouched (docs/contract/CONVENTIONS.md
 * section 3).
 */
export type PointsErrorCode =
  /** The person's live lots hold fewer points than asked; nothing changed. */
  | 'insufficient_points'
  /** The grant's source and reference were used for another person or amount. */
  | 'points_grant_conflict'
  /** The hold's purpose and reference were used for another person or amount. */
  | 'points_hold_conflict'
  /** No hold has that id, or that purpose and reference. */
  | 'points_hold_not_found'
  /** The hold already ended the other way (spent, or given back). */
  | 'points_hold_settled'
  /** Points that are not a whole number above zero, an end in the past, a bad reference. */
  | 'points_invalid';

export const POINTS_ERROR_STATUS: Record<PointsErrorCode, HttpStatus> = {
  insufficient_points: HttpStatus.PAYMENT_REQUIRED,
  points_grant_conflict: HttpStatus.CONFLICT,
  points_hold_conflict: HttpStatus.CONFLICT,
  points_hold_not_found: HttpStatus.NOT_FOUND,
  points_hold_settled: HttpStatus.CONFLICT,
  points_invalid: HttpStatus.BAD_REQUEST,
};

/**
 * Detail a refusal may carry. Every figure is a count of points, never naira
 * or dollars, and each field name ends in `Points` so nobody takes it for
 * money.
 */
export interface PointsErrorDetail {
  balancePoints?: number;
  neededPoints?: number;
  shortfallPoints?: number;
}

export class PointsError extends HttpException {
  readonly code: PointsErrorCode;
  readonly detail: PointsErrorDetail;

  constructor(
    code: PointsErrorCode,
    message: string,
    detail: PointsErrorDetail = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      POINTS_ERROR_STATUS[code],
    );
    this.code = code;
    this.detail = detail;
  }
}

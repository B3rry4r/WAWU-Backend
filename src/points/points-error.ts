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
  | 'points_invalid'
  /** A cap stops the job (POINTS-03, PT7): the day's limit, or too long a job. Nothing is held. */
  | 'points_cap_reached'
  /** The person has enough points for the job, so there is no shortfall to buy (POINTS-03). */
  | 'points_not_short'
  /** The points asked to turn into cash are more than the person's earned and bonus points: points they bought cannot be cashed out (R-101). */
  | 'points_not_cashable';

export const POINTS_ERROR_STATUS: Record<PointsErrorCode, HttpStatus> = {
  insufficient_points: HttpStatus.PAYMENT_REQUIRED,
  points_grant_conflict: HttpStatus.CONFLICT,
  points_hold_conflict: HttpStatus.CONFLICT,
  points_hold_not_found: HttpStatus.NOT_FOUND,
  points_hold_settled: HttpStatus.CONFLICT,
  points_invalid: HttpStatus.BAD_REQUEST,
  points_cap_reached: HttpStatus.UNPROCESSABLE_ENTITY,
  points_not_short: HttpStatus.CONFLICT,
  points_not_cashable: HttpStatus.UNPROCESSABLE_ENTITY,
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
  /** `points_not_cashable`: the points the person can turn into cash now (earned and bonus points that have not ended). */
  cashablePoints?: number;
  /** `points_cap_reached`: which cap stopped the job (`daily`, `characters_per_job`, `minutes_per_job`). */
  cap?: string;
  /** `points_cap_reached`: the cap's size, in the unit it counts (points, characters or minutes). */
  capLimit?: number;
  /** `points_cap_reached`: what the cap counts (`points`, `characters` or `minutes`). */
  capUnit?: string;
  /** `points_cap_reached`, daily cap: points already spent or held today. */
  usedPoints?: number;
  /** `points_cap_reached`, daily cap: points still free today (0 or more). */
  remainingPoints?: number;
  /** `points_cap_reached`, daily cap: when the day's count starts again (ISO time); null for a cap that never resets. */
  resetsAt?: string | null;
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

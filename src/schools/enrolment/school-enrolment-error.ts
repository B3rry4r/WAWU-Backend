import { HttpException } from '@nestjs/common';
import type { PublicIntakeView } from '../schools-public.views';

export const ENROLMENT_ERROR_STATUS = {
  /** The class has no seat left; `nextIntake` is the soonest class of the course that has one. */
  class_full: 409,
  /** The class has started; nobody enrols in it now. */
  intake_closed: 409,
  /** The student is enrolled in this course already (`enrolmentId`). */
  already_enrolled: 409,
  /** The student holds as many unpaid places as one student may. */
  reservation_limit: 409,
} as const;
export type EnrolmentErrorCode = keyof typeof ENROLMENT_ERROR_STATUS;

/** What a refusal may carry beside its code and message. */
export interface EnrolmentErrorDetail {
  nextIntake?: PublicIntakeView | null;
  enrolmentId?: string;
}

/**
 * A refusal from the enrolment routes, in the contract's one error shape
 * (docs/contract/CONVENTIONS.md section 3): `{ statusCode, message, data:
 * null, reason: { code, message, ...detail } }`. The message is a sentence
 * the app may show as it is.
 */
export class SchoolEnrolmentError extends HttpException {
  readonly code: EnrolmentErrorCode;

  constructor(
    code: EnrolmentErrorCode,
    message: string,
    detail: EnrolmentErrorDetail = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      ENROLMENT_ERROR_STATUS[code],
    );
    this.code = code;
  }
}

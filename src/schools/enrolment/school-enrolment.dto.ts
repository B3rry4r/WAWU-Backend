import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import type { PublicIntakeView } from '../schools-public.views';
import {
  ENROLMENT_ERROR_STATUS,
  type EnrolmentErrorCode,
} from './school-enrolment-error';

/** POST /schools/enrolments: the class the student picked (SC4's "Pick a class"). */
export class EnrolDto {
  /** The intake to hold a place in. The course and school come from it. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  intakeId!: string;
}

/** What a refused enrolment says beside its code (the contract's one error shape, CONVENTIONS section 3). */
export class SchoolEnrolmentErrorReason {
  @ApiProperty({ enum: Object.keys(ENROLMENT_ERROR_STATUS) })
  code!: EnrolmentErrorCode;

  /** A sentence the app may show as it is. */
  message!: string;

  /** class_full: the soonest other class of the course that has a seat and has not started; null when there is none (SC11). */
  @ApiPropertyOptional({
    nullable: true,
    allOf: [{ $ref: getSchemaPath('PublicIntakeView') }],
  })
  nextIntake?: PublicIntakeView | null;

  /** already_enrolled: the enrolment the student already has in this course. */
  @ApiPropertyOptional({ format: 'uuid' })
  enrolmentId?: string;
}

/** The body of a refused enrolment request. */
export class SchoolEnrolmentErrorEnvelope {
  /** The HTTP status again. */
  statusCode!: number;

  /** Same as reason.message. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;

  reason!: SchoolEnrolmentErrorReason;
}

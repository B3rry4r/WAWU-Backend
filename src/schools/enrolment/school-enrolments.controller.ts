import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { PlainObjectBodyPipe } from '../plain-object-body.pipe';
import { EnrolDto, SchoolEnrolmentErrorEnvelope } from './school-enrolment.dto';
import type { SchoolEnrolmentView } from './school-enrolment-view.type';
import { SchoolEnrolmentService } from './school-enrolment.service';

/**
 * Enrol in a course (task SCHOOLS-07, SC4 to SC7 and SC11). The fee is paid
 * with MONEY-17's `GET /money/payments/quote` and `POST /money/payments`
 * (kind `school_fee`, the enrolment's id as `targetId`), so the quote, the
 * PIN, the Idempotency-Key and the wallet gate are the ones every payment
 * has. The routes sit under `schools/enrolments`, a path of their own beside
 * the public `schools/:id` routes.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('schools/enrolments')
export class SchoolEnrolmentsController {
  constructor(private readonly enrolments: SchoolEnrolmentService) {}

  /**
   * SC4 Continue: holds a place in the class the student picked and answers
   * the order (the course, school and class, the fee that will be asked for,
   * and `reservedUntil`, when the place goes back to the class if it is not
   * paid). Pay it with `POST /money/payments`. The same request again answers
   * the same order and keeps the place a while longer; asking for another
   * class of the same course moves the place. A class with no seat left is
   * `409 reason.code class_full` with `reason.nextIntake`, the soonest other
   * class of the course that has a seat (SC11), or null; a class that has
   * started is `409 intake_closed`; a student already enrolled in the course
   * is `409 already_enrolled` with `reason.enrolmentId`; a student holding
   * too many unpaid places is `409 reservation_limit`. An unknown or hidden
   * class is 404. A course with no fee enrols at once (`status enrolled`,
   * nothing to pay).
   */
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 409,
    description:
      'reason.code class_full (reason.nextIntake), intake_closed, already_enrolled (reason.enrolmentId), reservation_limit, or payment_in_progress (reason.paymentId) when the place being moved already has a payment started.',
    type: SchoolEnrolmentErrorEnvelope,
  })
  enrol(
    @CurrentUser() user: WawuJwtClaims,
    @Body(PlainObjectBodyPipe) dto: EnrolDto,
  ): Promise<SchoolEnrolmentView> {
    return this.enrolments.enrol(user.sub, dto);
  }

  /**
   * One enrolment as it stands now: what the app polls after a payment, and
   * SC7's receipt (the course, class, fee and what the wallet was actually
   * debited). Only its student reads it; another person's and an id nobody
   * holds are the same 404. It reads our own records only.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SchoolEnrolmentView> {
    return this.enrolments.read(user.sub, id);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminKeyGuard } from '../common/guards/admin-key.guard';
import { HealthPlanService } from './health-plan.service';
import { RecordCareRefundDto } from './dto/health-plan.dto';

/**
 * WAWUCare — the operator half.
 *
 * The buyer is told "our team will sort this out or refund you" when
 * enrolment fails after payment. Neither half of that sentence had an
 * implementation: nothing could re-attempt the enrolment and
 * `FulfilmentStatus.refunded` had no writer.
 *
 * FOLLOW-UP: AdminKeyGuard is the interim shared-key idiom (see the guard).
 */
@UseGuards(AdminKeyGuard)
@Controller('care/ops')
export class HealthPlanOpsController {
  constructor(private readonly care: HealthPlanService) {}

  /** Everyone who has paid for cover and does not have it. */
  @Get('subscriptions/stuck')
  stuck() {
    return this.care.listStuck();
  }

  /** "Sort this out": ask WellaHealth for the same enrolment again. */
  @Post('subscriptions/:id/retry-enrolment')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.care.retryEnrolment(id);
  }

  /** "Or refund you": record a refund a human has already sent. */
  @Post('subscriptions/:id/record-refund')
  @HttpCode(HttpStatus.OK)
  recordRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordCareRefundDto,
  ) {
    return this.care.recordRefund(id, dto);
  }
}

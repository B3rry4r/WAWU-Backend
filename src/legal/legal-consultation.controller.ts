import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { LegalConsultationService } from './legal-consultation.service';
import { LegalDeliverablesService } from './legal-deliverables.service';
import {
  BookConsultationSlotDto,
  ConsultationSlotsQueryDto,
} from './dto/legal-consultation.dto';
import type {
  ConsultationBookingView,
  ConsultationOptionsView,
  ConsultationSlotsView,
  LegalDeliverablesView,
} from './legal-consultation.types';

/**
 * Booking a consultation and reading what was delivered (LEGAL-03, S18 to
 * S26). New routes beside `/legal/requests/*`: the web's routes answer exactly
 * as before, and money here is kobo.
 *
 * Paying for the booked hour is LEGAL-05.
 */
@UseGuards(WawuAuthGuard)
@Controller('legal')
export class LegalConsultationController {
  constructor(
    private readonly consultation: LegalConsultationService,
    private readonly deliverables: LegalDeliverablesService,
  ) {}

  /** The kinds of consultation WAWU has priced and switched on. */
  @Get('consultation/options')
  options(): Promise<ConsultationOptionsView> {
    return this.consultation.options();
  }

  /** The calendar for a video or phone call, at that call's length. */
  @Get('consultation/slots')
  slots(
    @Query() query: ConsultationSlotsQueryDto,
  ): Promise<ConsultationSlotsView> {
    return this.consultation.slots(query.medium);
  }

  /** Holds the picked hour on the person's request (nothing is charged yet). */
  @Post('requests/:id/booking')
  @HttpCode(HttpStatus.OK)
  book(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BookConsultationSlotDto,
  ): Promise<ConsultationBookingView> {
    return this.consultation.book(user.sub, id, dto);
  }

  @Get('requests/:id/booking')
  booking(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsultationBookingView> {
    return this.consultation.getBooking(user.sub, id);
  }

  /** Every file delivered on the person's request. */
  @Get('requests/:id/deliverables')
  delivered(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LegalDeliverablesView> {
    return this.deliverables.list(user.sub, id);
  }
}

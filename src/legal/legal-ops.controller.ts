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
import { AdminKeyGuard } from '../common/guards/admin-key.guard';
import { LegalRequestsService } from './legal.service';
import {
  CancelLegalRequestDto,
  CompleteConsultationDto,
  DeliverLegalRequestDto,
  ListLegalRequestsQueryDto,
  QuoteLegalRequestDto,
} from './dto/legal.dto';

/**
 * WAWU Legal — the operator half of the lifecycle.
 *
 * Every transition the client cannot make themselves used to have no caller
 * at all. `quote()` existed on the service and no route reached it, so an
 * `awaiting_quote` request could never be priced; `consultation_scheduled`
 * was terminal after a ₦25,000–₦45,000 fee had already been taken; and
 * `in_progress` — fully-paid legal work — had no exit, with `delivered`,
 * `cancelled`, `consultation_done` and `deliverableUrl` all unwritten by any
 * code path. These are those transitions.
 *
 * Separate controller because LegalController carries a class-level
 * `@UseGuards(WawuAuthGuard)`: these are server-to-server ops calls holding
 * the shared operator key, not a client's token. New paths only — nothing on
 * `/legal/requests/...` moves.
 *
 * FOLLOW-UP: AdminKeyGuard is the interim shared-key idiom (see the guard's
 * own comment — it fails closed when WAWU_ADMIN_KEY is unset). A real admin
 * identity exists on another branch; these routes should move onto it when it
 * lands.
 */
@UseGuards(AdminKeyGuard)
@Controller('legal/ops')
export class LegalOpsController {
  constructor(private readonly legal: LegalRequestsService) {}

  /** The work queue. Without it an operator cannot find what needs pricing. */
  @Get('requests')
  list(@Query() query: ListLegalRequestsQueryDto) {
    return this.legal.listForOps(query.status);
  }

  /** Prices the work. The only writer of `quoted`. */
  @Post('requests/:id/quote')
  @HttpCode(HttpStatus.OK)
  quote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuoteLegalRequestDto,
  ) {
    return this.legal.quote(id, dto);
  }

  @Post('requests/:id/consultation/complete')
  @HttpCode(HttpStatus.OK)
  completeConsultation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteConsultationDto,
  ) {
    return this.legal.completeConsultation(id, dto);
  }

  @Post('requests/:id/deliver')
  @HttpCode(HttpStatus.OK)
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverLegalRequestDto,
  ) {
    return this.legal.deliver(id, dto);
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelLegalRequestDto,
  ) {
    return this.legal.cancel(id, dto);
  }
}

import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { HeldTicketsQueryDto } from './dto/event-held-tickets.dto';
import {
  EventHeldTicketsService,
  type HeldTicketGroup,
  type HeldTicketView,
} from './event-held-tickets.service';

/**
 * The person's own tickets (EVENTS-03, E6 / E7 / E12). New routes; the
 * protected `GET /events/tickets/mine` is untouched. Three or four path
 * segments, so EventController's `@Get(':id')` and the `:id/...` routes never
 * see them.
 */
@Controller('events/tickets/held')
@UseGuards(WawuAuthGuard)
export class EventHeldTicketsController {
  constructor(private readonly service: EventHeldTicketsService) {}

  /** My tickets, upcoming or past, one row per order and tier. */
  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: HeldTicketsQueryDto,
  ): Promise<Paginated<HeldTicketGroup>> {
    return this.service.list(user.sub, query);
  }

  /** One of my tickets, with the code the door scans. */
  @Get(':ticketId')
  one(
    @CurrentUser() user: WawuJwtClaims,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ): Promise<HeldTicketView> {
    return this.service.one(user.sub, ticketId);
  }
}

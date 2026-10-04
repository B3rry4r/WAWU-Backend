import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { OptionalWawuAuthGuard } from '../search-response/guards/optional-wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { EventTicketingService } from './event-ticketing.service';
import {
  BuyTicketsDto,
  CancelEventDto,
  CreateReferralDto,
  ScanTicketDto,
  SetTicketTypesDto,
  VerifyOrderDto,
} from './dto/event-ticketing.dto';

/**
 * Event ticketing — `/api/hub/events/*`.
 *
 * ── ROUTE ORDER ───────────────────────────────────────────────────────────
 * Registered AFTER EventModule in app.module.ts, and every path here is
 * deeper than EventController's `@Get(':id')`. That catch-all is the shape
 * that has bitten this codebase before, so nothing shallow is added here.
 *
 * ── WHO CAN DO WHAT ───────────────────────────────────────────────────────
 * Reading the tiers on an event is public — a ticket page nobody can see
 * without an account sells nothing, and the whole point of the shareable link
 * is that it works for a stranger. Everything else needs a token, and the
 * organiser-only actions re-check ownership in the service rather than
 * trusting the id in the path.
 */
@Controller('events')
export class EventTicketingController {
  constructor(private readonly service: EventTicketingService) {}

  /** Public: what is on sale, and what is left. */
  @UseGuards(OptionalWawuAuthGuard)
  @Get(':id/tickets')
  ticketTypes(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.service.listTicketTypes(id, user?.sub);
  }

  /** Organiser: set the tiers. */
  @UseGuards(WawuAuthGuard)
  @Put(':id/tickets')
  setTicketTypes(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTicketTypesDto,
  ) {
    return this.service.setTicketTypes(user.sub, id, dto.types);
  }

  /** Buy. Opens a charge, or issues immediately when the tier is free. */
  @UseGuards(WawuAuthGuard)
  @Post(':id/orders')
  buy(@CurrentUser() user: WawuJwtClaims, @Body() dto: BuyTicketsDto) {
    return this.service.buy(user.sub, dto);
  }

  /** Confirm the money and receive the tickets. */
  @UseGuards(WawuAuthGuard)
  @Post('orders/:orderId/verify')
  verify(
    @CurrentUser() user: WawuJwtClaims,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: VerifyOrderDto,
  ) {
    return this.service.verifyOrder(user.sub, orderId, dto);
  }

  /** Every ticket this person holds. */
  @UseGuards(WawuAuthGuard)
  @Get('tickets/mine')
  myTickets(@CurrentUser() user: WawuJwtClaims) {
    return this.service.myTickets(user.sub);
  }

  /**
   * Scan at the door. Returns VALID / ALREADY USED / INVALID and the live
   * counts, so a scanner needs one call rather than two.
   */
  @UseGuards(WawuAuthGuard)
  @Post(':id/check-in')
  scan(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScanTicketDto,
  ) {
    return this.service.scan(user.sub, id, dto.code);
  }

  /** Sold, revenue, attendees, check-ins. */
  @UseGuards(WawuAuthGuard)
  @Get(':id/dashboard')
  dashboard(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.dashboard(user.sub, id);
  }

  /** A shareable link that attributes its sales. */
  @UseGuards(WawuAuthGuard)
  @Post(':id/referrals')
  createReferral(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReferralDto,
  ) {
    return this.service.createReferral(user.sub, id, dto.label);
  }

  /**
   * Call it off. Voids every ticket and refunds every buyer — a real
   * Flutterwave refund per order, not a status flip.
   */
  @UseGuards(WawuAuthGuard)
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelEventDto,
  ) {
    return this.service.cancel(user.sub, id, dto.reason);
  }
}

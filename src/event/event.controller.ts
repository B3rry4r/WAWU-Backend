import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { EventService } from './event.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import type { EventOptionsView } from './event-options';

/**
 * Events — `/api/hub/events/*` once the global prefix is applied.
 *
 * Reinstated 22 Aug 2026 by product-owner decision. WAWU-Web/CLAUDE.md and
 * docs/00_PLATFORM_MAP.md both listed Events under what was cut; both have been
 * amended with that date so the docs and this code agree.
 *
 * ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
 * No checkout, no payment verify, no refund: selling and refunding tickets is
 * EventTicketingController's. A submit may carry the event's ticket types
 * (EVENTS-02), which are stored with it and reviewed with it.
 * `POST /events/:id/going` is an interest signal and nothing else.
 *
 * ── ROUTE ORDER ──────────────────────────────────────────────────────────────
 * `mine` and `options` are declared before `:id` because Nest matches a
 * controller's routes in declaration order. ParseUUIDPipe on `:id` would 400
 * on "mine" anyway, but a route protected only by someone else's 400 is not a
 * route that is reachable on purpose.
 *
 * No collision with any existing controller: nothing else in this backend
 * declares an `events` prefix (verified against the route table on a real
 * boot, not by reading imports), and the one catch-all that has bitten before —
 * PartnerServiceController's `@Controller('services')` + `@Get(':id')` — is a
 * different first segment.
 */
@UseGuards(WawuAuthGuard)
@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  /** The public calendar. Published events only, whoever is asking. */
  @Get()
  list(@CurrentUser() user: WawuJwtClaims, @Query() query: ListEventsQueryDto) {
    return this.eventService.list(user.sub, query);
  }

  /**
   * The host's own submissions at every status, with the reason for the last
   * rejection or takedown. Any authenticated user can have submitted an event,
   * so there is no creator gate here.
   */
  @Get('mine')
  mine(@CurrentUser() user: WawuJwtClaims, @Query() query: PaginationQueryDto) {
    return this.eventService.listMine(user.sub, query);
  }

  /**
   * The label to show for each category, format and kind, beside the value to
   * send (EVENTS-02): "Business & Finance" is `business`. Declared before
   * `:id` for the same reason `mine` is.
   */
  @Get('options')
  options(): EventOptionsView {
    return this.eventService.options();
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.eventService.findOne(id, user.sub);
  }

  /**
   * Submit an event. Always lands `pending`; an admin decides whether it is
   * ever visible to anyone else.
   */
  @Post()
  create(@CurrentUser() user: WawuJwtClaims, @Body() dto: CreateEventDto) {
    return this.eventService.create(user.sub, dto);
  }

  /** Edit your own. Any edit sends it back to `pending` — see EventService.update. */
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventService.update(id, user.sub, dto);
  }

  /**
   * "I'm going" — an interest signal, idempotent, one per person.
   *
   * `@HttpCode(200)`: the ResponseInterceptor stamps `statusCode: 200` into
   * every success body regardless (hazard H-3), so a 201 here would ship a
   * response whose envelope contradicts its own status line. It is also honest
   * about the semantics — the second call creates nothing.
   */
  @Post(':id/going')
  @HttpCode(HttpStatus.OK)
  markGoing(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.eventService.markGoing(id, user.sub);
  }

  /** Withdraw it. Also idempotent: withdrawing twice is a 200, not a 404. */
  @Delete(':id/going')
  @HttpCode(HttpStatus.OK)
  withdrawGoing(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.eventService.withdrawGoing(id, user.sub);
  }

  /**
   * Bookmark it — the ribbon on the hero card and the heart on a trending
   * one. Private to the caller, and NOT the same statement as "Going": see
   * EventService.save.
   *
   * `@HttpCode(200)` for the same reason `going` uses it: the second call
   * creates nothing, and the ResponseInterceptor stamps 200 into the body
   * regardless (hazard H-3).
   */
  @Post(':id/save')
  @HttpCode(HttpStatus.OK)
  save(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.eventService.save(id, user.sub);
  }

  /** Un-bookmark it. Idempotent: removing one that was never there is a 200. */
  @Delete(':id/save')
  @HttpCode(HttpStatus.OK)
  unsave(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.eventService.unsave(id, user.sub);
  }
}

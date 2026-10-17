import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { AddDoorStaffDto, DoorScanDto } from './dto/event-running.dto';
import {
  EventRunningService,
  type CallOffPreview,
  type DoorCheckInResult,
  type DoorEventList,
  type DoorStaffView,
  type EventReferralSalesView,
  type HostSoldCounts,
} from './event-running.service';

/**
 * Running an event (EVENTS-05): the organiser's numbers (E17, E18) and the
 * door (E19 to E24), `/api/hub/events/*`.
 *
 * All new routes. The protected ones the web calls (`GET /events/mine`,
 * `GET /events/:id/dashboard`, `POST /events/:id/check-in`) are untouched.
 *
 * ROUTE ORDER: every path here has two or more segments, so EventController's
 * `@Get(':id')` never sees them, and the two literal paths (`mine/sold`,
 * `door/mine`) are declared before any `:id/...` path. Nothing here shares a
 * second segment with a `:id/...` route, so no literal is swallowed by one.
 */
@Controller('events')
@UseGuards(WawuAuthGuard)
export class EventRunningController {
  constructor(private readonly service: EventRunningService) {}

  /** Sold per event for every event the caller hosts (E17). */
  @Get('mine/sold')
  mySold(@CurrentUser() user: WawuJwtClaims): Promise<HostSoldCounts> {
    return this.service.mySoldCounts(user.sub);
  }

  /** The events the caller works the door at. */
  @Get('door/mine')
  myDoorEvents(@CurrentUser() user: WawuJwtClaims): Promise<DoorEventList> {
    return this.service.myDoorEvents(user.sub);
  }

  /** The host's shared links, each with its tickets sold (E18). */
  @Get(':id/referrals')
  referrals(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EventReferralSalesView[]> {
    return this.service.referrals(user.sub, id);
  }

  /** How many people calling the event off would refund (E25). */
  @Get(':id/call-off')
  callOffPreview(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CallOffPreview> {
    return this.service.callOffPreview(user.sub, id);
  }

  /** Who the host lets check tickets in. */
  @Get(':id/door-staff')
  listDoorStaff(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DoorStaffView[]> {
    return this.service.listDoorStaff(user.sub, id);
  }

  /** Add someone to the door, by WAWU id or handle. */
  @Post(':id/door-staff')
  addDoorStaff(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDoorStaffDto,
  ): Promise<DoorStaffView> {
    return this.service.addDoorStaff(user.sub, id, dto);
  }

  /** Take someone off the door. */
  @Delete(':id/door-staff/:staffId')
  removeDoorStaff(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('staffId', ParseUUIDPipe) staffId: string,
  ): Promise<{ removed: true }> {
    return this.service.removeDoorStaff(user.sub, id, staffId);
  }

  /**
   * Scan at the door, as the host or their door staff. Let them in (E20)
   * with the holder's name, already used (E23) with when and by whom, or
   * not valid (E24), with the live counts.
   *
   * `Idempotency-Key` (optional): the phone makes one per scan and sends it
   * again unchanged when it asks again after an answer was lost. A repeat is
   * answered with the first verdict (header `Idempotent-Replayed: true`),
   * never "already used" by the scanner's own door.
   */
  @Post(':id/door/check-in')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'One value per scan, made by the app when a ticket is first read and sent again unchanged when it asks again about that scan. A repeat is answered with the first verdict.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  })
  async checkIn(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DoorScanDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DoorCheckInResult> {
    const { result, replayed } = await this.service.checkIn(
      user.sub,
      id,
      dto.code,
      key,
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result;
  }
}

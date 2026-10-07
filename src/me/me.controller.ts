import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import {
  EarningSalesQueryDto,
  EarningsQueryDto,
  NotificationFeedQueryDto,
  PurchasesQueryDto,
  SavedQueryDto,
} from './dto/me-query.dto';
import { MeSavedService } from './me-saved.service';
import { MePurchasesService } from './me-purchases.service';
import { MeNotificationsService } from './me-notifications.service';
import { MeEarningsService } from './me-earnings.service';
import type {
  EarningSalePage,
  LessonDoneState,
  MeCountsView,
  MyEarningsView,
  NotificationFeedPage,
  PurchasePage,
  SavedCreatorState,
  SavedPage,
} from './me-view.type';

/**
 * The caller's own lists (task ME-10): the Me menu's counts (M7), Saved
 * (M30), My purchases with course progress (M29), notifications that open
 * what they are about (M31, M32), and this month's earnings (M7, M18).
 *
 * Every route reads or writes the token's own records and takes no id of
 * whose: there is no way to ask for somebody else's. `/me` is a first
 * segment no other controller declares.
 */
@UseGuards(WawuAuthGuard)
@Controller('me')
export class MeController {
  constructor(
    private readonly saved: MeSavedService,
    private readonly purchases: MePurchasesService,
    private readonly notifications: MeNotificationsService,
    private readonly earnings: MeEarningsService,
  ) {}

  /** M7's figures in one read: purchases, saved, unread notifications. */
  @Get('counts')
  async counts(@CurrentUser() user: WawuJwtClaims): Promise<MeCountsView> {
    const [purchases, saved, unreadNotifications] = await Promise.all([
      this.purchases.count(user.sub),
      this.saved.count(user.sub),
      this.notifications.unreadCount(user.sub),
    ]);
    return { purchases, saved, unreadNotifications };
  }

  /** Saved (M30): content, events and creators, newest first, by tab. */
  @Get('saved')
  savedList(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: SavedQueryDto,
  ): Promise<SavedPage> {
    return this.saved.list(
      user.sub,
      query.type ?? 'all',
      query.cursor,
      query.limit ?? 20,
    );
  }

  /** Save a creator (M30's Creators tab). Idempotent. */
  @Put('saved/creators/:wawuId')
  @HttpCode(200)
  saveCreator(
    @CurrentUser() user: WawuJwtClaims,
    @Param('wawuId', new ParseUUIDPipe({ version: '4' })) wawuId: string,
  ): Promise<SavedCreatorState> {
    return this.saved.saveCreator(user.sub, wawuId);
  }

  /** Remove a saved creator. Idempotent. */
  @Delete('saved/creators/:wawuId')
  @HttpCode(200)
  unsaveCreator(
    @CurrentUser() user: WawuJwtClaims,
    @Param('wawuId', new ParseUUIDPipe({ version: '4' })) wawuId: string,
  ): Promise<SavedCreatorState> {
    return this.saved.unsaveCreator(user.sub, wawuId);
  }

  /** My purchases (M29): pieces bought, newest first, searchable, with course progress. */
  @Get('purchases')
  purchaseList(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PurchasesQueryDto,
  ): Promise<PurchasePage> {
    return this.purchases.list(
      user.sub,
      query.q,
      query.cursor,
      query.limit ?? 20,
    );
  }

  /** Mark a lesson of a course piece finished (M29 "3 of 12 done"). Idempotent. */
  @Put('lessons/:lessonId/done')
  @HttpCode(200)
  lessonDone(
    @CurrentUser() user: WawuJwtClaims,
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<LessonDoneState> {
    return this.purchases.setLessonDone(user.sub, lessonId, true);
  }

  /** Mark a lesson not finished. Idempotent. */
  @Delete('lessons/:lessonId/done')
  @HttpCode(200)
  lessonNotDone(
    @CurrentUser() user: WawuJwtClaims,
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<LessonDoneState> {
    return this.purchases.setLessonDone(user.sub, lessonId, false);
  }

  /** Notifications (M31, M32), by chip, each with what opening it opens. */
  @Get('notifications')
  notificationList(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: NotificationFeedQueryDto,
  ): Promise<NotificationFeedPage> {
    return this.notifications.list(
      user.sub,
      query.category ?? 'all',
      query.cursor,
      query.limit ?? 20,
    );
  }

  /** A month's earnings from the caller's completed sales (M7, M18). Never a balance. */
  @Get('earnings')
  earningsSummary(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: EarningsQueryDto,
  ): Promise<MyEarningsView> {
    return this.earnings.summary(user.sub, query.month);
  }

  /** The completed sales behind a month's earnings, newest first. */
  @Get('earnings/sales')
  earningSales(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: EarningSalesQueryDto,
  ): Promise<EarningSalePage> {
    return this.earnings.sales(
      user.sub,
      query.month,
      query.cursor,
      query.limit ?? 20,
    );
  }
}

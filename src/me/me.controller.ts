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
import { MePaidPurchasesService } from './me-paid-purchases.service';
import { MeNotificationsService } from './me-notifications.service';
import { MeEarningsService } from './me-earnings.service';
import { MeCoursesService } from './me-courses.service';
import { ProfileLocationService } from '../geo/profile-location.service';
import type { MeLocationView } from '../geo/geo.types';
import type {
  EarningSalePage,
  LessonDoneState,
  MeCountsView,
  MyEarningsView,
  NotificationFeedPage,
  PaidPurchasePage,
  PurchasePage,
  SavedCourseState,
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
    private readonly paidPurchases: MePaidPurchasesService,
    private readonly notifications: MeNotificationsService,
    private readonly earnings: MeEarningsService,
    private readonly courses: MeCoursesService,
    private readonly places: ProfileLocationService,
  ) {}

  /** M7's figures in one read: purchases, saved, unread notifications, enrolled courses. */
  @Get('counts')
  async counts(@CurrentUser() user: WawuJwtClaims): Promise<MeCountsView> {
    const [purchases, saved, unreadNotifications, enrolledCourses] =
      await Promise.all([
        this.purchases.count(user.sub),
        this.saved.count(user.sub),
        this.notifications.unreadCount(user.sub),
        this.courses.enrolledCount(user.sub),
      ]);
    return { purchases, saved, unreadNotifications, enrolledCourses };
  }

  /**
   * Where the signed-in person is (GEO-02, R-85): their country of residence
   * (what they chose, else the country WAWU ID holds, else their phone's),
   * with their region and city when they have set them. The app calls it
   * after sign-in; where the person has not chosen a country it records the
   * one WAWU ID gives, so the dashboard counts them.
   */
  @Get('location')
  location(@CurrentUser() user: WawuJwtClaims): Promise<MeLocationView> {
    return this.places.me(user.sub, user);
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

  /** Whether a school course is saved (SC3's bookmark). */
  @Get('saved/courses/:courseId')
  courseSaved(
    @CurrentUser() user: WawuJwtClaims,
    @Param('courseId', ParseUUIDPipe) courseId: string,
  ): Promise<SavedCourseState> {
    return this.saved.courseState(user.sub, courseId);
  }

  /** Save a school course (SC3's bookmark). Idempotent. */
  @Put('saved/courses/:courseId')
  @HttpCode(200)
  saveCourse(
    @CurrentUser() user: WawuJwtClaims,
    @Param('courseId', ParseUUIDPipe) courseId: string,
  ): Promise<SavedCourseState> {
    return this.saved.saveCourse(user.sub, courseId);
  }

  /** Remove a saved school course. Idempotent. */
  @Delete('saved/courses/:courseId')
  @HttpCode(200)
  unsaveCourse(
    @CurrentUser() user: WawuJwtClaims,
    @Param('courseId', ParseUUIDPipe) courseId: string,
  ): Promise<SavedCourseState> {
    return this.saved.unsaveCourse(user.sub, courseId);
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

  /**
   * My purchases across every paid kind (M29, FIX-59): unlocks, tickets,
   * credit packs, school fees and community passes, newest first, searchable
   * by title, paid-back ones marked `refunded`. A separate route so
   * `GET /me/purchases` above answers exactly as it always has.
   */
  @Get('purchases/all')
  paidPurchaseList(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PurchasesQueryDto,
  ): Promise<PaidPurchasePage> {
    return this.paidPurchases.list(
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

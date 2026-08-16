import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CreatorSubscriptionService } from './creator-subscription.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { SubscribeDto } from './dto/subscribe.dto';
import { VerifySubscriptionDto } from './dto/verify-subscription.dto';
import { UpdateCardDto } from './dto/update-card.dto';

/**
 * registry.json "CreatorSubscription" — task brief's frozen endpoint list.
 * POST / and POST /verify are `roles: ["any"]` (first-time-subscribe path —
 * the caller isn't a creator account yet); every other endpoint is
 * `roles: ["creator"]`, enforced by the local CreatorAccountGuard, not
 * re-checked in the service (CLAUDE.md: gates come from one place).
 */
@UseGuards(WawuAuthGuard)
@Controller('creator-subscription')
export class CreatorSubscriptionController {
  constructor(
    private readonly creatorSubscriptionService: CreatorSubscriptionService,
  ) {}

  @Get()
  @UseGuards(CreatorAccountGuard)
  getSubscription(@CurrentUser() user: WawuJwtClaims) {
    return this.creatorSubscriptionService.getSubscription(user.sub);
  }

  @Post()
  subscribe(@CurrentUser() user: WawuJwtClaims, @Body() dto: SubscribeDto) {
    return this.creatorSubscriptionService.subscribe(user.sub, dto);
  }

  @Post('verify')
  verify(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VerifySubscriptionDto,
  ) {
    return this.creatorSubscriptionService.verify(user.sub, dto);
  }

  @Post('upgrade')
  @UseGuards(CreatorAccountGuard)
  upgrade(@CurrentUser() user: WawuJwtClaims) {
    return this.creatorSubscriptionService.upgrade(user.sub);
  }

  @Post('downgrade')
  @UseGuards(CreatorAccountGuard)
  downgrade(@CurrentUser() user: WawuJwtClaims) {
    return this.creatorSubscriptionService.downgrade(user.sub);
  }

  @Post('retry-payment')
  @UseGuards(CreatorAccountGuard)
  retryPayment(@CurrentUser() user: WawuJwtClaims) {
    return this.creatorSubscriptionService.retryPayment(user.sub);
  }

  @Delete()
  @UseGuards(CreatorAccountGuard)
  cancel(@CurrentUser() user: WawuJwtClaims) {
    return this.creatorSubscriptionService.cancel(user.sub);
  }

  @Patch('card')
  @UseGuards(CreatorAccountGuard)
  updateCard(@CurrentUser() user: WawuJwtClaims, @Body() dto: UpdateCardDto) {
    return this.creatorSubscriptionService.updateCard(user.sub, dto);
  }

  @Get('billing-history')
  @UseGuards(CreatorAccountGuard)
  billingHistory(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.creatorSubscriptionService.listBillingHistory(
      user.sub,
      query.page,
      query.perPage,
    );
  }
}

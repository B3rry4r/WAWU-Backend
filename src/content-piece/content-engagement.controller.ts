import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ContentEngagementService } from './content-engagement.service';
import { FeedQueryDto } from './feed-query.dto';
import { FeedEntriesService } from './feed-entries.service';

/**
 * Likes, views, shares and the viewer's flags on a piece (HOME-04). All new
 * routes: nothing the web calls changes. Every route here is a different path
 * depth from `GET/DELETE /content/:id`, so none can be swallowed by it.
 */
@UseGuards(WawuAuthGuard)
@Controller('content/:id')
export class ContentEngagementController {
  constructor(private readonly engagement: ContentEngagementService) {}

  @Post('like')
  @HttpCode(200)
  like(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.engagement.setLiked(id, user.sub, true);
  }

  @Delete('like')
  @HttpCode(200)
  unlike(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.engagement.setLiked(id, user.sub, false);
  }

  @Post('view')
  @HttpCode(200)
  view(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.engagement.recordView(id, user.sub);
  }

  @Post('share')
  @HttpCode(200)
  share(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.engagement.recordShare(id, user.sub);
  }

  @Get('engagement')
  state(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.engagement.engagement(id, user.sub);
  }
}

/** The feed itself: GET /feed and the following count behind its empty state. */
@UseGuards(WawuAuthGuard)
@Controller('feed')
export class FeedController {
  constructor(
    private readonly engagement: ContentEngagementService,
    private readonly entries: FeedEntriesService,
  ) {}

  @Get()
  feed(@CurrentUser() user: WawuJwtClaims, @Query() query: FeedQueryDto) {
    return this.engagement.feed(
      user.sub,
      query.scope,
      query.category,
      query.sort,
      query.page,
      query.perPage,
    );
  }

  /**
   * The mixed feed (HOME-05): the same cards as `GET /feed`, with creator and
   * professional cards among them on For you.
   */
  @Get('entries')
  mixed(@CurrentUser() user: WawuJwtClaims, @Query() query: FeedQueryDto) {
    return this.entries.entries(
      user.sub,
      query.scope,
      query.category,
      query.sort,
      query.page,
      query.perPage,
    );
  }

  @Get('following/count')
  followingCount(@CurrentUser() user: WawuJwtClaims) {
    return this.engagement.followingCount(user.sub);
  }
}

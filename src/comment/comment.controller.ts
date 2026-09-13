import {
  Body,
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
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CommentService } from './comment.service';
import { CreateCommentDto } from './dto/create-comment.dto';

/**
 * registry.json "Comment": GET/POST /content/:id/comments, both `roles:
 * ["any"]` — any authenticated WAWU user, no creator gate. The like routes
 * below are additive: liking a comment used to be a decorative heart with no
 * endpoint behind it at all.
 */
@UseGuards(WawuAuthGuard)
@Controller('content/:id/comments')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get()
  list(
    @Param('id', ParseUUIDPipe) contentId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.commentService.list(
      contentId,
      user.sub,
      query.page,
      query.perPage,
    );
  }

  @Post()
  create(
    @Param('id', ParseUUIDPipe) contentId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentService.create(contentId, user.sub, dto);
  }

  @Post(':commentId/like')
  @HttpCode(200)
  like(
    @Param('id', ParseUUIDPipe) contentId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.commentService.setLiked(contentId, commentId, user.sub, true);
  }

  @Delete(':commentId/like')
  @HttpCode(200)
  unlike(
    @Param('id', ParseUUIDPipe) contentId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: WawuJwtClaims,
  ) {
    return this.commentService.setLiked(contentId, commentId, user.sub, false);
  }
}

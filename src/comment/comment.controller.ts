import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CommentService } from './comment.service';
import { CreateCommentDto } from './dto/create-comment.dto';

/**
 * registry.json "Comment": GET/POST /content/:id/comments. Both endpoints
 * are `roles: ["any"]` — any authenticated WAWU user, no creator gate.
 */
@UseGuards(WawuAuthGuard)
@Controller('content/:id/comments')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get()
  list(@Param('id', ParseUUIDPipe) contentId: string, @Query() query: PaginationQueryDto) {
    return this.commentService.list(contentId, query.page, query.perPage);
  }

  @Post()
  create(
    @Param('id', ParseUUIDPipe) contentId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentService.create(contentId, user.sub, dto);
  }
}

import { Controller, Get, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreatorEarningsService } from './creator-earnings.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import type { CreatorEarningsResponse } from '../common/types';

/**
 * registry.json "CreatorEarnings": exactly one endpoint,
 * `GET /content/mine/earnings`, `roles: ["creator"]`. Shares the `content`
 * path prefix with ContentPieceController (a separate resource/directory)
 * the same way src/comment/comment.controller.ts shares it with
 * `content/:id/comments` — Nest matches distinct controller-declared paths
 * fine side by side; this file never touches src/content-piece/.
 */
@UseGuards(WawuAuthGuard, CreatorAccountGuard)
@Controller('content/mine/earnings')
export class CreatorEarningsController {
  constructor(
    private readonly creatorEarningsService: CreatorEarningsService,
  ) {}

  @Get()
  get(@CurrentUser() user: WawuJwtClaims): Promise<CreatorEarningsResponse> {
    return this.creatorEarningsService.getForCreator(user.sub);
  }
}

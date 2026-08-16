import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { VerificationSubmissionService } from './verification-submission.service';
import { CreateVerificationSubmissionDto } from './dto/create-verification-submission.dto';
import { ResubmitVerificationSubmissionDto } from './dto/resubmit-verification-submission.dto';
import { ReviewVerificationSubmissionDto } from './dto/review-verification-submission.dto';
import { VerificationAdminGuard } from './guards/admin.guard';

/**
 * registry.json "VerificationSubmission". All endpoints require an
 * authenticated WAWU user (roles: ["any"]) except review, which additionally
 * requires VerificationAdminGuard (roles: ["admin"]).
 */
@UseGuards(WawuAuthGuard)
@Controller('verification')
export class VerificationSubmissionController {
  constructor(private readonly service: VerificationSubmissionService) {}

  @Get('ladder')
  ladder(@CurrentUser() user: WawuJwtClaims) {
    return this.service.ladder(user);
  }

  @Get('submissions')
  listMine(@CurrentUser() user: WawuJwtClaims) {
    return this.service.listMine(user.sub);
  }

  @Post('submissions')
  create(@CurrentUser() user: WawuJwtClaims, @Body() dto: CreateVerificationSubmissionDto) {
    return this.service.create(user.sub, dto);
  }

  @Post('submissions/:id/resubmit')
  @HttpCode(HttpStatus.OK)
  resubmit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ResubmitVerificationSubmissionDto,
  ) {
    return this.service.resubmit(id, user.sub, dto);
  }

  @UseGuards(VerificationAdminGuard)
  @Post('submissions/:id/review')
  @HttpCode(HttpStatus.OK)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewVerificationSubmissionDto) {
    return this.service.review(id, dto);
  }
}

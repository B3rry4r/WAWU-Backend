import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { KycSubmissionService } from './kyc-submission.service';
import { CreateKycSubmissionDto } from './dto/create-kyc-submission.dto';
import { ReviewKycSubmissionDto } from './dto/review-kyc-submission.dto';
import { KycAdminGuard } from './guards/admin.guard';

/**
 * registry.json "KycSubmission". GET/POST /kyc require an authenticated
 * caller who is a creator (roles: ["creator"], enforced in the service via
 * CreatorState row existence — same idiom as CreatorStateController/Service,
 * not re-checked here). review additionally requires KycAdminGuard
 * (roles: ["admin"]).
 */
@UseGuards(WawuAuthGuard)
@Controller('kyc')
export class KycSubmissionController {
  constructor(private readonly service: KycSubmissionService) {}

  @Get()
  getMine(@CurrentUser() user: WawuJwtClaims) {
    return this.service.getMine(user.sub);
  }

  @Post()
  submit(@CurrentUser() user: WawuJwtClaims, @Body() dto: CreateKycSubmissionDto) {
    return this.service.submit(user.sub, dto);
  }

  @UseGuards(KycAdminGuard)
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewKycSubmissionDto) {
    return this.service.review(id, dto);
  }
}

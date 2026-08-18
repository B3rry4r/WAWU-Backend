import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { HealthPlanService } from './health-plan.service';
import {
  InitHealthSubscriptionDto,
  VerifyHealthSubscriptionDto,
} from './dto/health-plan.dto';

/** WAWUCare — health cover and telemedicine, fulfilled by WellaHealth. */
@UseGuards(WawuAuthGuard)
@Controller('care')
export class HealthPlanController {
  constructor(private readonly care: HealthPlanService) {}

  @Get('plans')
  plans() {
    return this.care.listPlans();
  }

  @Post('subscriptions/init')
  @HttpCode(HttpStatus.OK)
  init(@CurrentUser() user: WawuJwtClaims, @Body() dto: InitHealthSubscriptionDto) {
    return this.care.init(user.sub, dto);
  }

  @Post('subscriptions/:id/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id') id: string,
    @Body() dto: VerifyHealthSubscriptionDto,
  ) {
    return this.care.verifyAndEnrol(user.sub, id, dto.transactionId);
  }

  @Get('subscriptions')
  mine(@CurrentUser() user: WawuJwtClaims) {
    return this.care.listMine(user.sub);
  }
}

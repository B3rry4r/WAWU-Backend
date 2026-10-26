import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { PolicyAcceptanceView } from './about-view.type';
import { AcceptPoliciesDto } from './dto/accept-policies.dto';
import { PolicyAcceptanceService } from './policy-acceptance.service';

/**
 * LEGAL-DOCS: `POST /policies/accept`, written by the app once after sign-up.
 * Own data only: the person is the token's, never a field. `policies/accept`
 * does not meet `GET policies/:slug` (another method; `accept` is no slug).
 */
@Controller('policies')
@UseGuards(WawuAuthGuard)
export class PolicyAcceptanceController {
  constructor(private readonly acceptance: PolicyAcceptanceService) {}

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: AcceptPoliciesDto,
  ): Promise<PolicyAcceptanceView> {
    return this.acceptance.accept(user.sub, dto.how);
  }
}

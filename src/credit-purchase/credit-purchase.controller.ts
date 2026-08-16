import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreditPurchaseService } from './credit-purchase.service';
import { CreateCreditPurchaseDto } from './dto/create-credit-purchase.dto';
import { VerifyCreditPurchaseDto } from './dto/verify-credit-purchase.dto';

/**
 * registry.json "CreditPurchase": POST /credits/purchase,
 * POST /credits/purchase/verify. Both `roles: ["any"]` — any authenticated
 * WAWU user, not creator-gated (a plain user tops up Community Credits same
 * as a creator).
 */
@UseGuards(WawuAuthGuard)
@Controller('credits/purchase')
export class CreditPurchaseController {
  constructor(private readonly creditPurchaseService: CreditPurchaseService) {}

  @Post()
  createPurchase(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCreditPurchaseDto,
  ) {
    return this.creditPurchaseService.createPurchase(user.sub, dto);
  }

  @Post('verify')
  verifyPurchase(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VerifyCreditPurchaseDto,
  ) {
    return this.creditPurchaseService.verifyPurchase(user.sub, dto);
  }
}

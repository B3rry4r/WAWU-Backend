import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PurchaseService } from './purchase.service';
import { CreateTipDto } from './dto/create-tip.dto';
import { VerifyTipDto } from './dto/verify-tip.dto';

/**
 * registry.json "Purchase": POST /tips, POST /tips/verify. Both
 * `roles: ["any"]` — any authenticated WAWU user, no creator gate (a plain
 * user tips a creator; nothing here requires the caller to be a creator).
 */
@UseGuards(WawuAuthGuard)
@Controller('tips')
export class PurchaseController {
  constructor(private readonly purchaseService: PurchaseService) {}

  @Post()
  createTip(@CurrentUser() user: WawuJwtClaims, @Body() dto: CreateTipDto) {
    return this.purchaseService.createTip(user.sub, dto);
  }

  @Post('verify')
  verifyTip(@CurrentUser() user: WawuJwtClaims, @Body() dto: VerifyTipDto) {
    return this.purchaseService.verifyTip(user.sub, dto);
  }
}

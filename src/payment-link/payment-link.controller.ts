import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiGoneResponse } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaymentLinkService } from './payment-link.service';
import { HostedLinkDto } from './dto/hosted-link.dto';

/**
 * POST /payments/hosted-link — a Flutterwave checkout URL for a charge this
 * server already initialised.
 *
 * Signed in only, and only for the caller's OWN charge. See the service for
 * why the txRef is looked up rather than trusted.
 */
@UseGuards(WawuAuthGuard)
@Controller('payments')
export class PaymentLinkController {
  constructor(private readonly links: PaymentLinkService) {}

  @Post('hosted-link')
  @HttpCode(HttpStatus.OK)
  @ApiGoneResponse({
    description:
      'reason.code: shop_retired. The txRef is a Shop order: Shop is retired (R-2, OPS-08), so no new payment page is opened for it.',
  })
  create(@CurrentUser() user: WawuJwtClaims, @Body() dto: HostedLinkDto) {
    return this.links.create(user.sub, dto);
  }
}

import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { WalletBalanceView } from '../money-view.type';
import { WalletBalanceService } from './wallet-balance.service';

/**
 * The Naira balance, served (task MONEY-11). Declared by MONEY-04; the
 * response type and the refusals are the contract's own, unchanged.
 *
 * The caller is the token: the route takes no wallet id and no wawuUserId.
 * `no-store` because the figure is Fintava's at the moment it answered;
 * nothing between the app and here may keep it and answer with it later.
 *
 * Of the wallet gate codes it answers `wallet_not_open` (no wallet yet),
 * `wallet_opening` (MONEY-12 is still opening the account) and
 * `wallet_frozen` (Fintava's own frozen refusal).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyBalanceController {
  constructor(private readonly balances: WalletBalanceService) {}

  /**
   * Fintava's available balance, asked for on every call (W1, W9, W13).
   * 503 provider_unreachable when the bank does not answer (W6): never a 0.
   */
  @Get('wallet/balance')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-11')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'provider_unreachable')
  balance(@CurrentUser() user: WawuJwtClaims): Promise<WalletBalanceView> {
    return this.balances.balance(user.sub);
  }
}

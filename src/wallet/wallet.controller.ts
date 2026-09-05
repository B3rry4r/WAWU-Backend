import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WalletService } from './wallet.service';
import { ResolveAccountDto, WithdrawDto } from './dto/wallet.dto';

/**
 * `/api/hub/wallet/*` — a creator's own wallet, and nobody else's.
 *
 * Every route reads the caller's id from their token. There is no route that
 * takes a wawuUserId, deliberately: a wallet endpoint that accepts somebody
 * else's id is one authorisation slip away from draining their account.
 */
@UseGuards(WawuAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  /** Balance, account number and status. */
  @Get()
  get(@CurrentUser() user: WawuJwtClaims) {
    // The whole claims object, not just the id: opening a wallet needs the
    // creator's verified name, and this is where it is.
    return this.wallet.getWallet(user);
  }

  /** What has moved, newest first. */
  @Get('history')
  history(@CurrentUser() user: WawuJwtClaims, @Query('take') take?: string) {
    return this.wallet.history(user.sub, take ? Number(take) : undefined);
  }

  /** The banks that can be withdrawn to. */
  @Get('banks')
  banks() {
    return this.wallet.banks();
  }

  /**
   * Whose account this is. A read, but a POST: an account number in a URL
   * ends up in proxy logs and browser history, and this one is about to be
   * paid money.
   */
  @Post('resolve-account')
  resolve(@Body() dto: ResolveAccountDto) {
    return this.wallet.resolveAccount(dto.bankCode, dto.accountNumber);
  }

  /** Send money from this wallet to a bank account. */
  @Post('withdraw')
  withdraw(@CurrentUser() user: WawuJwtClaims, @Body() dto: WithdrawDto) {
    return this.wallet.withdraw({
      wawuUserId: user.sub,
      amount: dto.amount,
      bankCode: dto.bankCode,
      accountNumber: dto.accountNumber,
    });
  }
}

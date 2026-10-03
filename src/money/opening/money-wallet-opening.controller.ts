import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { BuiltBy, MoneyErrors } from '../money-contract';
import type { WalletView } from '../money-view.type';
import { OpenNairaWalletDto } from './dto/open-wallet.dto';
import { WalletOpeningService } from './wallet-opening.service';

/**
 * The Naira wallet as WAWU records it, and opening it at Fintava (task
 * MONEY-12, A7, A8, W1). GET /money/wallet was declared by MONEY-04; its
 * response type is the contract's own, unchanged.
 *
 * The caller is the token: no route takes a wawuUserId. Both answers are
 * `no-store`: they carry the person's account number.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyWalletController {
  constructor(private readonly opening: WalletOpeningService) {}

  /**
   * The wallet as WAWU records it: state, account details, limits, PIN state.
   * Never calls Fintava and never carries a balance. With no wallet it answers
   * 200 with state not_open (R-6), so the Wallet tab can lead to Open your
   * wallet; while the account is being opened, state opening (A7); once
   * open, the account number Fintava gave (W1, A8).
   */
  @Get('wallet')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-12')
  wallet(@CurrentUser() user: WawuJwtClaims): Promise<WalletView> {
    return this.opening.view(user.sub);
  }

  /**
   * The end of Open your wallet (A7): opens the person's account at Fintava
   * with the BVN and NIN whose check passed (KYC-01), after a selfie that
   * matched against that check (KYC-02), A5's name and date of birth, the
   * address typed, and the account's email. None of these is stored.
   *
   * Safe to repeat: one account per person, whatever the number of taps.
   * Answers the wallet: `open` with its account number, or `opening` while
   * Fintava's answer is being confirmed (a lost answer is checked with
   * Fintava, never sent again blindly; GET /money/wallet shows when it
   * settles). An open wallet is answered as it is, with nothing sent.
   */
  @Post('wallet/open')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-12')
  @MoneyErrors(
    'bvn_not_checked',
    'selfie_required',
    'identity_has_wallet',
    'account_not_opened',
    'provider_unreachable',
  )
  open(
    @CurrentUser() user: WawuJwtClaims,
    @Body() body: OpenNairaWalletDto,
  ): Promise<WalletView> {
    return this.opening.open(user.sub, user.email, body);
  }
}

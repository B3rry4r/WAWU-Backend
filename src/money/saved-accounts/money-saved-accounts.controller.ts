import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import {
  CreateBeneficiaryDto,
  PayoutAccountDto,
} from '../dto/money-request.dto';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { BeneficiaryView, PayoutAccountView } from '../money-view.type';
import { BeneficiaryService } from './beneficiary.service';
import { PayoutAccountService } from './payout-account.service';

/**
 * Saved beneficiaries and the payout account (task WALLET-14): W8's saved
 * list and "My payout account", W12's "Save as beneficiary", W35's count,
 * A21's payout bank and W17's default destination. Declared by MONEY-04,
 * served here (docs/contract/CONVENTIONS.md section 0).
 *
 * Every route needs an open wallet (MONEY-13's gate, `@RequireOpenWallet()`:
 * `409 wallet_not_open` or `409 wallet_opening` before anything else runs),
 * and acts on the wallet the gate found for the caller's token: no route
 * takes a wawuUserId of whose list or account to act on. Every answer is `no-store`: it carries account numbers
 * and the names banks hold for them.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneySavedAccountsController {
  constructor(
    private readonly beneficiaries: BeneficiaryService,
    private readonly payout: PayoutAccountService,
  ) {}

  /** Saved beneficiaries, newest first (W8). Their number is WalletView.beneficiaryCount (W35). */
  @Get('beneficiaries')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-14')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  list(@CurrentWallet() wallet: OpenWallet): Promise<BeneficiaryView[]> {
    return this.beneficiaries.list(wallet.wawuUserId);
  }

  /**
   * Save a beneficiary (W12 "Save as beneficiary"): a WAWU user with a
   * wallet, or a bank account the bank confirms by name check (the name
   * saved is the bank's). Saving one already saved answers the existing one.
   * At most BENEFICIARIES_MAX per person (`beneficiary_limit_reached`).
   */
  @Post('beneficiaries')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-14')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'recipient_not_found',
    'recipient_has_no_wallet',
    'self_transfer',
    'beneficiary_limit_reached',
    'name_check_failed',
    'provider_unreachable',
  )
  add(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: CreateBeneficiaryDto,
  ): Promise<BeneficiaryView> {
    return this.beneficiaries.add(wallet.wawuUserId, dto);
  }

  /** Remove a saved beneficiary. Removing one already gone, or not the caller's, is a 200 that removes nothing. */
  @Delete('beneficiaries/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-14')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  remove(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.beneficiaries.remove(wallet.wawuUserId, id);
  }

  /** The payout account (A21, W17's default destination), or null when none is saved. */
  @Get('payout-account')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-14')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  getPayoutAccount(
    @CurrentWallet() wallet: OpenWallet,
  ): Promise<PayoutAccountView | null> {
    return this.payout.get(wallet.wawuUserId);
  }

  /**
   * Save or replace the payout account. The server name-checks it with the
   * bank and compares the bank's name with the BVN name: an account in
   * another name is saved and flagged (`matchesBvnName: false`).
   */
  @Put('payout-account')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-14')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'name_check_failed',
    'provider_unreachable',
  )
  setPayoutAccount(
    @CurrentWallet() wallet: OpenWallet,
    @Body() dto: PayoutAccountDto,
  ): Promise<PayoutAccountView> {
    return this.payout.set(wallet.wawuUserId, dto);
  }
}

import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { HoldListQueryDto } from '../dto/money-request.dto';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { HoldPage, HoldView } from '../money-view.type';
import { HoldViewService } from './hold-view.service';

/**
 * Money held between payer and payee in WAWU's own account at the wallet
 * provider (task MONEY-18, R-19). Declared by MONEY-04, served here
 * (docs/contract/CONVENTIONS.md section 18).
 *
 * A hold is never moved by a client request: the owning feature releases it
 * (a DM answered, an event that took place, a bill delivered) or refunds it
 * (no answer in time, an event called off, a biller failure) through
 * `WalletHoldService`. These routes only read holds, behind the wallet gate,
 * from our own records: they never call the provider, so none of them
 * answers `provider_unreachable`. `no-store`, because a hold settles when
 * the provider confirms the move.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyHoldsController {
  constructor(private readonly holds: HoldViewService) {}

  /** Holds the caller paid (role=payer) or is owed (role=payee), newest first. */
  @Get('holds')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-18')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  list(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: HoldListQueryDto,
  ): Promise<HoldPage> {
    return this.holds.list(wallet.wawuUserId, query);
  }

  /** One hold. Its payer and its payee can read it; nobody else. */
  @Get('holds/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-18')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  detail(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HoldView> {
    return this.holds.detail(wallet.wawuUserId, id);
  }
}

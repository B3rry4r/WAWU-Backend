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
import {
  MonthlySummaryQueryDto,
  TransactionListQueryDto,
} from '../dto/money-request.dto';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type {
  MonthlySummaryView,
  TransactionPage,
  TransactionView,
} from '../money-view.type';
import { TransactionHistoryService } from './transaction-history.service';

/**
 * The wallet's history, served (task MONEY-15, on the ledger of MONEY-10):
 * every movement in and out, mirrored from Fintava, in kobo. Cursor pages,
 * newest first. Declared by MONEY-04; the query DTOs, the response types and
 * the refusals are the contract's own, unchanged.
 *
 * The caller is the token: no route takes a wallet id or a wawuUserId.
 * Every route is behind the wallet gate (MONEY-13): no wallet yet is `409
 * wallet_not_open` (or `wallet_opening`), in the same words as every
 * wallet route, before anything is read.
 * `no-store` because a row's status moves as Fintava confirms it.
 * Nothing here calls Fintava, so none of these answers `provider_unreachable`.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyHistoryController {
  constructor(private readonly history: TransactionHistoryService) {}

  /** W26, W28: search, filter chips, an optional month. W1's recent rows are the first page with limit=3. */
  @Get('transactions')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-15')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  list(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: TransactionListQueryDto,
  ): Promise<TransactionPage> {
    return this.history.list(wallet, query);
  }

  /** W26's In and Out for one month. Declared before transactions/{id} so the literal path wins. */
  @Get('transactions/summary')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-15')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  summary(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: MonthlySummaryQueryDto,
  ): Promise<MonthlySummaryView> {
    return this.history.summary(wallet, query);
  }

  /** One row as a receipt (W27). Only the wallet's owner can read it. */
  @Get('transactions/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-15')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  detail(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TransactionView> {
    return this.history.detail(wallet, id);
  }
}

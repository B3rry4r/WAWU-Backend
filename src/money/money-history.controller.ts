import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  MonthlySummaryQueryDto,
  TransactionListQueryDto,
} from './dto/money-request.dto';
import {
  BuiltBy,
  declaredOnly,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type {
  MonthlySummaryView,
  TransactionPage,
  TransactionView,
} from './money-view.type';

/**
 * The wallet's history (MONEY-15, on the ledger of MONEY-10): every movement
 * in and out, mirrored from Fintava, in kobo. Cursor pages, newest first.
 * Task MONEY-04 contract; see money-contract.ts for why these handlers are
 * declarations.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyHistoryController {
  /** W26, W28: search, filter chips, an optional month. W1's recent rows are the first page with limit=3. */
  @Get('transactions')
  @BuiltBy('MONEY-15')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  list(@Query() query: TransactionListQueryDto): Promise<TransactionPage> {
    return declaredOnly('MONEY-15', query);
  }

  /** W26's In and Out for one month. Declared before transactions/{id} so the literal path wins. */
  @Get('transactions/summary')
  @BuiltBy('MONEY-15')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  summary(@Query() query: MonthlySummaryQueryDto): Promise<MonthlySummaryView> {
    return declaredOnly('MONEY-15', query);
  }

  /** One row as a receipt (W27). Only the wallet's owner can read it. */
  @Get('transactions/:id')
  @BuiltBy('MONEY-15')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<TransactionView> {
    return declaredOnly('MONEY-15', id);
  }
}

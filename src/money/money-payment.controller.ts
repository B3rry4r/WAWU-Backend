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
import { HoldListQueryDto } from './dto/money-request.dto';
import {
  BuiltBy,
  declaredOnly,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type { HoldPage, HoldView, PaymentView } from './money-view.type';

/**
 * One payment as it stands (MONEY-19) and money held between payer and
 * payee in WAWU's merchant wallet (MONEY-18, R-19). Task MONEY-04 contract;
 * see money-contract.ts for why these handlers are declarations. The quote
 * and the payment itself are served by MONEY-17
 * (payments/money-payments.controller.ts).
 *
 * A hold is never moved by a client request: the owning feature releases it
 * (a DM answered, an event that took place, a bill delivered) or refunds it
 * (no answer in time, an event called off, a biller failure). These routes
 * only read holds.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPaymentController {
  /** One payment, as it stands now. Only the payer can read it. */
  @Get('payments/:id')
  @BuiltBy('MONEY-19')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  payment(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentView> {
    return declaredOnly('MONEY-19', id);
  }

  /** Holds the caller paid (role=payer) or is owed (role=payee), newest first. */
  @Get('holds')
  @BuiltBy('MONEY-18')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  holds(@Query() query: HoldListQueryDto): Promise<HoldPage> {
    return declaredOnly('MONEY-18', query);
  }

  /** One hold. Its payer and its payee can read it; nobody else. */
  @Get('holds/:id')
  @BuiltBy('MONEY-18')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  hold(@Param('id', ParseUUIDPipe) id: string): Promise<HoldView> {
    return declaredOnly('MONEY-18', id);
  }
}

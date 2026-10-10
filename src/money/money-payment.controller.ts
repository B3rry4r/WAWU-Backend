import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  BuiltBy,
  declaredOnly,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type { PaymentView } from './money-view.type';

/**
 * One payment as it stands (MONEY-19). Task MONEY-04 contract; see
 * money-contract.ts for why this handler is a declaration. The quote and the
 * payment itself are served by MONEY-17 (payments/money-payments.controller.ts),
 * the holds by MONEY-18 (holds/money-holds.controller.ts).
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
}

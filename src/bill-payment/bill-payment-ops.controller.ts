import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminKeyGuard } from '../common/guards/admin-key.guard';
import { BillPaymentService } from './bill-payment.service';
import { RecordRefundDto } from './dto/bill.dto';

/**
 * WAWUPay — the operator half.
 *
 * `FulfilmentStatus.refunded` had no writer at all, and `paid` (money taken,
 * biller not paid) had nothing looking for it, so a customer whose top-up
 * died mid-flight was told "our team will refund you" by a system in which no
 * refund could ever be recorded and no stuck row could ever be found.
 *
 * Separate controller because BillPaymentController is class-level
 * `@UseGuards(WawuAuthGuard)`; these are ops calls on the shared operator
 * key. New paths only.
 *
 * FOLLOW-UP: AdminKeyGuard is the interim shared-key idiom (see the guard).
 * Move these onto the real admin identity when it lands.
 */
@UseGuards(AdminKeyGuard)
@Controller('bills/ops')
export class BillPaymentOpsController {
  constructor(private readonly bills: BillPaymentService) {}

  /** Everything paid for and not delivered. */
  @Get('stuck')
  stuck() {
    return this.bills.listStuck();
  }

  /** Asks the biller what actually happened. A read — never a second payment. */
  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('id', ParseUUIDPipe) id: string) {
    return this.bills.reconcile(id);
  }

  /**
   * Records a refund a human has already sent. Named for what it is: this
   * endpoint moves no money, it writes down that money was moved.
   */
  @Post(':id/record-refund')
  @HttpCode(HttpStatus.OK)
  recordRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordRefundDto,
  ) {
    return this.bills.recordRefund(id, dto);
  }
}

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
import { AdminRole } from '../../generated/prisma/enums';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
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
 * `@UseGuards(WawuAuthGuard)`; an admin token is HS256 and would be rejected
 * by that guard before it was read. New paths only.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   stuck (read)                  — superadmin, finance, support
 *   reconcile, record-refund      — superadmin, finance
 *   reviewer                      — refused entirely
 *
 * This controller previously sat behind AdminKeyGuard: one shared static
 * secret, no identity, no roles.
 *
 * `support` reads the stuck queue because "you took my money and I got no
 * airtime" is a support ticket, and answering it should not require a finance
 * login. The rows carry the customer's own `customerRef` (their phone or meter
 * number) and their `buyerWawuId` — no card data, no bank account, nothing of
 * the kind that makes the KYC queue reviewer-only.
 *
 * `support` may not RECONCILE or RECORD A REFUND. Reconcile is described as a
 * read but it is not one on this side of the wire: it writes `delivered` or
 * `failed` off the biller's answer, and `delivered` is the state that stops
 * anyone ever looking at the row again. Record-refund is the bookkeeping entry
 * for cash a human has already moved. Both are money, and `finance` is the
 * role this backend already reserves for money.
 *
 * `reviewer` is refused throughout: it is the MODERATION role (creator content
 * and creator KYC), and nothing here is moderation. AdminRolesGuard does not
 * treat superadmin as implicitly allowed, so every handler names its roles.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('bills/ops')
export class BillPaymentOpsController {
  constructor(private readonly bills: BillPaymentService) {}

  /** Everything paid for and not delivered. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance, AdminRole.support)
  @Get('stuck')
  stuck() {
    return this.bills.listStuck();
  }

  /** Asks the biller what actually happened. A read — never a second payment. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.bills.reconcile(id, admin);
  }

  /**
   * Records a refund a human has already sent. Named for what it is: this
   * endpoint moves no money, it writes down that money was moved.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post(':id/record-refund')
  @HttpCode(HttpStatus.OK)
  recordRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordRefundDto,
    @CurrentAdmin() admin: AdminUserView,
  ) {
    return this.bills.recordRefund(id, dto, admin);
  }
}

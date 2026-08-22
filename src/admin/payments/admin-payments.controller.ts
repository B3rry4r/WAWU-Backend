import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminReceiptQueueQueryDto } from './dto/admin-receipt-queue-query.dto';

/**
 * Payment reconciliation — `/api/hub/admin/payments/*` once the global prefix
 * is applied.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   list, detail, re-verify — superadmin, finance
 *   reviewer, support       — refused entirely, on every route here
 *
 * The same two roles on all three routes, deliberately. Reconciliation is a
 * money function: the list carries customer emails and charge amounts, the
 * detail carries the raw provider payload, and the re-verify can cause a
 * grant. There is no read-only slice of this surface that is safe to widen —
 * a support agent who can see every charge on the platform is a data-exposure
 * decision, not a convenience, and nothing in a support workflow needs it.
 * Support's creator-side question ("did my subscription go through?") is
 * answered by `/admin/creators/:wawuId`, which carries the gate state without
 * the payment instrument.
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so each
 * handler names its roles and the matrix is readable here rather than implied
 * in the guard.
 *
 * Route order matters: the literal `receipts` collection is declared before
 * `receipts/:id`, and Nest matches in declaration order. `ParseUUIDPipe` on
 * `:id` would reject a stray literal anyway, but relying on a 400 to protect a
 * route is not the same as the route being reachable.
 *
 * That pipe is version-UNPINNED, matching AdminContentReviewController's
 * reasoning for the same class of id: `@default(uuid())` emits v4, but the
 * ids actually present in the data do not all — fixtures and seeds use
 * hand-written `…-0000-…` forms whose version nibble is 0. Pinning v4 would
 * 400 on real stored rows and the dashboard would render that as "not found".
 *
 * No path segment here collides with an existing controller: nothing outside
 * `src/admin/` declares an `admin` prefix, and the app's own payment surface
 * is `@Controller('webhooks/flutterwave')`, a different first segment.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly service: AdminPaymentsService) {}

  /**
   * Every webhook delivery this backend has recorded, newest first.
   * `?status=unresolved` narrows it to the README's reconciliation queue.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('receipts')
  listReceipts(@Query() query: AdminReceiptQueueQueryDto) {
    return this.service.listReceipts(query);
  }

  /** One receipt in full, including a freshly-computed reason it did not match. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('receipts/:id')
  receiptDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.receiptDetail(id);
  }

  /**
   * Re-run the REAL verification for a stuck charge.
   *
   * Not "mark as paid" — that control does not exist on this surface and the
   * service's class comment explains why. This re-asks Flutterwave for the
   * transaction and hands the answer to the owning flow's own verify logic,
   * which compares it against the amount the SERVER stored.
   *
   * `@HttpCode(200)`: nothing is created, and the ResponseInterceptor stamps
   * `statusCode: 200` into the body regardless (hazard H-3) — a 201 would ship
   * that mismatch into a new surface for no reason.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('receipts/:id/reverify')
  @HttpCode(HttpStatus.OK)
  reverify(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.reverify(id);
  }
}

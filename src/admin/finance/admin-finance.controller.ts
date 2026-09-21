import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { AdminFinanceService } from './admin-finance.service';
import { AdminFinanceWalletsService } from './admin-finance-wallets.service';
import { AdminFinancePeriodQueryDto } from './dto/admin-finance-period-query.dto';
import { AdminFinanceTransactionsQueryDto } from './dto/admin-finance-transactions-query.dto';
import { AdminFinancePayoutsQueryDto } from './dto/admin-finance-payouts-query.dto';
import {
  AdminFinanceWalletDetailQueryDto,
  AdminFinanceWalletsQueryDto,
} from './dto/admin-finance-wallets-query.dto';

/**
 * The money surface — `/api/hub/admin/finance/*` once the global prefix is
 * applied.
 *
 * ── EVERY ROUTE HERE IS A GET, AND THAT IS A RULE ────────────────────────
 * There is no adjust, no credit, no reverse, no manual payout and no "mark
 * as paid". Two separate reasons, both load-bearing:
 *
 *  - A creator's wallet is a Flutterwave payout subaccount in the creator's
 *    own name. WAWU does not custody that money and has no standing to move
 *    it outside the instructions the creator's own actions generate. An
 *    admin control that debited it would be WAWU moving somebody else's
 *    money out of somebody else's bank account.
 *  - A figure that looks wrong is a defect at its source. An override would
 *    make the books agree with the screen while the source row stayed wrong,
 *    and one compromised operator account would be able to move real money.
 *
 * `/admin/payments` already holds the two money-touching admin controls this
 * platform has (re-verify a stuck charge, retry a failed DM refund), and both
 * of those re-run a REAL settlement path rather than asserting an outcome.
 * Anything this surface turns out to need belongs there, on that pattern.
 *
 * ── ROLE MATRIX (documented, and enforced per handler) ────────────────────
 *   summary, transactions, payouts, wallets, wallets/:wawuId
 *                                     — superadmin, finance
 *   reviewer, support                 — refused entirely, on every route
 *
 * The same two roles as `/admin/payments`, for the same reason: these rows
 * carry every charge on the platform, every creator's earnings and their bank
 * details. There is no read-only slice of a whole platform's books that is
 * safe to widen to support, and nothing in a support workflow needs one -
 * their creator-side question is answered by `/admin/creators/:wawuId`.
 *
 * AdminRolesGuard does not treat superadmin as implicitly allowed, so each
 * handler names its roles and the matrix is readable here rather than implied
 * in the guard.
 *
 * ── ROUTE SAFETY ─────────────────────────────────────────────────────────
 * `admin/finance` is a first segment nothing outside `src/admin/` declares,
 * and no other admin controller declares `finance`. Inside this controller
 * the literal `wallets` collection is declared before `wallets/:wawuId`, and
 * Nest matches in declaration order.
 *
 * `:wawuId` carries NO ParseUUIDPipe, matching this backend's other
 * `:wawuId` handlers (`/admin/creators/:wawuId`): a WAWU ID is minted by
 * WAWU ID, not by this database, and the ids actually present in the data
 * include hand-written `...-0000-...` forms whose version nibble is 0. A
 * pipe would 400 on real stored rows and a dashboard would render that as
 * "not found".
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(
    private readonly finance: AdminFinanceService,
    private readonly wallets: AdminFinanceWalletsService,
  ) {}

  /**
   * Gross taken, WAWU's share, the creators' share and a transaction count,
   * per revenue stream, for `?from=&to=` (default: this calendar month).
   *
   * Only settled charges are counted, and each stream reports which of its
   * own statuses that means on `countedStatuses`.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('summary')
  summary(@Query() query: AdminFinancePeriodQueryDto) {
    return this.finance.summary(query);
  }

  /**
   * The ledger: one row per money movement across all six payment tables,
   * newest first, filterable by stream, status, date range and creator.
   *
   * Unlike the summary this does NOT hide unsettled charges by default.
   * "Where did this charge go" is the question the screen exists for, and it
   * is unanswerable if the failed ones are invisible.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('transactions')
  transactions(@Query() query: AdminFinanceTransactionsQueryDto) {
    return this.finance.transactions(query);
  }

  /** What has left for creators' bank accounts, and what is earned and has not. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('payouts')
  payouts(@Query() query: AdminFinancePayoutsQueryDto) {
    return this.wallets.payouts(query);
  }

  /**
   * One row per creator account: KYC state, whether Flutterwave has opened a
   * payout subaccount, the lifetime ledger figures, and - on request -
   * Flutterwave's own balance.
   *
   * Declared before `wallets/:wawuId`; Nest matches in declaration order.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('wallets')
  listWallets(@Query() query: AdminFinanceWalletsQueryDto) {
    return this.wallets.wallets(query);
  }

  /** One creator's wallet with its transaction history. The balance is always Flutterwave's. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('wallets/:wawuId')
  walletDetail(
    @Param('wawuId') wawuId: string,
    @Query() query: AdminFinanceWalletDetailQueryDto,
  ) {
    return this.wallets.walletDetail(wawuId, query);
  }
}

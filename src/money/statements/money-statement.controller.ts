import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import { STATEMENT_THROTTLE } from './statement-config';
import { StatementQueryDto } from './statement-query.dto';
import type { StatementView } from './statement-view.type';
import { StatementService } from './statement.service';

/**
 * Statements (task WALLET-27, W38): the caller's completed movements over a
 * period, as a CSV file in the usual envelope.
 *
 * The caller is the token: the route takes no wallet id and no wawuUserId,
 * so a person can only ever get their own statement. Behind the wallet gate
 * (MONEY-13): no wallet yet is `409 wallet_not_open` (or `wallet_opening`)
 * before anything is read. Read from the ledger only; it never calls
 * Fintava, so it never answers `provider_unreachable`. `no-store`, as the
 * history: a statement for today changes as money moves.
 *
 * Emailing the statement (W38 "Send to") is not served: the backend has no
 * email sender (BACKEND_GAPS G-69). A stamped PDF is not served: Fintava
 * issues no statement (G-68).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyStatementController {
  constructor(private readonly statements: StatementService) {}

  /**
   * One statement. `from` and `to` are calendar days in Africa/Lagos time
   * and BOTH are included: from 00:00 on `from` to 23:59:59.999 on `to`,
   * Lagos time. A day that does not exist, `from` after `to`, `to` after
   * today in Lagos, or more than 366 days is a 400; a period with more than
   * 50,000 movements is `400 statement_too_large`. At most 5 a minute and 30
   * an hour per person per address (429 beyond).
   */
  @Get('statements')
  @Throttle(STATEMENT_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-27')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'statement_too_large')
  statement(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: StatementQueryDto,
  ): Promise<StatementView> {
    return this.statements.statement(wallet, query);
  }
}

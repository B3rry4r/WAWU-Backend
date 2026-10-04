import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import { StatementRateLimiter } from './statement-config';
import { StatementQueryDto } from './statement-query.dto';
import type { StatementView } from './statement-view.type';
import { checkedPeriod, StatementService } from './statement.service';
import { MoneyError } from '../money-error';

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
  constructor(
    private readonly statements: StatementService,
    private readonly limiter: StatementRateLimiter,
  ) {}

  /**
   * One statement. `from` and `to` are calendar days in Africa/Lagos time
   * and BOTH are included: from 00:00 on `from` to 23:59:59.999 on `to`,
   * Lagos time. A day that does not exist, `from` after `to`, `to` after
   * today in Lagos, or more than 366 days is a 400; a period with more than
   * 50,000 movements is `400 statement_too_large`. The app's global
   * per-address limits apply as on every route; on top, one person may ask
   * for 5 a minute and 30 an hour (`429 statement_rate_limited`, counted
   * here, after the token is verified), and two statements are built at
   * once in the process (`503 statement_busy` after 5 s of waiting).
   * The route's own 400s never count: the period is checked before the
   * person is counted, and `statement_too_large` gives the place back.
   */
  @Get('statements')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-27')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'statement_too_large',
    'statement_rate_limited',
    'statement_busy',
  )
  async statement(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: StatementQueryDto,
  ): Promise<StatementView> {
    // A period that is not a real one is a 400 before anything is counted.
    checkedPeriod(query.from, query.to, new Date());
    // The guards have run: the token is verified and the wallet found, so
    // this key is a real person's and a forged token never reaches here.
    const giveBack = this.limiter.take(wallet.wawuUserId);
    try {
      return await this.statements.statement(wallet, query);
    } catch (e) {
      // Too many rows is the person's to fix by a shorter range, like the
      // other 400s: it does not count (lead ruling, round 4). A busy answer
      // (503) does count.
      if (e instanceof MoneyError && e.code === 'statement_too_large')
        giveBack();
      throw e;
    }
  }
}

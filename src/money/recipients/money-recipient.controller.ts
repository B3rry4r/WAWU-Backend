import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RecipientSearchQueryDto } from '../dto/money-request.dto';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { RecipientView } from '../money-view.type';
import { RECIPIENT_SEARCH_THROTTLE } from './recipient-config';
import { RecipientService } from './recipient.service';

/**
 * Finding a person to send money to (task WALLET-08, W7). Declared by
 * MONEY-04, served here (docs/contract/CONVENTIONS.md section 0).
 *
 * Both routes need an open wallet (MONEY-13's gate, `@RequireOpenWallet()`:
 * `409 wallet_not_open` or `409 wallet_opening` before anything else runs),
 * and act for the caller's token: no route takes whose list to read. Every
 * answer is `no-store`: it is a list of people the caller pays.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyRecipientController {
  constructor(private readonly recipients: RecipientService) {}

  /** WAWU users with an open wallet, by name, @handle or phone (W7). Blocked people never appear. At most 20. */
  // A phone (080..., 80..., 234..., +234...) is found only in full; a name or
  // @handle by its beginning, 2 characters at least (shorter is a 400).
  // Limited per address, tighter than the global limits (a 429 past it).
  @Get('recipients')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-08')
  @RequireOpenWallet()
  @Throttle(RECIPIENT_SEARCH_THROTTLE)
  @MoneyErrors(...WALLET_GATE_ERRORS)
  search(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: RecipientSearchQueryDto,
  ): Promise<RecipientView[]> {
    return this.recipients.search(wallet.wawuUserId, query.q);
  }

  /** The people this user sent money to most recently, newest first (W7). At most 10. */
  @Get('recipients/recent')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-08')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  recentRecipients(
    @CurrentWallet() wallet: OpenWallet,
  ): Promise<RecipientView[]> {
    return this.recipients.recent(wallet.wawuUserId);
  }
}

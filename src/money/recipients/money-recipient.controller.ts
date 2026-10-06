import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { RecipientSearchQueryDto } from '../dto/money-request.dto';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import {
  BuiltBy,
  MaxItems,
  MoneyErrors,
  PlainBadRequest,
  WALLET_GATE_ERRORS,
} from '../money-contract';
import type { RecipientView } from '../money-view.type';
import {
  RECENT_RECIPIENTS_MAX,
  RECIPIENT_SEARCH_MAX,
  RECIPIENT_SEARCH_THROTTLE,
  RecipientSearchLimiter,
} from './recipient-config';
import { readRecipientQuery } from './recipient-query';
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
  constructor(
    private readonly recipients: RecipientService,
    private readonly limiter: RecipientSearchLimiter,
  ) {}

  /** WAWU users with an open wallet, by name, @handle or phone (W7). Blocked people never appear. At most 20. */
  // A phone (080..., 80..., 234..., +234...) is found only in full; a name or
  // @handle by its beginning, 2 characters at least (shorter is a plain 400).
  // Limited per address (a 429 with no `reason`, from the global guard) and
  // per person (`429 recipient_search_rate_limited`, counted here after the
  // token is verified and the wallet found, with `Retry-After`). A search the
  // route refuses with a 400 is read before it is counted and does not count.
  @Get('recipients')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-08')
  @MaxItems(RECIPIENT_SEARCH_MAX)
  @RequireOpenWallet()
  @Throttle(RECIPIENT_SEARCH_THROTTLE)
  @PlainBadRequest(
    'q is missing, repeated, shorter than 2 characters (not counting a leading @) or longer than 60, or another field was sent. No `reason`: a malformed field.',
  )
  @MoneyErrors(...WALLET_GATE_ERRORS, 'recipient_search_rate_limited')
  search(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: RecipientSearchQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecipientView[]> {
    const read = readRecipientQuery(query.q);
    try {
      this.limiter.take(wallet.wawuUserId);
    } catch (e) {
      if (e instanceof MoneyError) {
        const seconds = (
          e.getResponse() as { reason?: { retryAfterSeconds?: number } }
        ).reason?.retryAfterSeconds;
        if (seconds !== undefined) res.set('Retry-After', String(seconds));
      }
      throw e;
    }
    return this.recipients.search(wallet.wawuUserId, read);
  }

  /** The people this user sent money to most recently, newest first (W7). At most 10. */
  @Get('recipients/recent')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-08')
  @MaxItems(RECENT_RECIPIENTS_MAX)
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS)
  recentRecipients(
    @CurrentWallet() wallet: OpenWallet,
  ): Promise<RecipientView[]> {
    return this.recipients.recent(wallet.wawuUserId);
  }
}

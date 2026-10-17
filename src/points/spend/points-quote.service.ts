import { Injectable } from '@nestjs/common';
import { PointsJobQuoteToken } from './points-job-quote-token';
import { PointsShortfallService } from './points-shortfall.service';
import { PointsSpendService } from './points-spend.service';
import type { PointsQuoteDto } from './points-spend.dto';
import type { PointsQuoteView } from './points-spend-view.type';

/**
 * `POST /points/quote` (task POINTS-03, PT1 to PT3 and PT7): what a job
 * costs before it runs, whether the person's points cover it, and what stops
 * it. It holds nothing and takes nothing. With a shortfall and "Use wallet"
 * on it also shows the wallet money that would buy the shortfall; the money
 * moves only when the person confirms with the PIN (`POST /points/shortfall`).
 * When a cap stops the job no wallet money is offered: buying points would
 * not let it run.
 */
@Injectable()
export class PointsQuoteService {
  constructor(
    private readonly spend: PointsSpendService,
    private readonly shortfall: PointsShortfallService,
    private readonly tokens: PointsJobQuoteToken,
  ) {}

  async quote(
    wawuUserId: string,
    dto: PointsQuoteDto,
  ): Promise<PointsQuoteView> {
    const a = await this.spend.assess(wawuUserId, dto);
    const useWallet = await this.spend.useWalletOf(wawuUserId);
    let wallet: PointsQuoteView['wallet'] = null;
    let walletNote: string | null = null;
    if (useWallet && a.shortfallPoints > 0 && a.cap === null) {
      const offer = await this.shortfall.offer(wawuUserId, a.shortfallPoints);
      wallet = offer.wallet;
      walletNote = offer.note;
    }
    return {
      action: a.job.action,
      title: a.job.title,
      per: a.job.per,
      units: a.job.units,
      languages: a.job.languages,
      perUnitPoints: a.job.perUnitPoints,
      costPoints: a.job.costPoints,
      balancePoints: a.balancePoints,
      shortfallPoints: a.shortfallPoints,
      useWallet,
      quoteToken: this.tokens.issue(wawuUserId, a.job.action, a.job.costPoints),
      canRun: a.shortfallPoints === 0 && a.cap === null,
      cap: a.cap,
      wallet,
      walletNote,
    };
  }
}

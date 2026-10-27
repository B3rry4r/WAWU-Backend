import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaidDmPauseService } from '../../direct-message/paid-dm-pause.service';
import {
  ALREADY_WAITING,
  BLOCKED_MESSAGE,
  CREATOR_NOT_FOUND,
  NOT_ACCEPTING,
  OWN_QUESTION,
  PAID_DM_KIND,
  PAUSED_MESSAGE,
} from '../../direct-message/wallet/paid-dm-wallet-rules';
import type { StoreErrorCode } from '../store-error';
import type { TargetCheck } from '../store-buy-target.service';
import { QUESTION_EARNING_TITLE } from './store-question-rules';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRICE_CHANGED = 'The price has changed. Please refresh and try again.';

const refuse = (code: StoreErrorCode, message: string): TargetCheck => ({
  ok: false,
  code,
  message,
});

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Whether a person may ask this creator a paid question in the store
 * (STORE-QUESTION, R-101). It is the wallet path's own validation read the
 * same way (`PaidDmWalletService.askable`): the creator exists, has paid
 * messages switched on at a price, is not the person themselves, is not
 * blocked either way, is not paused for missing replies (INBOX-09), and the
 * person has no question still waiting on them. The creator's price is the
 * list price the app named (the same rule as a piece's price).
 *
 * Asked twice, like the other targets: when the intent is made (with
 * `listNaira`) and when the store sale is granted (tolerating a price that
 * moved: the person paid the price they were shown).
 */
@Injectable()
export class StoreQuestionTargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
    private readonly pause: PaidDmPauseService,
  ) {}

  async check(
    userId: string,
    creatorId: string,
    opts: { listNaira?: number; tolerateChangedPrice?: boolean } = {},
  ): Promise<TargetCheck> {
    const notFound = refuse('store_intent_target_not_found', CREATOR_NOT_FOUND);
    if (!UUID.test(creatorId)) return notFound;
    if (creatorId === userId)
      return refuse('store_intent_not_payable', OWN_QUESTION);
    const [state, profile] = await Promise.all([
      this.prisma.creatorState.findUnique({
        where: { wawuUserId: creatorId },
        select: { dmPrice: true, dmEnabled: true, dmResponseHours: true },
      }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: creatorId },
        select: { wawuUserId: true },
      }),
    ]);
    if (!state || !profile) return notFound;
    if (!state.dmEnabled || state.dmPrice == null)
      return refuse('store_intent_not_payable', NOT_ACCEPTING);
    if (await this.blocked.isBlockedEitherWay(userId, creatorId))
      return refuse('store_intent_not_payable', BLOCKED_MESSAGE);
    try {
      await this.pause.assertAccepting(creatorId);
    } catch (e) {
      if (e instanceof ForbiddenException)
        return refuse('store_intent_not_payable', PAUSED_MESSAGE);
      throw e;
    }
    if ((await this.waiting(this.prisma, userId, creatorId)) > 0)
      return refuse('store_intent_not_payable', ALREADY_WAITING);
    const priceChanged =
      opts.listNaira !== undefined && state.dmPrice !== opts.listNaira;
    if (priceChanged && opts.tolerateChangedPrice !== true)
      return refuse('store_intent_price_changed', PRICE_CHANGED);
    return {
      ok: true,
      priceChanged,
      target: {
        kind: 'question',
        targetId: creatorId,
        creatorWawuId: creatorId,
        title: QUESTION_EARNING_TITLE,
        responseWindowHours: state.dmResponseHours ?? 24,
      },
    };
  }

  /**
   * How many questions of this person are waiting on this creator: sent and
   * not yet answered or refunded (from the wallet, the web or a store), plus
   * wallet payments still being confirmed or delivered. One question waits
   * per creator (G-75).
   */
  async waiting(db: Db, askerId: string, creatorId: string): Promise<number> {
    const [sent, paying] = await Promise.all([
      db.directMessage.count({
        where: {
          senderWawuId: askerId,
          creatorWawuId: creatorId,
          status: 'awaiting_response',
        },
      }),
      db.walletPayment.count({
        where: {
          kind: PAID_DM_KIND,
          payerWawuUserId: askerId,
          payeeWawuUserId: creatorId,
          OR: [
            { status: 'pending' },
            { status: 'completed', fulfilledAt: null },
          ],
        },
      }),
    ]);
    return sent + paying;
  }
}

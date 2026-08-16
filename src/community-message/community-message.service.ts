import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreditSpendService } from '../credit-spend/credit-spend.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { CommunityMessage } from '../common/types';
import type { CreateCommunityMessageDto } from './dto/create-community-message.dto';

/** 7 days, mirrors CreditsStateService's own trial window constant (wave 0). */
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * CommunityMessage resource — frozen endpoints `GET /communities/:id/messages`
 * and `POST /communities/:id/messages` (roles: ["any"] on both — any
 * authenticated WAWU user, no creator gate on top of the credits gate
 * described below).
 *
 * `POST` is the one non-trivial contract in this resource: the registry
 * note reads "Server checks CreditsState.creditBalance>0 OR within 7-day
 * trial before accepting; decrements by 1; 402-style rejection with buy
 * more credits if balance=0 and trial ended." CreditsStateModule does not
 * export CreditsStateService (same situation as LearnEntitlement /
 * CourseEnrollment against CreditsState's sibling resources in an earlier
 * wave), so this service reads/writes the `CreditsState` table directly via
 * the shared, globally-registered PrismaService — mirroring exactly how
 * CreditPurchaseService (also outside credits-state/) already does this
 * (see credit-purchase.service.ts's own `TRIAL_DURATION_MS` comment, which
 * calls itself out as mirroring this same constant).
 *
 * Gate + decrement semantics (judgment call, since the task brief leaves
 * the exact interaction underspecified):
 *   - A sender with `creditBalance > 0` spends from that real balance,
 *     regardless of whether their trial is also still active. The message
 *     costs `costInCredits` (schema default 1); the balance is decremented
 *     by that amount, floored at 0 so it can never go negative.
 *   - A sender with `creditBalance === 0` is only let through if their
 *     trial is still active (`trialEndsAt > now`). That message is
 *     "trial-covered" — there is no real balance to decrement, so none is
 *     decremented (0 stays 0). This is the literal reading of the task
 *     brief's own phrasing: "not spending a trial-covered message that has
 *     no balance to decrement" — trial-covered specifically means the
 *     no-balance case, not "trial active" in general.
 *   - Neither condition holds (`creditBalance === 0` AND trial expired) ->
 *     402 rejection.
 *
 * A CreditsState row is lazily created for a first-time sender exactly like
 * CreditsStateService.getOrCreate does for GET /credits (same default: 0
 * balance, a fresh 7-day trial from *now*) — CommunityMessage is one of the
 * two documented write-paths onto this table (the other being
 * CreditPurchase.verify), per credits-state.service.ts's own doc comment.
 *
 * On every successful send (trial-covered or balance-spent) this service
 * also calls CreditSpendService.record() — CreditSpendModule exports that
 * service specifically for this purpose (see credit-spend.module.ts's own
 * doc comment: "export CreditSpendService for the CommunityMessage
 * module"). Judgment call: the ledger row is written unconditionally, not
 * only on real-balance spends, because CreditSpend carries no monetary
 * field (`creditsSpent` is hardcoded to 1 by CreditSpendService itself) —
 * it is a volume/attribution ledger for the community host's earnings
 * rollup, not a cash-movement record, so gating it on "did this draw down
 * real balance" would undercount exactly the trial-period messages WAWU
 * wants visible to the host.
 */
@Injectable()
export class CommunityMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creditSpendService: CreditSpendService,
  ) {}

  private async assertCommunityExists(
    communityId: string,
  ): Promise<{ id: string; hostWawuId: string }> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, hostWawuId: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  /**
   * List order: newest-first (`sentAt: 'desc'`), matching this codebase's
   * one existing chat-like sibling — CommentService.list() also orders
   * `createdAt: 'desc'` for a threaded/reverse-chronological feed. No
   * screen-level pagination-direction spec exists for community chat in
   * this repo, so "match the sibling precedent" (per the task brief) means
   * newest-first here too.
   */
  async list(
    communityId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<CommunityMessage>> {
    await this.assertCommunityExists(communityId);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.communityMessage.findMany({
        where: { communityId },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.communityMessage.count({ where: { communityId } }),
    ]);

    return { items, currentPage: page, perPage, total };
  }

  async create(
    communityId: string,
    senderWawuId: string,
    dto: CreateCommunityMessageDto,
  ): Promise<CommunityMessage> {
    const community = await this.assertCommunityExists(communityId);

    const creditsState = await this.getOrCreateCreditsState(senderWawuId);
    const hasRealBalance = creditsState.creditBalance > 0;
    const trialActive = creditsState.trialEndsAt.getTime() > Date.now();

    if (!hasRealBalance && !trialActive) {
      throw new HttpException(
        {
          message:
            'Out of WAWU Credits and your trial has ended. Buy more credits to keep messaging in this community.',
          reason: 'insufficient_credits',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const message = await this.prisma.communityMessage.create({
      data: {
        communityId,
        senderWawuId,
        text: dto.text,
      },
    });

    if (hasRealBalance) {
      const nextBalance = Math.max(
        0,
        creditsState.creditBalance - message.costInCredits,
      );
      await this.prisma.creditsState.update({
        where: { userWawuId: senderWawuId },
        data: { creditBalance: nextBalance },
      });
    }
    // else: trial-covered send — no real balance to decrement, balance stays 0.

    await this.creditSpendService.record({
      userWawuId: senderWawuId,
      communityId,
      creatorWawuId: community.hostWawuId,
    });

    return message;
  }

  /** Mirrors CreditsStateService.getOrCreate exactly (find, else create with a fresh trial). */
  private async getOrCreateCreditsState(
    userWawuId: string,
  ): Promise<{ creditBalance: number; trialEndsAt: Date }> {
    const existing = await this.prisma.creditsState.findUnique({
      where: { userWawuId },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.creditsState.create({
      data: {
        userWawuId,
        creditBalance: 0,
        trialEndsAt: new Date(Date.now() + TRIAL_DURATION_MS),
      },
    });
  }
}

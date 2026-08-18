import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  CreditSpendService,
  DEFAULT_CREDITS_SPENT,
  type CreditSpendPrismaClient,
} from '../credit-spend/credit-spend.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { CommunityMessage } from '../common/types';
import type { CreateCommunityMessageDto } from './dto/create-community-message.dto';

/** 7 days, mirrors CreditsStateService's own trial window constant (wave 0). */
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Price of one community message, mirroring `CommunityMessage.costInCredits`'s
 * schema default. Written explicitly onto the row (rather than left to the
 * default) so the row, the balance debit and the CreditSpend ledger row all
 * agree on one number — they were previously free to diverge.
 */
const MESSAGE_COST_IN_CREDITS = DEFAULT_CREDITS_SPENT;

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
 *   - A sender whose balance covers `costInCredits` (schema default 1)
 *     spends from that real balance, regardless of whether their trial is
 *     also still active. The debit is a conditional UPDATE guarded on
 *     sufficient balance, so it can never go negative and never double-spend
 *     under concurrency (see create()).
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
 * field (`creditsSpent` records the message's real `costInCredits`) —
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
   * Membership gate. `CommunityMembership` and the join/leave endpoints
   * existed, but nothing consulted them: any authenticated user could read a
   * community's entire history and post into it without ever joining, and a
   * private community's pending (unapproved) request behaved like full
   * membership. The host always has access to their own community.
   */
  private async assertMember(
    communityId: string,
    userWawuId: string,
    hostWawuId: string,
  ): Promise<void> {
    if (userWawuId === hostWawuId) return;
    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'joined') {
      throw new ForbiddenException(
        'Join this community to read or post in it.',
      );
    }
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
    readerWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<CommunityMessage>> {
    const community = await this.assertCommunityExists(communityId);
    await this.assertMember(communityId, readerWawuId, community.hostWawuId);

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

  /**
   * Credits are debited ATOMICALLY. This used to read the balance, compute
   * `balance - cost` in JS and write the result back: two sends racing on
   * one balance of 1 both read 1, both wrote 0, and one message was sent
   * free. The debit is now a single conditional `updateMany` — the balance
   * guard lives in the WHERE clause, so Postgres row-locks and only one of
   * the two concurrent statements can match. Its `count` IS the answer to
   * "did this sender have the credits?", so there is no read-then-write
   * window left to lose.
   *
   * The debit, the message row and the CreditSpend ledger row all run in one
   * interactive transaction: a failure anywhere rolls the credit back
   * instead of charging for a message that was never stored.
   */
  async create(
    communityId: string,
    senderWawuId: string,
    dto: CreateCommunityMessageDto,
  ): Promise<CommunityMessage> {
    const community = await this.assertCommunityExists(communityId);
    await this.assertMember(communityId, senderWawuId, community.hostWawuId);

    const cost = MESSAGE_COST_IN_CREDITS;

    return this.prisma.$transaction(async (tx) => {
      const creditsState = await this.getOrCreateCreditsState(senderWawuId, tx);

      const { count } = await tx.creditsState.updateMany({
        where: { userWawuId: senderWawuId, creditBalance: { gte: cost } },
        data: { creditBalance: { decrement: cost } },
      });
      const spentRealBalance = count > 0;

      // Trial-covered send: no balance to debit, so nothing was debited.
      // (Unchanged semantics — see the class doc comment.)
      const trialActive = creditsState.trialEndsAt.getTime() > Date.now();
      if (!spentRealBalance && !trialActive) {
        throw new HttpException(
          {
            message:
              'Out of WAWU Credits and your trial has ended. Buy more credits to keep messaging in this community.',
            reason: 'insufficient_credits',
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      const message = await tx.communityMessage.create({
        data: {
          communityId,
          senderWawuId,
          text: dto.text,
          costInCredits: cost,
        },
      });

      await this.creditSpendService.record(
        {
          userWawuId: senderWawuId,
          communityId,
          creatorWawuId: community.hostWawuId,
          creditsSpent: cost,
        },
        tx,
      );

      return message;
    });
  }

  /**
   * Mirrors CreditsStateService.getOrCreate (row, else a fresh 7-day trial),
   * as an upsert rather than find-then-create so two first-ever sends from
   * the same user can't race into a duplicate-key 500.
   */
  private async getOrCreateCreditsState(
    userWawuId: string,
    client: CreditSpendPrismaClient = this.prisma,
  ): Promise<{ creditBalance: number; trialEndsAt: Date }> {
    return client.creditsState.upsert({
      where: { userWawuId },
      update: {},
      create: {
        userWawuId,
        creditBalance: 0,
        trialEndsAt: new Date(Date.now() + TRIAL_DURATION_MS),
      },
    });
  }
}

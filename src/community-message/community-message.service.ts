import {
  BadRequestException,
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
import type { CommunityKind } from '../../generated/prisma/enums';
import type { CommunityMessage } from '../common/types';
import { NotificationService } from '../notification/notification.service';
import type { CreateCommunityMessageDto } from './dto/create-community-message.dto';

/** 7 days, mirrors CreditsStateService's own trial window constant (wave 0). */
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Price of one community message, mirroring `CommunityMessage.costInCredits`'s
 * schema default. Written explicitly onto the row (rather than left to the
 * default) so the row, the balance debit and the CreditSpend ledger row all
 * agree on one number — they were previously free to diverge.
 *
 * ONE PRICE, WHATEVER IS IN THE MESSAGE. A message carrying an image costs
 * the same 1 credit as a message carrying text, and a message carrying both
 * still costs 1. docs/01_SPEC.md defines a credit as "1 credit = 1 message";
 * pricing by content type would make a member's balance unpredictable
 * ("how many photos is 48 credits?") and would invent a rate the spec does
 * not contain. The count stays the count.
 */
const MESSAGE_COST_IN_CREDITS = DEFAULT_CREDITS_SPENT;

/**
 * What an ENTITLED message costs: nothing. Written onto
 * `CommunityMessage.costInCredits` so the stored row says, truthfully, that
 * this message was not paid for — the same 0 the seeded host message already
 * carries (prisma/seed.ts, MESSAGE_FOUNDERS_1). Nothing is debited and NO
 * `CreditSpend` row is written for one of these; see `resolveEntitlement`.
 */
const FREE_MESSAGE_COST_IN_CREDITS = 0;

/**
 * Warn the sender once their remaining WAWU Credits drop to this COUNT or
 * below. A count, never a naira value (CLAUDE.md) — credits are not money
 * and cannot be cashed out.
 *
 * The warning fires only on the send that CROSSES the threshold (previous
 * balance above it, new balance at or below), plus the send that empties the
 * balance entirely. Emitting whenever `balance <= 5` would put a
 * notification on every one of the next five messages.
 */
const LOW_CREDITS_THRESHOLD = 5;

/**
 * Why a given message is free, or `'credits'` if it isn't.
 *
 *  - `'host'`         — the sender hosts this community.
 *  - `'subscription'` — the sender holds a paid creator subscription and this
 *                       is an OPEN community.
 *  - `'credits'`      — ordinary metered messaging: 1 credit, or the 7-day
 *                       trial, or 402.
 */
type MessageEntitlement = 'host' | 'subscription' | 'credits';

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
 * That credits gate applies only to senders who are NOT entitled to send
 * for free. `resolveEntitlement()` runs first and decides that; everything
 * below describes the metered path it falls through to.
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
 * That lazy creation happens on the METERED path only: an entitled sender
 * never touches this table, so sending does not silently burn a trial the
 * sender did not need.
 *
 * On every successful METERED send (trial-covered or balance-spent) this
 * service also calls CreditSpendService.record() — CreditSpendModule
 * exports that service specifically for this purpose (see
 * credit-spend.module.ts's own doc comment: "export CreditSpendService for
 * the CommunityMessage module").
 *
 * What lands in the ledger, exactly:
 *   - balance-spent message  -> one CreditSpend row, `creditsSpent: 1`.
 *   - trial-covered message  -> one CreditSpend row, `creditsSpent: 1`.
 *     Pre-existing judgment call, deliberately left alone: CreditSpend
 *     carries no monetary field, it is a volume/attribution ledger, and
 *     trial-period messages are ones WAWU wants visible to the host. NOTE
 *     for whoever turns this ledger into naira: a trial message was never
 *     paid for by anybody, so a straight 90% of `creditsSpent` over-counts
 *     by the trial rows. That is a live question for CreatorEarnings, not
 *     for this service, and it is not silently changed here.
 *   - entitled message (host, or subscriber in an open community)
 *     -> NO row, no balance movement, `costInCredits: 0` on the message.
 *        Nothing was spent, so the ledger says nothing was spent.
 */
@Injectable()
export class CommunityMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creditSpendService: CreditSpendService,
    private readonly notifications: NotificationService,
  ) {}

  private async assertCommunityExists(
    communityId: string,
  ): Promise<{ id: string; hostWawuId: string; kind: CommunityKind }> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      // `kind` is read here (not only `hostWawuId`) because the paid
      // subscription's "unlimited messages" entitlement is scoped to OPEN
      // communities — see resolveEntitlement().
      select: { id: true, hostWawuId: true, kind: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  /**
   * ---------------------------------------------------------------------
   * WHO PAYS FOR A MESSAGE.
   * ---------------------------------------------------------------------
   *
   * This used to be "everybody, always, 1 credit", which contradicted the
   * locked spec in two places and charged the wrong person in the second:
   *
   *  1. docs/01_SPEC.md §4 sells "Unlimited messages in open communities" as
   *     a Basic-tier subscription perk (Pro is a strict superset of Basic, so
   *     it carries the same line). Nothing in this service had ever heard of
   *     a subscription, so a creator paid ₦5,999/year for an entitlement that
   *     did not exist in the backend.
   *  2. The HOST was debited for posting in their own room, and could be
   *     402'd out of a community they own — while being, per §1 stream 4,
   *     the party who earns 90% of every credit spent in it. A host with an
   *     empty balance and an expired trial was locked out of moderating,
   *     welcoming or answering in their own community.
   *
   * The rules now, in evaluation order:
   *
   *  1. **Host — always free, in OPEN and PRIVATE alike.** Unconditional and
   *     first, so it cannot be undercut by balance, trial or tier. A host is
   *     the payee of this stream; charging them is charging someone to be
   *     paid. This also matches the convention already established elsewhere
   *     in this resource — `assertMember` short-circuits on the host for
   *     READS — and the seeded host message already carries
   *     `costInCredits: 0`.
   *
   *  2. **Paid subscription + OPEN community — free.** `CreatorState
   *     .subscriptionPaid` is this backend's canonical "the subscription is
   *     live" read: it is what ContentPieceService.create, CommunityService
   *     .create and CreatorEarningsService.resolveCommissionRate all consult,
   *     and the hourly scheduler clears it the moment a subscription lapses
   *     (scheduler.service.ts), so a lapsed creator falls straight back to
   *     paying. Deliberately tier-BLIND: §4 lists the line under Basic, and
   *     Pro is Basic plus extras, so gating it on `tier === 'pro'` would take
   *     away from Basic exactly the thing Basic was sold.
   *
   *     KYC is deliberately NOT consulted (CLAUDE.md: the two creator gates
   *     are independent — `subscriptionPaid` gates what you may do,
   *     `kycStatus` gates being paid; "paid + KYC pending" is a normal
   *     state). Neither is `UserProfile.accountType`: `subscriptionPaid` is
   *     already the stronger claim — you cannot have paid without being a
   *     creator account — and re-deriving account type here would invent a
   *     second, divergent read of creator status.
   *
   *  3. **Everyone else — 1 credit**, or the 7-day trial, or 402. Unchanged;
   *     this is the documented model for ordinary users (§3: "After trial:
   *     must hold credits to send messages in general/open communities").
   *
   * PRIVATE COMMUNITIES — the reading, stated rather than assumed.
   * ------------------------------------------------------------
   * A non-host member of a PRIVATE community pays 1 credit per message
   * exactly as before, INCLUDING a subscribed creator. Two reasons:
   *
   *  - The entitlement's own words are "Unlimited messages in **open**
   *     communities", and it sits immediately beside "cannot open/host
   *     private communities" in the Basic list. The spec is drawing the
   *     open/private line in that very sentence; extending the free tier
   *     across it would be this backend inventing a perk.
   *  - Removing the charge in private rooms would also delete the private
   *     host's earnings. Private hosting is Pro's headline differentiator
   *     (§4) and CreditSpend is what a host's 90% is computed from, so
   *     making private messaging free would mean Pro creators pay ₦18,999 for
   *     a room that can never earn.
   *
   * The counter-argument, for the record, because it is not frivolous: §1
   * names stream 4 "general/open community messaging" and §3 rule 3 says
   * credits "spend only on general-community messages", which can be read as
   * private rooms being outside the credits model altogether. That reading is
   * not taken here: §3's three rules exist to stop credits becoming a
   * cashable wallet (their targets are "PPV, downloads, DMs, tips"), not to
   * carve private rooms out of community messaging — and a message in a
   * private community is still a community message. If product wants private
   * rooms unmetered, that is a one-line change here plus a decision about how
   * a private host earns instead; it is not something this fix should decide
   * silently.
   */
  private async resolveEntitlement(
    community: { hostWawuId: string; kind: CommunityKind },
    senderWawuId: string,
  ): Promise<MessageEntitlement> {
    if (senderWawuId === community.hostWawuId) {
      return 'host';
    }
    if (community.kind !== 'open') {
      return 'credits';
    }

    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: senderWawuId },
      select: { subscriptionPaid: true },
    });
    return creatorState?.subscriptionPaid ? 'subscription' : 'credits';
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
   *
   * None of that applies to an ENTITLED send (see resolveEntitlement) —
   * there is no debit and no ledger row to keep in step with the message, so
   * it is a plain single INSERT and needs no transaction.
   */
  async create(
    communityId: string,
    senderWawuId: string,
    dto: CreateCommunityMessageDto,
  ): Promise<CommunityMessage> {
    // Text, an image, or both — never neither. Checked before the community
    // is even looked up, and long before a credit is debited: an empty
    // message must never cost anybody anything. (The DTO cannot express this
    // either/or per field; the table's CHECK constraint backs it up.)
    const text = dto.text?.trim() ?? null;
    const imageUrl = dto.imageUrl ?? null;
    if (!text && !imageUrl) {
      throw new BadRequestException(
        'A message needs something in it — write something, attach a photo, or both.',
      );
    }

    const community = await this.assertCommunityExists(communityId);
    await this.assertMember(communityId, senderWawuId, community.hostWawuId);

    const entitlement = await this.resolveEntitlement(community, senderWawuId);

    // ENTITLED SEND — the host in their own room, or a paid subscriber in an
    // open one. Nothing about credits happens on this path AT ALL:
    //   - no CreditsState row is read, created or debited (so an entitled
    //     sender's 7-day trial is neither consumed nor started by sending,
    //     and no balance they bought is silently drained);
    //   - the 402 gate is never reached, so a host can never be locked out
    //     of their own community;
    //   - NO CreditSpend row is written. That ledger is what the host's 90%
    //     is computed from (CreatorEarningsService), and no credit was spent
    //     here by anybody. Writing a row for a free message would invent
    //     earnings out of nothing — and for the host's own messages it would
    //     be the host paying themselves, inflating their own payout every
    //     time they answered a question in their room.
    // The message row records `costInCredits: 0`, which is the truth.
    if (entitlement !== 'credits') {
      return this.prisma.communityMessage.create({
        data: {
          communityId,
          senderWawuId,
          text,
          imageUrl,
          costInCredits: FREE_MESSAGE_COST_IN_CREDITS,
        },
      });
    }

    const cost = MESSAGE_COST_IN_CREDITS;

    // Hoisted out of the transaction closure so the credits-low warning
    // below can tell a real debit from a trial-covered send. Read only after
    // the transaction has committed.
    let spentRealBalance = false;

    const message = await this.prisma.$transaction(async (tx) => {
      const creditsState = await this.getOrCreateCreditsState(senderWawuId, tx);

      const { count } = await tx.creditsState.updateMany({
        where: { userWawuId: senderWawuId, creditBalance: { gte: cost } },
        data: { creditBalance: { decrement: cost } },
      });
      spentRealBalance = count > 0;

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
          text,
          imageUrl,
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

    // AFTER the commit, never inside it: a notification must not be able to
    // roll back a message the sender has already paid a credit for, and the
    // balance it reports has to be the committed one.
    if (spentRealBalance) {
      await this.warnIfCreditsLow(senderWawuId, cost);
    }

    return message;
  }

  /**
   * Tell the sender their WAWU Credits are running out — as a COUNT, never a
   * naira value, and never as a balance that could be withdrawn (CLAUDE.md).
   *
   * Only called after a send that actually drew down real balance, so the
   * pre-send count is exactly `remaining + cost`. That lets the warning fire
   * on the crossing send alone rather than on every send from then on. The
   * `remaining === 0` arm covers the last credit being spent, where the
   * crossing test has already fired on an earlier message.
   */
  private async warnIfCreditsLow(
    senderWawuId: string,
    cost: number,
  ): Promise<void> {
    const state = await this.prisma.creditsState.findUnique({
      where: { userWawuId: senderWawuId },
      select: { creditBalance: true },
    });
    if (!state) return;

    const remaining = state.creditBalance;
    const before = remaining + cost;
    const crossedThreshold =
      before > LOW_CREDITS_THRESHOLD && remaining <= LOW_CREDITS_THRESHOLD;

    if (crossedThreshold || remaining === 0) {
      await this.notifications.emit({
        kind: 'credits_low',
        userWawuId: senderWawuId,
        creditsCount: remaining,
      });
    }
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

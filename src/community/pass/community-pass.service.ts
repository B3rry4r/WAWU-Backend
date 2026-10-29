import { NoticeFacts } from '../../notice-mail/notice-facts';
import { noticeKey, NoticeMailer } from '../../notice-mail/notice-mailer';
import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { MoneyError } from '../../money/money-error';
import { loadMoneyParties } from '../../money/money-party';
import type { PaymentView } from '../../money/money-view.type';
import { deliverOrRefund } from '../../money/payments/deliver-or-refund';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import { CommunityPassAccess } from './community-pass-access.service';
import { grantPassPeriod } from './community-pass-grant';
import {
  COMMUNITY_PASS_KIND,
  COMMUNITY_PASS_ROUTE,
  nextPassPeriod,
  PASS_PERIOD_DAYS,
  passDaysFromTerms,
  passIsActive,
  passTitle,
} from './community-pass-rules';
import type { CommunityPassDto } from './community-pass.dto';
import type {
  CommunityPassPurchaseStatus,
  CommunityPassPurchaseView,
  CommunityPassQuoteView,
  CommunityPassView,
} from './community-pass-view.type';

export { COMMUNITY_PASS_ROUTE };

/** The hold's `releaseCondition` for a pass that is being paid back. */
export const PASS_REFUND_CONDITION = 'pass_granted';

export const PASS_ROOM_NOT_FOUND = 'We could not find that room.';
export const PASS_NOT_SOLD = 'This room does not sell a pass.';
export const PASS_OWN_ROOM = 'You host this room, so you do not need a pass.';
/** A removed member cannot buy their way back; the host lets them in. No em-dash: a person reads it. */
export const PASS_REMOVED =
  'The host has removed you from this room. Ask the host to let you back in.';
export const PASS_PAYMENT_NOT_FOUND = 'We could not find that payment.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A private community's monthly pass, paid from the wallet (task INBOX-24,
 * R-63; I30, I31).
 *
 * - **The payment is MONEY-17's.** A pass is a wallet payment of kind
 *   `community_pass` whose target is the community's id, at the host's price
 *   (the server's record, never the app's), into WAWU's own account. The
 *   provider's charge and WAWU's fee go on top (R-10); the quote, the PIN, the
 *   Idempotency-Key, the daily limit and the provider seam (R-39) are all the
 *   payment service's. This file reaches no provider.
 * - **The host's 85% is an earning (R-5, R-55).** The pass has a payee, is not
 *   held, and so is taken by the earnings sweep like any sale: one
 *   `EarningSettlement` for the 85%, which travels in the host's one move a
 *   day with their other earnings. A host with no wallet keeps it owed (R-11).
 * - **30 days, from the later of today and the current end** (R-63). The pass
 *   is a row per payment; the person's pass runs to the latest `endsAt`. The
 *   grant runs under a lock keyed by person and room, so two payments chain
 *   instead of both starting from the same end.
 * - **Granted once per payment.** `onCompleted` runs in the request and again
 *   from the payment sweep until it has succeeded, on any server; the pass
 *   row's `walletPaymentId` is unique, so a repeat writes nothing.
 * - **A pass that cannot be granted is paid back in full** (the room stopped
 *   selling a pass, or the host and the person can no longer deal): the price,
 *   the provider's charge and WAWU's fee all go back, because the person did
 *   not cause it. The payment keeps no earning.
 * - **Nothing is debited by itself.** There is no renewal job. The reminder
 *   (CommunityPassReminderService) only tells the person; renewing is a new
 *   payment with the PIN.
 */
@Injectable()
export class CommunityPassService implements OnModuleInit {
  private readonly logger = new Logger(CommunityPassService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly blocked: BlockedAccountService,
    private readonly wawuId: WawuIdClient,
    private readonly access: CommunityPassAccess,
    private readonly mail: NoticeMailer,
    private readonly facts: NoticeFacts,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: COMMUNITY_PASS_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(COMMUNITY_PASS_ROUTE, (view) =>
      this.present(view),
    );
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** `GET /communities/:id/pass`: where the caller stands. Needs no wallet. */
  async pass(
    communityId: string,
    viewerWawuId: string,
  ): Promise<CommunityPassView> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        hostWawuId: true,
        passPrice: { select: { priceKobo: true } },
      },
    });
    if (!community) throw new NotFoundException(PASS_ROOM_NOT_FOUND);
    await this.blocked.assertRoomVisible(
      viewerWawuId,
      community.hostWawuId,
      communityId,
      PASS_ROOM_NOT_FOUND,
    );
    const isHost = community.hostWawuId === viewerWawuId;
    const until = isHost
      ? null
      : await this.access.passUntil(communityId, viewerWawuId);
    const sellsPass = community.passPrice !== null;
    const removed =
      !isHost && sellsPass && (await this.isRemoved(viewerWawuId, communityId));
    return {
      communityId,
      sellsPass,
      priceKobo: community.passPrice
        ? Number(community.passPrice.priceKobo)
        : null,
      periodDays: PASS_PERIOD_DAYS,
      passUntil: until ? until.toISOString() : null,
      active: passIsActive(until, new Date()),
      canRenew: sellsPass && !isHost && !removed && until !== null,
      canBuy: sellsPass && !isHost && !removed,
      isHost,
    };
  }

  /** The pay sheet: the pass priced, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    communityId: string,
  ): Promise<CommunityPassQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: COMMUNITY_PASS_KIND,
      targetId: communityId,
    });
    const until = await this.access.passUntil(communityId, wallet.wawuUserId);
    const now = new Date();
    const running = passIsActive(until, now) ? until : null;
    return {
      communityId,
      title: payment.title,
      host: payment.payee,
      priceKobo: payment.priceKobo,
      periodDays: PASS_PERIOD_DAYS,
      passUntil: running ? running.toISOString() : null,
      newPassUntil: nextPassPeriod(now, running).endsAt.toISOString(),
      payment,
    };
  }

  /**
   * Pays for a pass from the wallet. The answer, and every replay of the
   * request's key, is the purchase as `present` builds it.
   */
  async buy(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    communityId: string,
    dto: CommunityPassDto,
  ): Promise<CommunityPassPurchaseView> {
    const payment = await this.payments.pay(
      wallet,
      {
        kind: COMMUNITY_PASS_KIND,
        targetId: communityId,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as CommunityPassPurchaseView | undefined) ??
      this.present(payment)
    );
  }

  /** One purchase as it stands now. Only the payer reads it, for the room in the path. */
  async read(
    wawuUserId: string,
    communityId: string,
    id: string,
  ): Promise<CommunityPassPurchaseView> {
    const payment = await this.prisma.walletPayment.findFirst({
      where: {
        id,
        payerWawuUserId: wawuUserId,
        kind: COMMUNITY_PASS_KIND,
        targetId: communityId,
      },
    });
    if (!payment) throw new MoneyError('not_found', PASS_PAYMENT_NOT_FOUND);
    return this.present(this.payments.view(payment, null));
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** True when the host removed the person from this pass room (their row is pending). */
  private async isRemoved(
    wawuUserId: string,
    communityId: string,
  ): Promise<boolean> {
    const row = await this.prisma.communityMembership.findUnique({
      where: {
        userWawuId_communityId: { userWawuId: wawuUserId, communityId },
      },
      select: { status: true },
    });
    return row?.status === 'pending';
  }

  /** Prices the pass in the target. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    if (!UUID.test(lookup.targetId))
      throw new MoneyError('target_not_found', PASS_ROOM_NOT_FOUND);
    const community = await this.prisma.community.findUnique({
      where: { id: lookup.targetId },
      select: {
        id: true,
        name: true,
        hostWawuId: true,
        passPrice: { select: { priceKobo: true } },
      },
    });
    if (!community)
      throw new MoneyError('target_not_found', PASS_ROOM_NOT_FOUND);
    if (lookup.payerWawuUserId === community.hostWawuId)
      throw new MoneyError('target_not_payable', PASS_OWN_ROOM);
    if (
      await this.blocked.isBlockedEitherWay(
        lookup.payerWawuUserId,
        community.hostWawuId,
      )
    )
      throw new MoneyError('target_not_found', PASS_ROOM_NOT_FOUND);
    if (!community.passPrice)
      throw new MoneyError('target_not_payable', PASS_NOT_SOLD);
    // A pending row in a pass room is a member the host removed. Paying does
    // not undo that, and nothing is taken from someone who would not get in.
    if (await this.isRemoved(lookup.payerWawuUserId, community.id))
      throw new MoneyError('target_not_payable', PASS_REMOVED);
    const party = (
      await loadMoneyParties(this.prisma, this.wawuId, [community.hostWawuId])
    ).get(community.hostWawuId);
    if (!party) throw new MoneyError('target_not_found', PASS_ROOM_NOT_FOUND);
    return {
      title: passTitle(community.name),
      priceKobo: Number(community.passPrice.priceKobo),
      payee: party,
      // The days are bound to the quote: what is granted is what was quoted.
      terms: { periodDays: PASS_PERIOD_DAYS },
    };
  }

  /**
   * The payment is confirmed: give the pass once, or pay it back when it
   * cannot be given. Idempotent and safe on two servers at once.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const hostId = payment.payeeWawuUserId;
    if (!hostId)
      throw new Error(
        `Payment ${payment.paymentId} is a pass with no host to pay.`,
      );
    const communityId = payment.targetId;
    const userId = payment.payerWawuUserId;
    const days = passDaysFromTerms(payment.terms);
    // Read outside the decision's transaction: it calls nothing across a network.
    const dealingStopped = await this.blocked.isBlockedEitherWay(
      userId,
      hostId,
    );
    const result = await deliverOrRefund(this.prisma, this.holds, payment, {
      condition: PASS_REFUND_CONDITION,
      refusal: async (tx) => {
        const room = await tx.community.findUnique({
          where: { id: communityId },
          select: {
            hostWawuId: true,
            passPrice: { select: { communityId: true } },
          },
        });
        if (!room) return 'the room is gone';
        if (room.hostWawuId !== hostId) return 'the room has another host';
        if (!room.passPrice) return 'the room no longer sells a pass';
        if (dealingStopped) return 'the host and the person can no longer deal';
        // A pending row in a pass room is a member the host removed (round 3).
        // A payment that was in flight when the host removed them must not put
        // them back: nothing is given and every naira is paid back. The row is
        // locked, so a removal that lands after this read waits for the grant
        // and the person ends removed, never admitted by the payment.
        const rows = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS "status" FROM "CommunityMembership"
          WHERE "userWawuId" = ${userId} AND "communityId" = ${communityId}
          FOR UPDATE`;
        if (rows[0]?.status === 'pending')
          return 'the host removed the person from the room';
        return null;
      },
      grant: (tx) =>
        grantPassPeriod(tx, {
          communityId,
          userWawuId: userId,
          reference: payment.paymentId,
          priceKobo: BigInt(payment.priceKobo),
          days,
        }),
    });
    if (result.outcome === 'refund') {
      this.logger.warn(
        `payment ${payment.paymentId}: the pass could not be given (${result.why}); everything paid is going back`,
      );
      return;
    }
    // EMAIL-02: once, after the pass is committed (only the call that wrote
    // the pass row is `granted`; a repeat writes nothing). The host's share is
    // the payment's own row.
    if (result.granted) {
      this.mail.later(async () => {
        const paid = await this.facts.payment(payment.paymentId);
        const communityName = await this.facts.communityName(communityId);
        if (!paid || communityName === null) return;
        const [buyerName, paidWhen] = await Promise.all([
          this.facts.nameOf(userId),
          this.facts.paidWhen(hostId, 'wallet'),
        ]);
        this.mail.notify(
          hostId,
          'pass_sold',
          {
            communityName,
            buyerName,
            earnedMinor: paid.payeeShareKobo,
            currency: 'NGN',
            paidWhen,
          },
          noticeKey('pass_sold', payment.paymentId),
        );
      });
    }
    this.logger.log(`payment ${payment.paymentId}: pass given`);
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The purchase a payment is, as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<CommunityPassPurchaseView> {
    if (view.kind !== COMMUNITY_PASS_KIND)
      throw new Error(`Payment ${view.id} is not a pass payment.`);
    const pass = await this.prisma.communityPass.findUnique({
      where: { walletPaymentId: view.id },
      select: { endsAt: true, createdAt: true },
    });
    const payback = pass
      ? null
      : await this.prisma.walletHold.findUnique({
          where: { paymentId: view.id },
          select: { action: true },
        });
    const status: CommunityPassPurchaseStatus = pass
      ? 'paid'
      : payback
        ? 'refunded'
        : statusOf(view.status);
    return {
      id: view.id,
      method: 'wallet',
      communityId: view.targetId,
      title: view.title,
      status,
      statusMessage: pass
        ? null
        : payback
          ? 'This pass could not be given, so everything you paid is going back to your wallet.'
          : (view.failureReason ?? view.statusMessage),
      priceKobo: view.priceKobo,
      passUntil: pass ? pass.endsAt.toISOString() : null,
      payment: view,
      createdAt: view.createdAt,
      paidAt: pass ? pass.createdAt.toISOString() : null,
    };
  }
}

/** A payment that is not paid, as a purchase status. */
function statusOf(status: PaymentView['status']): CommunityPassPurchaseStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}

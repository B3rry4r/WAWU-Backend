import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { netOfCommission } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { loadMoneyParties } from '../../money/money-party';
import { MoneyError } from '../../money/money-error';
import type { MoneyPartyView, PaymentView } from '../../money/money-view.type';
import { deliverOrRefund } from '../../money/payments/deliver-or-refund';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import { NotificationService } from '../../notification/notification.service';
import {
  MAX_TIP_KOBO,
  MIN_TIP_KOBO,
  type TipWalletDto,
  type TipWalletQuoteQueryDto,
} from './tip-wallet.dto';
import type {
  TipWalletQuoteView,
  TipWalletStatus,
  TipWalletView,
} from './tip-wallet-view.type';

/** The route a wallet tip's Idempotency-Key is scoped to. */
export const TIP_WALLET_ROUTE = 'POST tips/wallet';

/** The payment kind this feature sells (docs/contract/WALLET.md). */
export const TIP_KIND = 'tip';

/** The hold's `releaseCondition` for a tip that is being paid back. */
export const TIP_REFUND_CONDITION = 'tip_delivered';

/** The commission snapshotted on every tip row: the one split, 85/15 (R-5). */
const TIP_COMMISSION_RATE = 0.15;
const KOBO_PER_NAIRA = 100;

export const TIP_PERSON_NOT_FOUND = 'We could not find that person.';
export const TIP_NOT_FOUND = 'We could not find that tip.';
export const TIP_BLOCKED = 'You cannot tip this account.';
export const TIP_AMOUNT_MESSAGE = `A tip is a whole number of naira, from ₦1 to ₦10,000,000.`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reference a wallet tip's purchase row carries in place of a Flutterwave charge's (the column is required and unique). */
export const tipTxRef = (paymentId: string) => `wallet:${paymentId}`;

/**
 * Tip a creator from the wallet (task HOME-14, H26 to H28). The web's
 * `POST /tips` and `/tips/verify` (Flutterwave) are unchanged.
 *
 * - **The payment is MONEY-17's.** A tip is a wallet payment of kind `tip`
 *   whose target is the creator's wawuUserId and whose amount is the payer's
 *   (`amountKobo`, a whole number of naira, as the web's is), into WAWU's own
 *   account. The provider's charge goes on top (R-10), read from the fee
 *   settings by the payment service; the quote, the PIN, the Idempotency-Key,
 *   the daily limit and the provider seam (R-39) are all the payment
 *   service's. This file reaches no provider.
 * - **85/15 (R-5).** The payment records the split; the creator's 85% lands
 *   in their wallet by itself (WALLET-16, R-11), and a creator with no wallet
 *   keeps earning. WAWU keeps its 15%.
 * - **Recorded once per payment.** `onCompleted` runs in the request and
 *   again from the payment sweep until it has succeeded, on any server. It
 *   writes the web's own `Purchase` row of type `tip` (so the creator's
 *   earnings, the admin finance streams and the notification read it as they
 *   read a Flutterwave tip), keyed by `wallet:<payment id>` which is unique:
 *   a repeat writes nothing.
 * - **A tip that cannot be delivered is paid back.** If the creator's account
 *   is gone or has blocked the payer since the quote, the price goes back to
 *   the payer through MONEY-18's refund (the charge does not), decided in one
 *   short transaction that excludes the delivery (`deliverOrRefund`).
 */
@Injectable()
export class TipWalletService implements OnModuleInit {
  private readonly logger = new Logger(TipWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly blocked: BlockedAccountService,
    private readonly notifications: NotificationService,
    private readonly wawuId: WawuIdClient,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: TIP_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(TIP_WALLET_ROUTE, (view) => this.present(view));
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** The pay sheet (H26): the creator and the amount, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    q: TipWalletQuoteQueryDto,
  ): Promise<TipWalletQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: TIP_KIND,
      targetId: q.creatorWawuId,
      amountKobo: q.amountKobo,
    });
    return {
      creator: payment.payee as MoneyPartyView,
      amountKobo: q.amountKobo,
      payment,
    };
  }

  /**
   * Pays a tip from the wallet. The answer, and every replay of the
   * request's key, is the tip as `present` builds it.
   */
  async tip(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: TipWalletDto,
  ): Promise<TipWalletView> {
    const payment = await this.payments.pay(
      wallet,
      {
        kind: TIP_KIND,
        targetId: dto.creatorWawuId,
        amountKobo: dto.amountKobo,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      },
      scope,
    );
    return (
      (scope.answered as TipWalletView | undefined) ?? this.present(payment)
    );
  }

  /** One tip as it stands now. Only the payer reads it. */
  async read(wawuUserId: string, id: string): Promise<TipWalletView> {
    const payment = await this.prisma.walletPayment.findFirst({
      where: { id, payerWawuUserId: wawuUserId, kind: TIP_KIND },
    });
    if (!payment) throw new MoneyError('not_found', TIP_NOT_FOUND);
    return this.present(this.payments.view(payment, null));
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the tip. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const creatorId = lookup.targetId;
    if (!UUID.test(creatorId)) {
      throw new MoneyError('target_not_found', TIP_PERSON_NOT_FOUND);
    }
    const amount = lookup.amountKobo;
    if (
      amount === undefined ||
      !Number.isSafeInteger(amount) ||
      amount < MIN_TIP_KOBO ||
      amount > MAX_TIP_KOBO ||
      amount % KOBO_PER_NAIRA !== 0
    ) {
      throw new MoneyError('amount_out_of_range', TIP_AMOUNT_MESSAGE);
    }
    if (creatorId === lookup.payerWawuUserId) {
      throw new MoneyError('target_not_payable', 'You cannot tip yourself.');
    }
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: creatorId },
      select: { wawuUserId: true },
    });
    if (!profile)
      throw new MoneyError('target_not_found', TIP_PERSON_NOT_FOUND);
    if (
      await this.blocked.isBlockedEitherWay(lookup.payerWawuUserId, creatorId)
    ) {
      throw new MoneyError('target_not_payable', TIP_BLOCKED);
    }
    const party = (
      await loadMoneyParties(this.prisma, this.wawuId, [creatorId])
    ).get(creatorId);
    if (!party) throw new MoneyError('target_not_found', TIP_PERSON_NOT_FOUND);
    return {
      title: `Tip for ${party.displayName || party.handle || 'a creator'}`,
      priceKobo: amount,
      payee: party,
    };
  }

  /**
   * The payment is confirmed: record the tip once, or pay it back when it
   * cannot be delivered. Idempotent and safe on two servers at once.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const creatorId = payment.payeeWawuUserId;
    if (!creatorId) {
      throw new Error(`Payment ${payment.paymentId} is a tip with no creator.`);
    }
    const result = await deliverOrRefund(this.prisma, this.holds, payment, {
      condition: TIP_REFUND_CONDITION,
      refusal: async (tx) => {
        const profile = await tx.userProfile.findUnique({
          where: { wawuUserId: creatorId },
          select: { wawuUserId: true },
        });
        if (!profile) return 'the creator is gone';
        if (
          await this.blocked.isBlockedEitherWay(
            payment.payerWawuUserId,
            creatorId,
          )
        ) {
          return 'the creator and the payer are blocked';
        }
        return null;
      },
      grant: async (tx) => {
        const { count } = await tx.purchase.createMany({
          data: [
            {
              contentId: null,
              type: 'tip',
              buyerWawuId: payment.payerWawuUserId,
              creatorWawuId: creatorId,
              amount: payment.priceKobo / KOBO_PER_NAIRA,
              commissionRate: TIP_COMMISSION_RATE,
              flutterwaveTxRef: tipTxRef(payment.paymentId),
              flutterwaveTxId: null,
              status: 'completed',
              note: payment.note,
            },
          ],
          skipDuplicates: true,
        });
        return count > 0;
      },
    });
    if (result.outcome === 'refund') {
      this.logger.warn(
        `payment ${payment.paymentId}: the tip could not be delivered (${result.why}); the amount is going back`,
      );
      return;
    }
    if (result.granted) {
      try {
        await this.notifications.emit({
          kind: 'tip_received',
          userWawuId: creatorId,
          netAmount: netOfCommission(
            payment.priceKobo / KOBO_PER_NAIRA,
            TIP_COMMISSION_RATE,
          ),
          about: {
            target: { kind: 'profile', id: payment.payerWawuUserId },
            actorWawuId: payment.payerWawuUserId,
          },
        });
      } catch (e) {
        // The tip is recorded and paid for; a missed notification is not a reason to hold it.
        this.logger.error(
          `payment ${payment.paymentId}: the tip notification failed (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    this.logger.log(`payment ${payment.paymentId}: tip recorded`);
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The tip a payment is, as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<TipWalletView> {
    if (view.kind !== TIP_KIND)
      throw new Error(`Payment ${view.id} is not a tip payment.`);
    const row = await this.prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.id },
      select: { note: true, payeeWawuUserId: true },
    });
    const purchase = await this.prisma.purchase.findUnique({
      where: { flutterwaveTxRef: tipTxRef(view.id) },
      select: { purchasedAt: true },
    });
    const payback = purchase
      ? null
      : await this.prisma.walletHold.findUnique({
          where: { paymentId: view.id },
          select: { action: true },
        });
    const creator = row.payeeWawuUserId
      ? ((
          await loadMoneyParties(this.prisma, this.wawuId, [
            row.payeeWawuUserId,
          ])
        ).get(row.payeeWawuUserId) ?? null)
      : null;
    const status: TipWalletStatus = purchase
      ? 'paid'
      : payback
        ? 'refunded'
        : statusOf(view.status);
    return {
      id: view.id,
      method: 'wallet',
      status,
      statusMessage: purchase
        ? null
        : payback
          ? 'This tip could not be sent, so the amount is going back to your wallet.'
          : (view.failureReason ?? view.statusMessage),
      creator,
      amountKobo: view.priceKobo,
      note: row.note,
      payment: view,
      createdAt: view.createdAt,
      paidAt: purchase ? purchase.purchasedAt.toISOString() : null,
    };
  }
}

/** A payment that is not paid, as a tip status. */
function statusOf(status: PaymentView['status']): TipWalletStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}

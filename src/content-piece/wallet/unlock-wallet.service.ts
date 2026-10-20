import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { netOfCommission } from '../../common/money';
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
import { NotificationService } from '../../notification/notification.service';
import { StorageService } from '../../storage/storage.service';
import type { UnlockWalletDto } from './unlock-wallet.dto';
import type {
  UnlockWalletQuoteView,
  UnlockWalletStatus,
  UnlockWalletView,
} from './unlock-wallet-view.type';

/** The route a wallet unlock's Idempotency-Key is scoped to. */
export const UNLOCK_WALLET_ROUTE = 'POST content/:id/unlock/wallet';

/** The payment kind this feature sells (docs/contract/WALLET.md). */
export const UNLOCK_KIND = 'content_unlock';

/** The hold's `releaseCondition` for an unlock that is being paid back. */
export const UNLOCK_REFUND_CONDITION = 'unlock_granted';

/** The commission snapshotted on every purchase row: the one split, 85/15 (R-5). */
const UNLOCK_COMMISSION_RATE = 0.15;
const KOBO_PER_NAIRA = 100;

export const UNLOCK_NOT_FOUND = 'Content not found';
export const UNLOCK_FREE = 'This content is free, so no unlock is required.';
export const UNLOCK_OWNED = 'You have already unlocked this content.';
export const UNLOCK_PAYMENT_NOT_FOUND = 'We could not find that purchase.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reference a wallet unlock's purchase row carries in place of a Flutterwave charge's (the column is required and unique). */
export const unlockTxRef = (paymentId: string) => `wallet:${paymentId}`;

/**
 * Unlock a piece of content from the wallet (task HOME-15, H14 to H18). The
 * web's `POST /content/:id/unlock` and `/unlock/verify` (Flutterwave) are
 * unchanged.
 *
 * - **The payment is MONEY-17's.** An unlock is a wallet payment of kind
 *   `content_unlock` whose target is the piece's id, into WAWU's own account,
 *   at the price on the piece (the server's record, never the app's). The
 *   provider's charge goes on top (R-10); the quote, the PIN, the
 *   Idempotency-Key, the daily limit and the provider seam (R-39) are all the
 *   payment service's.
 * - **85/15 (R-5).** The creator's 85% lands in their wallet by itself
 *   (WALLET-16, R-11); a creator with no wallet keeps earning.
 * - **Access is granted once the debit settles, once per payment.** The grant
 *   is the web's own `Purchase` row of type `content` (what every access check
 *   and the creator's earnings already read), keyed by `wallet:<payment id>`
 *   which is unique: `onCompleted` runs in the request and again from the
 *   payment sweep until it has succeeded, on any server, and a repeat writes
 *   nothing. A debited-but-not-granted state fixes itself: the sweep grants it.
 * - **An unlock that cannot be granted is paid back** (the piece was taken
 *   down since the quote, or the person already owned it by another payment):
 *   the price and the charge go back through MONEY-18's refund,
 *   decided in one short transaction that excludes the grant.
 */
@Injectable()
export class UnlockWalletService implements OnModuleInit {
  private readonly logger = new Logger(UnlockWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly blocked: BlockedAccountService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly wawuId: WawuIdClient,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: UNLOCK_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(UNLOCK_WALLET_ROUTE, (view) =>
      this.present(view),
    );
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** The pay sheet (H14): the piece priced, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    contentId: string,
  ): Promise<UnlockWalletQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: UNLOCK_KIND,
      targetId: contentId,
    });
    return {
      contentId,
      title: payment.title,
      creator: payment.payee,
      priceKobo: payment.priceKobo,
      payment,
    };
  }

  /**
   * Pays for a piece from the wallet. The answer, and every replay of the
   * request's key, is the unlock as `present` builds it.
   */
  async unlock(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    contentId: string,
    dto: UnlockWalletDto,
  ): Promise<UnlockWalletView> {
    const payment = await this.payments.pay(
      wallet,
      {
        kind: UNLOCK_KIND,
        targetId: contentId,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as UnlockWalletView | undefined) ?? this.present(payment)
    );
  }

  /** One unlock as it stands now. Only the payer reads it, for the piece in the path. */
  async read(
    wawuUserId: string,
    contentId: string,
    id: string,
  ): Promise<UnlockWalletView> {
    const payment = await this.prisma.walletPayment.findFirst({
      where: {
        id,
        payerWawuUserId: wawuUserId,
        kind: UNLOCK_KIND,
        targetId: contentId,
      },
    });
    if (!payment) throw new MoneyError('not_found', UNLOCK_PAYMENT_NOT_FOUND);
    return this.present(this.payments.view(payment, null));
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the piece. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    if (!UUID.test(lookup.targetId))
      throw new MoneyError('target_not_found', UNLOCK_NOT_FOUND);
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: lookup.targetId },
      select: {
        id: true,
        title: true,
        price: true,
        accessType: true,
        status: true,
        creatorWawuId: true,
      },
    });
    if (!content || content.status !== 'live')
      throw new MoneyError('target_not_found', UNLOCK_NOT_FOUND);
    if (
      lookup.payerWawuUserId !== content.creatorWawuId &&
      (await this.blocked.isBlockedEitherWay(
        lookup.payerWawuUserId,
        content.creatorWawuId,
      ))
    )
      throw new MoneyError('target_not_found', UNLOCK_NOT_FOUND);
    if (content.accessType === 'free')
      throw new MoneyError('target_not_payable', UNLOCK_FREE);
    if (content.creatorWawuId === lookup.payerWawuUserId)
      throw new MoneyError(
        'target_not_payable',
        'You cannot buy your own content.',
      );
    const owned = await this.prisma.purchase.findFirst({
      where: {
        contentId: content.id,
        buyerWawuId: lookup.payerWawuUserId,
        type: 'content',
        status: 'completed',
      },
      select: { id: true },
    });
    if (owned) throw new MoneyError('target_not_payable', UNLOCK_OWNED);
    const party = (
      await loadMoneyParties(this.prisma, this.wawuId, [content.creatorWawuId])
    ).get(content.creatorWawuId);
    if (!party) throw new MoneyError('target_not_found', UNLOCK_NOT_FOUND);
    return {
      title: content.title,
      priceKobo: content.price * KOBO_PER_NAIRA,
      payee: party,
    };
  }

  /**
   * The payment is confirmed: give access once, or pay it back when it cannot
   * be given. Idempotent and safe on two servers at once.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const creatorId = payment.payeeWawuUserId;
    if (!creatorId)
      throw new Error(
        `Payment ${payment.paymentId} is an unlock with no creator.`,
      );
    const ref = unlockTxRef(payment.paymentId);
    const result = await deliverOrRefund(this.prisma, this.holds, payment, {
      condition: UNLOCK_REFUND_CONDITION,
      refusal: async (tx) => {
        const content = await tx.contentPiece.findUnique({
          where: { id: payment.targetId },
          select: { status: true },
        });
        if (!content || content.status !== 'live')
          return 'the piece is no longer for sale';
        const owned = await tx.purchase.findFirst({
          where: {
            contentId: payment.targetId,
            buyerWawuId: payment.payerWawuUserId,
            type: 'content',
            status: 'completed',
            flutterwaveTxRef: { not: ref },
          },
          select: { id: true },
        });
        if (owned) return 'the person already owns the piece';
        return null;
      },
      grant: async (tx) => {
        const { count } = await tx.purchase.createMany({
          data: [
            {
              contentId: payment.targetId,
              type: 'content',
              buyerWawuId: payment.payerWawuUserId,
              creatorWawuId: creatorId,
              amount: payment.priceKobo / KOBO_PER_NAIRA,
              commissionRate: UNLOCK_COMMISSION_RATE,
              flutterwaveTxRef: ref,
              flutterwaveTxId: null,
              status: 'completed',
              note: null,
            },
          ],
          skipDuplicates: true,
        });
        return count > 0;
      },
    });
    if (result.outcome === 'refund') {
      this.logger.warn(
        `payment ${payment.paymentId}: the unlock could not be granted (${result.why}); the price is going back`,
      );
      return;
    }
    if (result.granted) {
      try {
        const content = await this.prisma.contentPiece.findUnique({
          where: { id: payment.targetId },
          select: { id: true, title: true },
        });
        await this.notifications.emit({
          kind: 'sale',
          userWawuId: creatorId,
          contentTitle: content?.title ?? payment.targetId,
          netAmount: netOfCommission(
            payment.priceKobo / KOBO_PER_NAIRA,
            UNLOCK_COMMISSION_RATE,
          ),
          about: {
            target: { kind: 'content', id: payment.targetId },
            actorWawuId: payment.payerWawuUserId,
          },
        });
      } catch (e) {
        // The access is given and paid for; a missed notification is not a reason to hold it.
        this.logger.error(
          `payment ${payment.paymentId}: the sale notification failed (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
    this.logger.log(`payment ${payment.paymentId}: access given`);
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The unlock a payment is, as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<UnlockWalletView> {
    if (view.kind !== UNLOCK_KIND)
      throw new Error(`Payment ${view.id} is not an unlock payment.`);
    const purchase = await this.prisma.purchase.findUnique({
      where: { flutterwaveTxRef: unlockTxRef(view.id) },
      select: { purchasedAt: true },
    });
    const payback = purchase
      ? null
      : await this.prisma.walletHold.findUnique({
          where: { paymentId: view.id },
          select: { action: true },
        });
    const content = purchase
      ? await this.prisma.contentPiece.findUnique({
          where: { id: view.targetId },
          select: { fullAssetUrl: true },
        })
      : null;
    const fullAssetUrl = content
      ? await this.storage.freshUrlFor(content.fullAssetUrl)
      : null;
    const status: UnlockWalletStatus = purchase
      ? 'paid'
      : payback
        ? 'refunded'
        : statusOf(view.status);
    return {
      id: view.id,
      method: 'wallet',
      contentId: view.targetId,
      title: view.title,
      status,
      statusMessage: purchase
        ? null
        : payback
          ? 'This could not be unlocked, so the price is going back to your wallet.'
          : (view.failureReason ?? view.statusMessage),
      priceKobo: view.priceKobo,
      purchased: purchase !== null,
      fullAssetUrl,
      payment: view,
      createdAt: view.createdAt,
      paidAt: purchase ? purchase.purchasedAt.toISOString() : null,
    };
  }
}

/** A payment that is not paid, as an unlock status. */
function statusOf(status: PaymentView['status']): UnlockWalletStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}

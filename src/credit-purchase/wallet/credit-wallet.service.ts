import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { MoneyError } from '../../money/money-error';
import type { PaymentStatus, PaymentView } from '../../money/money-view.type';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import type { CreditPack } from '../../../generated/prisma/enums';
import { KOBO_PER_NAIRA, PACK_TABLE, packOf } from '../credit-packs';
import type {
  CreditWalletPurchaseDto,
  CreditWalletQuoteQueryDto,
} from './credit-wallet.dto';
import type {
  CreditPackListView,
  CreditPackView,
  CreditWalletPurchaseStatus,
  CreditWalletPurchaseView,
  CreditWalletQuoteView,
} from './credit-wallet-view.type';

/** The route a wallet credit purchase's Idempotency-Key is scoped to. */
export const CREDIT_WALLET_ROUTE = 'POST credits/purchase/wallet';

/** The payment kind this feature sells (docs/contract/WALLET.md). */
export const CREDIT_PACK_KIND = 'credit_pack';

export const PACK_NOT_FOUND_MESSAGE = 'We could not find that credit pack.';
export const PURCHASE_NOT_FOUND_MESSAGE = 'We could not find that purchase.';

/** The reference the purchase row carries in place of a Flutterwave charge's (the column is required and unique). */
export const walletTxRef = (paymentId: string) => `wallet:${paymentId}`;

/**
 * Buy WAWU Credits from the wallet (task INBOX-16, I28 and I29).
 *
 * - **The payment is MONEY-17's.** A purchase is a wallet payment of kind
 *   `credit_pack` whose target is the pack (`starter`, `popular` or `pro`), into
 *   WAWU's own account: it is WAWU's own sale, so there is no seller split and
 *   nothing is held (R-19 is for money owed to someone else; the 85/15 split
 *   is applied later, per spent credit, against the lot this purchase opens).
 *   The provider's charge is on top of the pack's price (R-10), read from the
 *   fee settings by the payment service and never set here. The quote, the PIN,
 *   the Idempotency-Key, the daily limit (WALLET-23) and the provider seam
 *   (R-39) are all the payment service's; this file reaches no provider.
 * - **The price is the server's table** (`PACK_TABLE`), the same one the web's
 *   Flutterwave purchase reads. The client names a pack, never an amount.
 * - **Credited once per payment.** `onCompleted` runs in the request, and
 *   again from the payment sweep until it has succeeded, on any server. It
 *   inserts the purchase row (its `walletPaymentId` is unique), then the
 *   balance and the cost-basis lot, in ONE database transaction that holds
 *   nothing else (no provider is called inside it). A repeat finds the row and
 *   writes nothing, so one payment gives one set of credits and one lot.
 * - **Nothing is credited for a payment that is not paid.** A pending, failed
 *   or reversed payment has no purchase row; the routes read its state from
 *   the payment itself.
 * - **A delivery that cannot finish** (the pack's price changed between the
 *   payment and the delivery, say) throws; the payment service tries again
 *   and then sends the payment to delivery review with the money safe in
 *   WAWU's account. Nothing about a pack can make the grant itself refuse, so
 *   this kind has no refund of its own.
 */
@Injectable()
export class CreditWalletService implements OnModuleInit {
  private readonly logger = new Logger(CreditWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: CREDIT_PACK_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(CREDIT_WALLET_ROUTE, (view) =>
      this.present(view),
    );
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** The packs on sale, from the server's table, cheapest first. */
  packs(): CreditPackListView {
    const packs = (Object.keys(PACK_TABLE) as CreditPack[])
      .map((pack) => packView(pack))
      .sort((a, b) => a.priceKobo - b.priceKobo);
    return { packs };
  }

  /** The pay sheet (I28): the pack priced, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    q: CreditWalletQuoteQueryDto,
  ): Promise<CreditWalletQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: CREDIT_PACK_KIND,
      targetId: q.pack,
    });
    return { ...packView(q.pack), payment };
  }

  /**
   * Pays for a pack from the wallet. The answer, and every replay of the
   * request's key, is the purchase as `present` builds it.
   */
  async buy(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: CreditWalletPurchaseDto,
  ): Promise<CreditWalletPurchaseView> {
    const payment = await this.payments.pay(
      wallet,
      {
        kind: CREDIT_PACK_KIND,
        targetId: dto.pack,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as CreditWalletPurchaseView | undefined) ??
      this.present(payment)
    );
  }

  /** One purchase as it stands now. Only the buyer reads it. */
  async read(
    wawuUserId: string,
    id: string,
  ): Promise<CreditWalletPurchaseView> {
    const payment = await this.prisma.walletPayment.findFirst({
      where: { id, payerWawuUserId: wawuUserId, kind: CREDIT_PACK_KIND },
    });
    if (!payment) throw new MoneyError('not_found', PURCHASE_NOT_FOUND_MESSAGE);
    return this.present(this.payments.view(payment, null));
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the pack in the target. Moves nothing. */
  private resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const pack = packOf(lookup.targetId);
    if (pack === null)
      return Promise.reject(
        new MoneyError('target_not_found', PACK_NOT_FOUND_MESSAGE),
      );
    const view = packView(pack);
    return Promise.resolve({
      title: titleOf(view.credits),
      priceKobo: view.priceKobo,
      payee: null,
    });
  }

  /**
   * The payment is confirmed: add the credits, once. Idempotent and safe to
   * run on two servers at once (see the class comment).
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const pack = packOf(payment.targetId);
    if (pack === null)
      throw new Error(`Payment ${payment.paymentId} names no credit pack.`);
    const info = PACK_TABLE[pack];
    if (payment.priceKobo !== info.amount * KOBO_PER_NAIRA)
      throw new Error(
        `Payment ${payment.paymentId} paid ${payment.priceKobo} kobo for the ${pack} pack, which costs ${info.amount * KOBO_PER_NAIRA} now.`,
      );
    const userWawuId = payment.payerWawuUserId;
    await this.prisma.$transaction(async (tx) => {
      // The once-per-payment gate: the row's `walletPaymentId` is unique, and a
      // second delivery waits here for the first to commit, then writes nothing.
      const { count } = await tx.creditPurchase.createMany({
        data: [
          {
            id: randomUUID(),
            userWawuId,
            pack,
            creditsGranted: info.credits,
            flutterwaveTxRef: walletTxRef(payment.paymentId),
            walletPaymentId: payment.paymentId,
            amount: info.amount,
            status: 'completed',
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return;
      const purchase = await tx.creditPurchase.findUniqueOrThrow({
        where: { walletPaymentId: payment.paymentId },
        select: { id: true, purchasedAt: true },
      });
      // The balance and the cost-basis lot are written together: a balance
      // credited without its lot would be spendable credits with no cost
      // basis, and the community host would earn nothing on money WAWU banked
      // (the same rule as the web's verified Flutterwave purchase).
      await tx.creditsState.upsert({
        where: { userWawuId },
        create: { userWawuId, creditBalance: info.credits },
        update: { creditBalance: { increment: info.credits } },
      });
      await tx.creditLot.createMany({
        data: [
          {
            creditPurchaseId: purchase.id,
            userWawuId,
            creditsGranted: info.credits,
            creditsRemaining: info.credits,
            grossKobo: payment.priceKobo,
            allocatedKobo: 0,
            purchasedAt: purchase.purchasedAt,
          },
        ],
        skipDuplicates: true,
      });
    });
    this.logger.log(
      `payment ${payment.paymentId}: ${info.credits} credits added`,
    );
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The purchase a payment is, as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<CreditWalletPurchaseView> {
    const pack = packOf(view.targetId);
    if (view.kind !== CREDIT_PACK_KIND || pack === null)
      throw new Error(`Payment ${view.id} is not a credit pack payment.`);
    const row = await this.prisma.creditPurchase.findUnique({
      where: { walletPaymentId: view.id },
      select: { userWawuId: true, purchasedAt: true },
    });
    const state = row
      ? await this.prisma.creditsState.findUnique({
          where: { userWawuId: row.userWawuId },
          select: { creditBalance: true },
        })
      : null;
    return {
      ...packView(pack),
      id: view.id,
      method: 'wallet',
      status: row ? 'paid' : statusOf(view.status),
      statusMessage: row ? null : (view.failureReason ?? view.statusMessage),
      payment: view,
      creditBalance: row ? (state?.creditBalance ?? null) : null,
      createdAt: view.createdAt,
      paidAt: row ? row.purchasedAt.toISOString() : null,
    };
  }
}

/** A pack as the sheet shows it. */
function packView(pack: CreditPack): CreditPackView {
  const info = PACK_TABLE[pack];
  return {
    pack,
    credits: info.credits,
    priceKobo: info.amount * KOBO_PER_NAIRA,
  };
}

/** What the payment is called in the history and the receipt: a count, never naira. */
function titleOf(credits: number): string {
  return `${credits} WAWU Credits`;
}

/** A payment that is not paid, as a purchase status. */
function statusOf(status: PaymentStatus): CreditWalletPurchaseStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}

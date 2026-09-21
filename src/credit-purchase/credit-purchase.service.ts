import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreditPack } from '../../generated/prisma/enums';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { CreateCreditPurchaseDto } from './dto/create-credit-purchase.dto';
import type { VerifyCreditPurchaseDto } from './dto/verify-credit-purchase.dto';

/**
 * `CreditPurchase.amount` is whole naira (every pack price is). Cost basis is
 * carried in kobo so the per-credit maths on a ₦1,000/120 pack stays exact
 * integer arithmetic instead of drifting through 8.3333 floats.
 */
const KOBO_PER_NAIRA = 100;

export interface FlutterwaveConfigResponse {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
}

/**
 * Server-side pack->price/credits table (registry.json CreditPurchase note:
 * "pack->amount/credits looked up server-side ... per product-truths.json").
 * Never accepted from the client.
 */
const PACK_TABLE: Record<CreditPack, { amount: number; credits: number }> = {
  starter: { amount: 500, credits: 50 },
  popular: { amount: 1000, credits: 120 },
  pro: { amount: 2000, credits: 300 },
};

/**
 * CreditPurchase resource — registry.json "CreditPurchase". Owns
 * POST /credits/purchase and POST /credits/purchase/verify. On a verified
 * charge, credits the caller's CreditsState.creditBalance by the pack's
 * creditsGranted (never a Naira value — CLAUDE.md non-negotiable: WAWU
 * Credits render as a COUNT, never cashable). CreditsState itself is owned
 * by the credits-state resource/directory (wave 0); this service only
 * mutates the balance column via the shared, globally-registered
 * PrismaService — it does not import credits-state's module/service (this
 * build's scope rule: create/edit files only inside src/credit-purchase/).
 */
@Injectable()
export class CreditPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  async createPurchase(
    userWawuId: string,
    dto: CreateCreditPurchaseDto,
  ): Promise<FlutterwaveConfigResponse> {
    const packInfo = PACK_TABLE[dto.pack];
    // Unreachable given @IsEnum(CreditPack) on the DTO, but keeps this
    // lookup honest against a future pack being added to the enum without
    // a matching PACK_TABLE entry.
    if (!packInfo) {
      throw new BadRequestException('Unknown credit pack');
    }

    const charge = this.flutterwave.initCharge({
      amount: packInfo.amount,
      purpose: 'credit-purchase',
      wawuUserId: userWawuId,
    });

    await this.prisma.creditPurchase.create({
      data: {
        userWawuId,
        pack: dto.pack,
        creditsGranted: packInfo.credits,
        flutterwaveTxRef: charge.txRef,
        amount: packInfo.amount,
        status: 'pending',
      },
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
    };
  }

  async verifyPurchase(
    userWawuId: string,
    dto: VerifyCreditPurchaseDto,
  ): Promise<{ creditBalance: number }> {
    const purchase = await this.prisma.creditPurchase.findFirst({
      where: { flutterwaveTxRef: dto.tx_ref, userWawuId },
    });
    if (!purchase) {
      throw new NotFoundException(
        'No matching credit purchase found for this reference',
      );
    }

    if (purchase.status === 'completed') {
      const state = await this.prisma.creditsState.findUnique({
        where: { userWawuId },
      });
      return { creditBalance: state?.creditBalance ?? 0 };
    }
    if (purchase.status === 'failed') {
      throw new BadRequestException(
        'This credit purchase already failed verification',
      );
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const verified =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === purchase.flutterwaveTxRef &&
      result.amount >= purchase.amount;

    if (!verified) {
      await this.prisma.creditPurchase.update({
        where: { id: purchase.id },
        data: { status: 'failed' },
      });
      throw new BadRequestException('Payment verification failed');
    }

    // Flip pending -> completed CONDITIONALLY and use the row count as the
    // right-to-credit. Two concurrent verifies of the same purchase both read
    // status 'pending' above, so an unconditional update let both proceed to
    // increment the balance — a free credit top-up by racing the endpoint.
    // Exactly one of them can match `status: 'pending'` here.
    const claimed = await this.prisma.creditPurchase.updateMany({
      where: { id: purchase.id, status: 'pending' },
      data: { status: 'completed' },
    });
    if (claimed.count === 0) {
      // Another request already completed this purchase and credited it.
      const existing = await this.prisma.creditsState.findUnique({
        where: { userWawuId },
      });
      return { creditBalance: existing?.creditBalance ?? 0 };
    }

    // Credit the balance AND open the cost-basis lot in one transaction.
    //
    // The lot is what makes the community host's 90% payable (docs/01_SPEC.md
    // §1 row 4). It records the exact kobo WAWU banked for exactly these
    // credits; spends draw it down FIFO and carry its cost basis onto
    // CreditSpendEarning (see src/credit-spend/credit-spend.service.ts).
    //
    // It is created HERE and nowhere else, and only on a verified,
    // `completed` charge — which is precisely the refund/failure guarantee
    // the model needs: a pending or failed purchase opens no lot, so its
    // credits can never be spent, so no host share can ever have been
    // counted against money that did not clear. A failed verify above has
    // already flipped the row to `failed` and returned before reaching this
    // point.
    //
    // Upsert on the balance, since CreditsState may not exist yet for this
    // user (credits-state's own getOrCreate is the *read*-path originator;
    // this is the *write*-path originator for a user who buys credits before
    // ever reading GET /credits). The two writes are transactional because a
    // balance credited without its lot would be spendable credits with no
    // cost basis — the host would silently earn ₦0 on money WAWU banked.
    const updated = await this.prisma.$transaction(async (tx) => {
      const state = await tx.creditsState.upsert({
        where: { userWawuId },
        create: {
          userWawuId,
          creditBalance: purchase.creditsGranted,
          // No trial is opened here any more. It was removed on the product
          // owner's instruction, 21 Sep 2026 ("no 7 day silly trials"), and
          // it made least sense on this path regardless: this row is created
          // because somebody just PAID for credits, so handing them free ones
          // in the same breath was never the intent.
        },
        update: {
          creditBalance: { increment: purchase.creditsGranted },
        },
      });

      // `CreditLot.creditPurchaseId` is unique, so this is the second,
      // structural guard against a double-verify minting a second lot (the
      // claim above is the first). `createMany ... skipDuplicates` keeps a
      // replay idempotent instead of 500-ing on the constraint.
      await tx.creditLot.createMany({
        data: [
          {
            creditPurchaseId: purchase.id,
            userWawuId,
            creditsGranted: purchase.creditsGranted,
            creditsRemaining: purchase.creditsGranted,
            grossKobo: purchase.amount * KOBO_PER_NAIRA,
            allocatedKobo: 0,
            purchasedAt: purchase.purchasedAt,
          },
        ],
        skipDuplicates: true,
      });

      return state;
    });

    return { creditBalance: updated.creditBalance };
  }
}

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

/** 7 days, mirrors CreditsStateService's own trial window constant (wave 0). */
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

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

    await this.prisma.creditPurchase.update({
      where: { id: purchase.id },
      data: { status: 'completed' },
    });

    // Credit the balance — upsert since CreditsState may not exist yet for
    // this user (credits-state's own getOrCreate is the *read*-path
    // originator; this is the *write*-path originator for a user who buys
    // credits before ever reading GET /credits).
    const updated = await this.prisma.creditsState.upsert({
      where: { userWawuId },
      create: {
        userWawuId,
        creditBalance: purchase.creditsGranted,
        trialEndsAt: new Date(Date.now() + TRIAL_DURATION_MS),
      },
      update: {
        creditBalance: { increment: purchase.creditsGranted },
      },
    });

    return { creditBalance: updated.creditBalance };
  }
}

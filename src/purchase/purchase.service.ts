import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { CreateTipDto } from './dto/create-tip.dto';
import type { VerifyTipDto } from './dto/verify-tip.dto';

/** Standard commission rate (conventions.md § Identity & format canon). */
const STANDARD_COMMISSION_RATE = 0.15;
/** Pro-tier commission rate, applied only while the Pro creator's subscription is active. */
const PRO_COMMISSION_RATE = 0.1;

export interface FlutterwaveConfigResponse {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
}

/**
 * Purchase resource — registry.json "Purchase". This service only owns the
 * two endpoints actually contracted to Purchase: POST /tips and
 * POST /tips/verify (creates `type: "tip"`, `contentId: null` rows).
 * `type: "content"` rows on the same table are written by ContentPiece's
 * own unlock/unlock-verify endpoints (a separate resource) — not this
 * service's concern.
 */
@Injectable()
export class PurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  /** Snapshotted at transaction time, never recomputed later (conventions.md). */
  private async resolveCommissionRate(creatorWawuId: string): Promise<number> {
    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { tier: true, subscriptionPaid: true },
    });
    if (
      creatorState &&
      creatorState.tier === 'pro' &&
      creatorState.subscriptionPaid
    ) {
      return PRO_COMMISSION_RATE;
    }
    return STANDARD_COMMISSION_RATE;
  }

  async createTip(
    buyerWawuId: string,
    dto: CreateTipDto,
  ): Promise<FlutterwaveConfigResponse> {
    if (dto.creatorWawuId === buyerWawuId) {
      throw new BadRequestException('Cannot tip yourself');
    }

    const recipient = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: dto.creatorWawuId },
      select: { wawuUserId: true },
    });
    if (!recipient) {
      throw new NotFoundException('Recipient not found');
    }

    const commissionRate = await this.resolveCommissionRate(dto.creatorWawuId);

    const charge = this.flutterwave.initCharge({
      amount: dto.amount,
      purpose: 'tip',
      wawuUserId: buyerWawuId,
    });

    await this.prisma.purchase.create({
      data: {
        contentId: null,
        type: 'tip',
        buyerWawuId,
        creatorWawuId: dto.creatorWawuId,
        amount: dto.amount,
        commissionRate,
        flutterwaveTxRef: charge.txRef,
        flutterwaveTxId: null,
        status: 'pending',
        note: dto.note ?? null,
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

  async verifyTip(
    buyerWawuId: string,
    dto: VerifyTipDto,
  ): Promise<{ tipped: true }> {
    const purchase = await this.prisma.purchase.findFirst({
      where: {
        flutterwaveTxRef: dto.tx_ref,
        buyerWawuId,
        type: 'tip',
      },
    });
    if (!purchase) {
      throw new NotFoundException('No matching tip found for this reference');
    }

    if (purchase.status === 'completed') {
      return { tipped: true };
    }
    if (purchase.status === 'failed') {
      throw new BadRequestException('This tip already failed verification');
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
      await this.prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: 'failed', flutterwaveTxId: result.transactionId },
      });
      throw new BadRequestException('Payment verification failed');
    }

    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: 'completed', flutterwaveTxId: result.transactionId },
    });

    return { tipped: true };
  }
}

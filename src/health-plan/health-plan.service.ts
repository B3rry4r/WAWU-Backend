import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import { WellaHealthClient, type HealthPlan } from './wellahealth.client';
import type { InitHealthSubscriptionDto } from './dto/health-plan.dto';

/**
 * WAWUCare.
 *
 * Same three-step shape as WAWUPay: record intent, take payment, verify, then
 * enrol with the partner. The plan price is read from WellaHealth at init time
 * rather than trusted from the client, so a tampered request cannot buy a
 * ₦15,000 plan for ₦600.
 */
@Injectable()
export class HealthPlanService {
  private readonly logger = new Logger(HealthPlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wella: WellaHealthClient,
    private readonly verifier: FlutterwaveCheckoutVerifier,
  ) {}

  listPlans(): Promise<HealthPlan[]> {
    return this.wella.listHealthPlans();
  }

  async init(wawuUserId: string, dto: InitHealthSubscriptionDto) {
    const plans = await this.wella.listHealthPlans();
    const plan = plans.find((p) => p.planCode === dto.planCode);
    if (!plan) {
      throw new BadRequestException('That health plan is no longer available.');
    }

    // Naira, whole numbers. WellaHealth quotes decimals (600.00).
    const price = Math.round(Number(plan.price));
    if (!Number.isFinite(price) || price <= 0) {
      throw new BadRequestException('That plan has no price set. Try another one.');
    }

    const txRef = `wawu-care-${randomUUID()}`;
    const record = await this.prisma.healthSubscription.create({
      data: {
        wawuUserId,
        planCode: plan.planCode,
        planName: plan.planName,
        price,
        phoneNumber: dto.phoneNumber,
        firstName: dto.firstName,
        lastName: dto.lastName,
        gender: dto.gender,
        dateOfBirth: dto.dateOfBirth,
        email: dto.email ?? null,
        flutterwaveTxRef: txRef,
        status: 'pending',
      },
    });

    return {
      subscriptionId: record.id,
      plan: { code: plan.planCode, name: plan.planName, price },
      flutterwaveConfig: {
        txRef,
        amount: price,
        currency: 'NGN',
        publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
      },
    };
  }

  async verifyAndEnrol(
    wawuUserId: string,
    subscriptionId: string,
    transactionId: string,
  ) {
    const record = await this.prisma.healthSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!record || record.wawuUserId !== wawuUserId) {
      throw new NotFoundException('Subscription not found.');
    }
    if (record.status !== 'pending') return this.toResponse(record);

    const verified = await this.verifier.verify({
      transactionId,
      expectedTxRef: record.flutterwaveTxRef,
      expectedAmount: record.price,
    });

    const paid = await this.prisma.healthSubscription.update({
      where: { id: record.id },
      data: { status: 'paid', flutterwaveTxId: verified.transactionId },
    });

    try {
      const result = await this.wella.subscribe({
        firstName: record.firstName,
        lastName: record.lastName,
        phoneNumber: record.phoneNumber,
        amountPaid: record.price,
        gender: record.gender,
        dateOfBirth: record.dateOfBirth,
        planCode: record.planCode,
        email: record.email ?? undefined,
        paymentReference: record.flutterwaveTxRef,
      });

      const starts = new Date();
      const expires = new Date(starts);
      expires.setMonth(expires.getMonth() + 1);

      const enrolled = await this.prisma.healthSubscription.update({
        where: { id: record.id },
        data: {
          status: 'delivered',
          policyNumber: result.policyNumber ?? result.subscriptionCode ?? null,
          providerReference: result.reference ?? null,
          startsAt: starts,
          expiresAt: expires,
        },
      });
      return this.toResponse(enrolled);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Enrolment failed';
      this.logger.error(`Health subscription ${record.id} paid but not enrolled: ${reason}`);
      await this.prisma.healthSubscription.update({
        where: { id: record.id },
        data: { status: 'failed', failureReason: reason.slice(0, 500) },
      });
      throw new BadRequestException(
        `We took your payment but could not activate the plan. Reference ${paid.flutterwaveTxRef}. Our team will sort this out or refund you.`,
      );
    }
  }

  async listMine(wawuUserId: string) {
    const rows = await this.prisma.healthSubscription.findMany({
      where: { wawuUserId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toResponse(r));
  }

  private toResponse(r: {
    id: string;
    planCode: string;
    planName: string;
    price: number;
    phoneNumber: string;
    status: string;
    policyNumber: string | null;
    startsAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      planCode: r.planCode,
      planName: r.planName,
      price: r.price,
      phoneNumber: r.phoneNumber,
      status: r.status,
      policyNumber: r.policyNumber,
      startsAt: r.startsAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ApplyPartnerServiceDto,
  type PartnerServiceKind,
} from './dto/apply-partner.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { ServiceApplication, ServiceApplicationTimelineEntry } from '../common/types';
import { FLUTTERWAVE_CLIENT, type FlutterwaveClient } from './flutterwave-client.interface';
import type { ApplyCacDto } from './dto/apply-cac.dto';
import type { ApplyNepcDto } from './dto/apply-nepc.dto';
import type { VerifyCacDto } from './dto/verify-cac.dto';

/** Server-priced, never client-suppliable (conventions.md § Identity & format canon). */
export const CAC_FEE_NAIRA = 25_000;
const CAC_TX_REF_PREFIX = 'cac-';

/**
 * ServiceApplication — registry.json § ServiceApplication. Owns the CAC
 * (paid, Flutterwave-gated) and NEPC (free, synchronous) application
 * intake flows plus read access to a user's own applications. Rows of
 * `kind: "mentor-request"` are written by a different (later-wave) resource
 * — this service only ever reads them back via list/getById, never creates
 * or mutates them.
 *
 * `reference` (the human-facing tracking code shown on the "tracking an
 * application" screen, e.g. "WA-CAC-40912") is intentionally distinct from
 * the Flutterwave `tx_ref` used to correlate a pending CAC row through the
 * payment leg — the schema has no separate payments table (frozen, none
 * declared), so the tx_ref instead embeds the pending row's own id
 * (`cac-<id>`), letting `.../verify` look the row straight back up.
 */
@Injectable()
export class ServiceApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  private generateReference(prefix: string): string {
    const digits = Math.floor(10_000 + Math.random() * 90_000);
    return `WA-${prefix}-${digits}`;
  }

  async list(applicantWawuId: string, page: number, perPage: number): Promise<Paginated<ServiceApplication>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.serviceApplication.findMany({
        where: { applicantWawuId },
        orderBy: { appliedDate: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.serviceApplication.count({ where: { applicantWawuId } }),
    ]);

    return { items, currentPage: page, perPage, total };
  }

  async getById(applicantWawuId: string, id: string): Promise<ServiceApplication> {
    const application = await this.prisma.serviceApplication.findUnique({ where: { id } });
    // 404 (not 403) whether the row is missing or simply not this caller's —
    // avoids leaking another user's application existence via status code.
    if (!application || application.applicantWawuId !== applicantWawuId) {
      throw new NotFoundException('Service application not found');
    }
    return application;
  }

  async applyCac(
    applicantWawuId: string,
    dto: ApplyCacDto,
  ): Promise<{ flutterwaveConfig: { txRef: string; amount: number; currency: string; publicKey: string } }> {
    const timeline: ServiceApplicationTimelineEntry[] = [
      {
        label: 'Application started',
        occurredAt: new Date().toISOString(),
        note: `${dto.names.length} name choice(s) submitted for ${dto.registrationType} — ${dto.nature}.`,
      },
    ];

    const created = await this.prisma.serviceApplication.create({
      data: {
        applicantWawuId,
        kind: 'cac',
        title: 'CAC registration',
        reference: this.generateReference('CAC'),
        status: 'awaiting_payment',
        statusLabel: 'Awaiting payment',
        amountPaid: null,
        timeline: timeline as unknown as object[],
        documents: dto.documents ?? [],
      },
    });

    const flutterwaveConfig = await this.flutterwave.initCharge({
      txRef: `${CAC_TX_REF_PREFIX}${created.id}`,
      amount: CAC_FEE_NAIRA,
      currency: 'NGN',
    });

    return { flutterwaveConfig };
  }


  /** Names and reference prefixes carried over from the previous platform. */
  private static readonly PARTNER_SERVICES: Record<
    PartnerServiceKind,
    { title: string; prefix: string; partner: string }
  > = {
    loans: { title: 'Loans/EasyBuy', prefix: 'LON', partner: 'our lending partner' },
    pension: { title: 'Pensions', prefix: 'PEN', partner: 'ARM Pension' },
  };

  /**
   * The generic partner-service request. These carry no payment: the applicant
   * submits, the partner reviews, and onboarding happens off-platform, which is
   * how all four worked on the previous platform.
   */
  async applyForPartnerService(
    applicantWawuId: string,
    dto: ApplyPartnerServiceDto,
  ) {
    const service = ServiceApplicationService.PARTNER_SERVICES[dto.kind];

    const created = await this.prisma.serviceApplication.create({
      data: {
        applicantWawuId,
        kind: dto.kind,
        title: service.title,
        reference: this.generateReference(service.prefix),
        status: 'under_review',
        statusLabel: 'With the partner',
        timeline: [
          {
            label: 'Request submitted',
            occurredAt: new Date().toISOString(),
            note: `Sent to ${service.partner} for review.`,
          },
        ] as unknown as object[],
        documents: dto.documents ?? [],
      },
    });

    return created;
  }

  async verifyCac(applicantWawuId: string, dto: VerifyCacDto): Promise<ServiceApplication> {
    if (!dto.tx_ref.startsWith(CAC_TX_REF_PREFIX)) {
      throw new BadRequestException('Unrecognized tx_ref');
    }
    const applicationId = dto.tx_ref.slice(CAC_TX_REF_PREFIX.length);

    const application = await this.prisma.serviceApplication.findUnique({ where: { id: applicationId } });
    if (
      !application ||
      application.applicantWawuId !== applicantWawuId ||
      application.kind !== 'cac' ||
      application.status !== 'awaiting_payment'
    ) {
      throw new NotFoundException('No CAC application awaiting payment for this tx_ref');
    }

    const verified = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    if (
      verified.status !== 'successful' ||
      verified.amount < CAC_FEE_NAIRA ||
      verified.currency !== 'NGN' ||
      verified.txRef !== dto.tx_ref
    ) {
      throw new BadRequestException('Payment could not be verified');
    }

    const existingTimeline = (application.timeline as unknown as ServiceApplicationTimelineEntry[]) ?? [];
    const timeline: ServiceApplicationTimelineEntry[] = [
      ...existingTimeline,
      {
        label: 'Submitted',
        occurredAt: new Date().toISOString(),
        note: `Payment received (₦${CAC_FEE_NAIRA.toLocaleString('en-NG')}). Application submitted for review.`,
      },
    ];

    return this.prisma.serviceApplication.update({
      where: { id: application.id },
      data: {
        status: 'submitted',
        statusLabel: 'Submitted — under review',
        amountPaid: CAC_FEE_NAIRA,
        timeline: timeline as unknown as object[],
      },
    });
  }

  async applyNepc(applicantWawuId: string, dto: ApplyNepcDto): Promise<ServiceApplication> {
    const timeline: ServiceApplicationTimelineEntry[] = [
      {
        label: 'Submitted',
        occurredAt: new Date().toISOString(),
        note: `${dto.mainProduct} export (${dto.exportCategory}) targeting ${dto.targetMarkets.join(', ')}. Yearly volume: ${dto.yearlyVolume}.`,
      },
    ];

    return this.prisma.serviceApplication.create({
      data: {
        applicantWawuId,
        kind: 'nepc',
        title: 'NEPC export registration',
        reference: this.generateReference('NEPC'),
        status: 'submitted',
        statusLabel: 'Submitted — under review',
        amountPaid: null,
        timeline: timeline as unknown as object[],
      },
    });
  }
}

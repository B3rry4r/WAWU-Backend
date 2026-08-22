import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ApplyPartnerServiceDto,
  type PartnerServiceKind,
} from './dto/apply-partner.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AdminOpsAuditService,
  type AdminActor,
} from '../common/audit/admin-ops-audit.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { ServiceApplication, ServiceApplicationTimelineEntry } from '../common/types';
import { FLUTTERWAVE_CLIENT, type FlutterwaveClient } from './flutterwave-client.interface';
import type { ApplyCacDto } from './dto/apply-cac.dto';
import type { ApplyNepcDto } from './dto/apply-nepc.dto';
import type { VerifyCacDto } from './dto/verify-cac.dto';
import type {
  ApproveApplicationDto,
  ProgressApplicationDto,
  RejectApplicationDto,
} from './dto/progress-application.dto';

/** Server-priced, never client-suppliable (conventions.md § Identity & format canon). */
export const CAC_FEE_NAIRA = 25_000;
/** Exported so PaymentWebhookModule can map an inbound `cac-<id>` tx_ref
 *  back to this flow. Value unchanged. */
export const CAC_TX_REF_PREFIX = 'cac-';

/**
 * How long after payment WAWU tells a CAC applicant to expect their
 * certificate. Nothing ever set `certificateExpectedBy`, so the success
 * screen's "By {date}" line rendered as "By " for every applicant who paid.
 *
 * Eight days is the turnaround the product already quotes (applied 15 Aug ->
 * expected 23 Aug on the tracking design). It is a promise, not a guess about
 * CAC's own queue, so it lives here as one named constant and an operator can
 * move any individual application's date with the progress endpoint.
 */
export const CAC_CERTIFICATE_SLA_DAYS = 8;

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
    private readonly audit: AdminOpsAuditService,
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
        // `note` is what the applicant actually asked for, and the DTO
        // insists on at least ten characters of it — then it was thrown
        // away, because nothing wrote it anywhere. It goes in the timeline
        // entry's own `note` field: that is the column the tracking screen
        // already reads, so the partner and the applicant both see the
        // request in the applicant's own words. Deliberately not a new
        // column — ServiceApplication is returned to the app by spread, so
        // adding one would widen a live response.
        timeline: [
          {
            label: 'Request submitted',
            occurredAt: new Date().toISOString(),
            note: dto.note,
          },
          {
            label: 'With the partner',
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

    const expectedBy = new Date();
    expectedBy.setUTCDate(expectedBy.getUTCDate() + CAC_CERTIFICATE_SLA_DAYS);

    // Conditional flip: the `status !== 'awaiting_payment'` read above is not
    // a lock, and since the Flutterwave webhook landed there are two callers
    // that can settle the same charge at once. Without the guard, one payment
    // appends the "Submitted" timeline entry twice.
    await this.prisma.serviceApplication.updateMany({
      where: { id: application.id, status: 'awaiting_payment' },
      data: {
        status: 'submitted',
        statusLabel: 'Submitted — under review',
        amountPaid: CAC_FEE_NAIRA,
        timeline: timeline as unknown as object[],
        // The column is @db.Date, so only the calendar day is stored.
        certificateExpectedBy: new Date(expectedBy.toISOString().slice(0, 10)),
      },
    });
    return this.prisma.serviceApplication.findUniqueOrThrow({
      where: { id: application.id },
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
        // The apply screen requires three uploads and this dropped all of
        // them on the floor.
        documents: dto.documents ?? [],
      },
    });
  }

  // ---------------------------------------------------------------------
  // Operator progression. Everything below is reached only through
  // AdminAuthGuard + AdminRolesGuard -- see service-application-ops.controller.ts.
  // ---------------------------------------------------------------------

  private async requireApplication(id: string) {
    const application = await this.prisma.serviceApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException('Service application not found');
    return application;
  }

  private appended(
    application: { timeline: unknown },
    entry: ServiceApplicationTimelineEntry,
  ): object[] {
    const existing =
      (application.timeline as unknown as ServiceApplicationTimelineEntry[] | null) ?? [];
    return [...existing, entry] as unknown as object[];
  }

  /**
   * Moves an application along: appends a timeline entry and, optionally,
   * updates the status pair and the expected-certificate date. This is the
   * write that was missing — an application could be created and then never
   * change again.
   */
  async progress(
    id: string,
    dto: ProgressApplicationDto,
    admin: AdminActor,
  ): Promise<ServiceApplication> {
    const application = await this.requireApplication(id);

    const updated = await this.prisma.serviceApplication.update({
      where: { id },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.statusLabel !== undefined && { statusLabel: dto.statusLabel }),
        ...(dto.certificateExpectedBy !== undefined && {
          certificateExpectedBy: new Date(dto.certificateExpectedBy.slice(0, 10)),
        }),
        timeline: this.appended(application, {
          label: dto.label,
          occurredAt: new Date().toISOString(),
          ...(dto.note !== undefined && { note: dto.note }),
        }),
      },
    });
    // The `timeline` entry is what the APPLICANT sees, so it deliberately
    // carries no staff name. The audit row is the other half of that: who
    // moved it, kept where the applicant never reads it.
    await this.audit.record(admin, {
      resource: 'service_application',
      resourceId: updated.id,
      subjectWawuId: updated.applicantWawuId,
      action: 'application_progressed',
      detail: {
        label: dto.label,
        previousStatus: application.status,
        newStatus: updated.status,
        certificateExpectedBy: dto.certificateExpectedBy ?? null,
      },
    });
    return updated;
  }

  /**
   * Refuses an application, with a reason the applicant can read.
   *
   * `rejection` is a note only. It says nothing about money: a CAC applicant
   * who was refused has already paid ₦25,000, and refunding that is a real
   * transfer nothing in this codebase performs. The note is where an operator
   * tells them what actually happened.
   */
  async reject(
    id: string,
    dto: RejectApplicationDto,
    admin: AdminActor,
  ): Promise<ServiceApplication> {
    const application = await this.requireApplication(id);

    const updated = await this.prisma.serviceApplication.update({
      where: { id },
      data: {
        status: 'rejected',
        statusLabel: dto.statusLabel ?? 'Not approved',
        rejection: dto.reason,
        timeline: this.appended(application, {
          label: 'Not approved',
          occurredAt: new Date().toISOString(),
          note: dto.reason,
        }),
      },
    });
    // A refusal strands whatever the applicant already paid (₦25,000 for CAC),
    // and no adapter here can give it back — so the amount is recorded next to
    // the person who wrote the refusal.
    await this.audit.record(admin, {
      resource: 'service_application',
      resourceId: updated.id,
      subjectWawuId: updated.applicantWawuId,
      action: 'application_rejected',
      detail: {
        reason: dto.reason,
        previousStatus: application.status,
        amountPaid: application.amountPaid,
      },
    });
    return updated;
  }

  /** Approves an application and, if one was issued, attaches the certificate. */
  async approve(
    id: string,
    dto: ApproveApplicationDto,
    admin: AdminActor,
  ): Promise<ServiceApplication> {
    const application = await this.requireApplication(id);

    const updated = await this.prisma.serviceApplication.update({
      where: { id },
      data: {
        status: 'approved',
        statusLabel: dto.statusLabel ?? 'Certificate ready',
        ...(dto.certificateUrl && {
          documents: [...application.documents, dto.certificateUrl],
        }),
        timeline: this.appended(application, {
          label: 'Certificate ready',
          occurredAt: new Date().toISOString(),
          ...(dto.note !== undefined && { note: dto.note }),
        }),
      },
    });
    await this.audit.record(admin, {
      resource: 'service_application',
      resourceId: updated.id,
      subjectWawuId: updated.applicantWawuId,
      action: 'application_approved',
      detail: {
        previousStatus: application.status,
        certificateUrl: dto.certificateUrl ?? null,
      },
    });
    return updated;
  }
}

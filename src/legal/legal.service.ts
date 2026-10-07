import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AdminOpsAuditService,
  type AdminActor,
} from '../common/audit/admin-ops-audit.service';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import {
  CATALOGUE_LABELS,
  LEGAL_CATEGORIES,
  LEGAL_SERVICES,
  legalService,
  type LegalService,
} from './legal-catalogue';
import { renderContract } from './contract-template';
import { CONSULTATION_HOURS } from './availability';
import {
  buildSlotDays,
  overlaps,
  appointmentMinutes,
} from './consultation-slots';
import { LegalPricesService, isBookable } from './legal-prices.service';
import type {
  BookConsultationDto,
  CancelLegalRequestDto,
  CompleteConsultationDto,
  CreateLegalRequestDto,
  DeliverLegalRequestDto,
  QuoteLegalRequestDto,
} from './dto/legal.dto';

/**
 * A booked hour is only genuinely held while the request is still walking the
 * consultation leg. Anything cancelled, delivered, or already consulted has
 * given the slot back.
 */
const SLOT_HOLDING_STATUSES = [
  'awaiting_consultation_payment',
  'consultation_scheduled',
] as const;

/**
 * How long an unpaid booking holds its hour.
 *
 * Booking and paying are two calls, and plenty of people never make the
 * second. Without a limit, every abandoned checkout would take a lawyer's
 * hour off the calendar permanently. Paid bookings are held indefinitely —
 * they are real appointments.
 */
export const UNPAID_HOLD_MINUTES = 30;

/**
 * Takes every booking decision one at a time, on the app's route and the
 * web's alike. A booking looks at what is held and then writes; two people
 * picking overlapping hours at the same moment would both pass the look. The
 * unique index on `scheduledFor` stops two identical starts but not two
 * different starts that overlap, so the check and the write share one lock.
 */
export const BOOKING_LOCK_KEY = 726_384_511;

/**
 * One kind of consultation in the web's catalogue (`GET /legal/catalogue`).
 * The prices and lengths are what WAWU set in admin (R-14); an in-person one
 * is always listed unpriced, as it always was.
 */
type CatalogueConsultationOption =
  | {
      medium: 'chat' | 'zoom';
      label: string;
      minutes: number | null;
      feeNaira: number | null;
    }
  | { medium: 'physical'; label: 'In person'; minutes: null; feeNaira: null };

/**
 * WAWU Legal.
 *
 * The state machine is the product here. A `simple` service goes
 * draft -> awaiting_service_payment -> in_progress -> delivered. A
 * `consultation` service has to walk the full ladder, and the two rules that
 * must never bend are:
 *
 *   - no quote before a consultation has actually been paid for, and
 *   - no service payment, and therefore no work, before a contract is signed.
 *
 * The second is the liability protection the whole flow exists for, so it is
 * enforced here rather than by hiding a button on the client.
 */
@Injectable()
export class LegalRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: FlutterwaveCheckoutVerifier,
    private readonly audit: AdminOpsAuditService,
    private readonly prices: LegalPricesService,
  ) {}

  /**
   * The bookable calendar. Slots already held by a paid consultation are
   * marked unavailable so nobody pays for an hour someone else has.
   */
  async availability() {
    const now = new Date();
    const booked = await this.prisma.legalRequest.findMany({
      where: this.heldSlotsWhere(now),
      select: { scheduledFor: true, consultationMinutes: true },
    });
    // A held hour blocks every slot it overlaps, so a longer booked call
    // (LEGAL-03) takes the next slot too. A booking made before lengths were
    // recorded is one slot, which blocks exactly its own start, as before.
    const held = booked.flatMap((b) =>
      b.scheduledFor
        ? [{ scheduledFor: b.scheduledFor, minutes: b.consultationMinutes }]
        : [],
    );
    return {
      timeZone: CONSULTATION_HOURS.timeZone,
      slotMinutes: CONSULTATION_HOURS.slotMinutes,
      days: buildSlotDays(held, CONSULTATION_HOURS.slotMinutes, now),
    };
  }

  /**
   * The rows that are actually holding a calendar hour right now.
   *
   * This used to be every row with a `scheduledFor`, which meant a cancelled
   * booking — or one where the payer closed the Flutterwave modal and never
   * came back — kept a lawyer's hour blocked forever, with nothing anywhere
   * able to release it.
   */
  heldSlotsWhere(now: Date) {
    return {
      scheduledFor: { not: null },
      status: { in: [...SLOT_HOLDING_STATUSES] },
      OR: [
        // Paid: a real appointment, held until it is done or cancelled.
        { consultationPaidAt: { not: null } },
        // Unpaid: a short hold while the payer is in checkout.
        {
          consultationPaidAt: null,
          updatedAt: {
            gte: new Date(now.getTime() - UNPAID_HOLD_MINUTES * 60_000),
          },
        },
      ],
    };
  }

  /**
   * The exact complement of `heldSlotsWhere`: rows still carrying a
   * `scheduledFor` that no longer means anything.
   *
   * This matters beyond the calendar view, because there is a partial unique
   * index on `scheduledFor` in the database. A cancelled or abandoned booking
   * that keeps its timestamp does not merely look busy — it makes that hour
   * un-bookable by anyone, forever, at the Postgres level. The index was
   * written on the assumption that "a cancelled request releases it by
   * clearing scheduledFor", and nothing ever cleared it.
   */
  deadHoldWhere(now: Date) {
    return {
      scheduledFor: { not: null },
      OR: [
        { status: { notIn: [...SLOT_HOLDING_STATUSES] } },
        {
          consultationPaidAt: null,
          updatedAt: {
            lt: new Date(now.getTime() - UNPAID_HOLD_MINUTES * 60_000),
          },
        },
      ],
    };
  }

  /**
   * The one booking check, for the app's route and the web's. Call it inside a
   * transaction, immediately before writing the booking: it takes the booking
   * lock (held to the end of that transaction), lets go of a dead hold on this
   * start, and refuses with 409 if any other appointment shares a minute with
   * a call of `minutes` from `start`.
   */
  async holdHour(
    tx: Prisma.TransactionClient,
    requestId: string,
    start: Date,
    minutes: number,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOKING_LOCK_KEY})`;
    const now = new Date();
    await tx.legalRequest.updateMany({
      where: { ...this.deadHoldWhere(now), scheduledFor: start },
      data: { scheduledFor: null },
    });
    const held = await tx.legalRequest.findMany({
      where: { ...this.heldSlotsWhere(now), id: { not: requestId } },
      select: { scheduledFor: true, consultationMinutes: true },
    });
    const clash = held.some(
      (h) =>
        h.scheduledFor &&
        overlaps(
          start,
          minutes,
          h.scheduledFor,
          appointmentMinutes({
            scheduledFor: h.scheduledFor,
            minutes: h.consultationMinutes,
          }),
        ),
    );
    if (clash) {
      throw new ConflictException(
        'That time has just been taken. Pick another.',
      );
    }
  }

  /**
   * The catalogue the web reads. Prices come from what WAWU set in admin
   * (R-14): a consultation kind that is not priced and switched on is left
   * out, and a service with a fixed price carries it in `priceNaira`.
   */
  async catalogue(): Promise<{
    categories: typeof LEGAL_CATEGORIES;
    consultationOptions: CatalogueConsultationOption[];
    services: LegalService[];
  }> {
    const [options, servicePrices] = await Promise.all([
      this.prices.consultationOptions(),
      this.prices.servicePrices(),
    ]);
    return {
      categories: LEGAL_CATEGORIES,
      consultationOptions: options.flatMap(
        (o): CatalogueConsultationOption[] => {
          if (!isBookable(o)) return [];
          // The web books an in-person consultation without a slot or a
          // checkout, so it is listed unpriced as it always was, whatever the
          // app shows for it (LEGAL-03). The web has no phone call.
          if (o.medium === 'physical') {
            return [
              {
                medium: 'physical',
                label: CATALOGUE_LABELS.physical,
                minutes: null,
                feeNaira: null,
              },
            ];
          }
          if (o.medium === 'phone') return [];
          return [
            {
              medium: o.medium,
              label: CATALOGUE_LABELS[o.medium],
              minutes: o.minutes,
              feeNaira: LegalPricesService.toNaira(o.priceKobo),
            },
          ];
        },
      ),
      services: LEGAL_SERVICES.map((s) => ({
        ...s,
        priceNaira: LegalPricesService.toNaira(
          servicePrices.get(s.code) ?? null,
        ),
      })),
    };
  }

  /** Starts a request. Nothing is charged yet. */
  async create(wawuUserId: string, dto: CreateLegalRequestDto) {
    const service = legalService(dto.serviceCode);
    if (!service) throw new BadRequestException('Unknown legal service.');

    if (service.requiresDocuments && !(dto.documents ?? []).length) {
      throw new BadRequestException(
        `${service.name} needs supporting documents before it can be submitted.`,
      );
    }
    // The fixed price WAWU set in admin, if there is one (R-14).
    const fixedPriceNaira = await this.prices.servicePriceNaira(service.code);

    const record = await this.prisma.legalRequest.create({
      data: {
        wawuUserId,
        serviceCode: service.code,
        serviceName: service.name,
        category: service.category,
        path: service.path,
        details: (dto.details ?? {}) as never,
        documents: dto.documents ?? [],
        // Three starting states, one per shape of service:
        //  - simple with a price on the list  -> already quoted, sign and pay
        //  - simple with no price             -> submitted, WAWU prices it
        //  - consultation                     -> nothing happens until booked
        //
        // Note a priced simple service starts at `quoted`, not at
        // awaiting_service_payment: the engagement letter still has to be
        // signed first, and labelling it "payment due" would promise a step
        // the client cannot actually take yet.
        status:
          service.path !== 'simple'
            ? 'draft'
            : fixedPriceNaira
              ? 'quoted'
              : 'awaiting_quote',
        quoteAmount: service.path === 'simple' ? fixedPriceNaira : null,
      },
    });
    return this.toResponse(record);
  }

  /**
   * Books a consultation and returns the checkout config for its fee.
   * Physical consultations have no fixed fee, so they are recorded as a
   * request for WAWU to contact the client rather than being charged.
   */
  async bookConsultation(
    wawuUserId: string,
    id: string,
    dto: BookConsultationDto,
  ) {
    const record = await this.owned(wawuUserId, id);
    if (record.path !== 'consultation') {
      throw new BadRequestException(
        `${record.serviceName} does not need a consultation.`,
      );
    }
    if (record.consultationPaidAt) {
      throw new ConflictException('A consultation has already been paid for.');
    }

    const row = await this.prices.consultationOption(dto.medium);
    if (!isBookable(row)) {
      throw new BadRequestException(
        'That kind of consultation is not available right now.',
      );
    }
    // The web's in-person path records a request and charges nothing up
    // front, as it always has, so it never reads an in-person price.
    const inPerson = dto.medium === 'physical';
    const option = {
      minutes: inPerson ? null : row.minutes,
      feeNaira: inPerson ? null : LegalPricesService.toNaira(row.priceKobo),
    };

    // Chat and Zoom happen at a specific hour, so one has to be chosen. A
    // physical consultation is arranged directly and books no slot.
    // (Not 'by email' — this service has no mail transport at all.)
    let scheduledFor: Date | null = null;
    if (option.feeNaira !== null) {
      if (!dto.scheduledFor) {
        throw new BadRequestException('Pick a time for your consultation.');
      }
      scheduledFor = new Date(dto.scheduledFor);
      if (
        Number.isNaN(scheduledFor.getTime()) ||
        scheduledFor.getTime() <= Date.now()
      ) {
        throw new BadRequestException('Pick a time in the future.');
      }
      // The clash check itself runs under the booking lock, with the write.
    } else if (dto.scheduledFor) {
      throw new BadRequestException(
        'In-person consultations are arranged directly, so they cannot be booked to a slot here.',
      );
    }

    if (option.feeNaira === null) {
      const updated = await this.prisma.legalRequest.update({
        where: { id: record.id },
        data: {
          consultationMedium: dto.medium,
          consultationFee: null,
          status: 'awaiting_consultation_payment',
        },
      });
      return {
        request: this.toResponse(updated),
        flutterwaveConfig: null,
        // NO EMAIL IS PROMISED HERE. This backend has no mail transport at
        // all — grep resend/nodemailer/sendMail/MailService across src returns
        // nothing — so the previous wording ("booked by email", "our team will
        // contact you") was a guarantee nothing implements. What is TRUE is
        // what this write does: the request is recorded and appears in the
        // legal ops queue (GET /legal/ops/requests), which a consultant works.
        // Say that instead. See .legacy-repair/repair-order.md R4.
        message:
          'Your request is with our legal team. In-person consultations are priced per matter and arranged with you directly.',
      };
    }

    const txRef = `wawu-legal-consult-${randomUUID()}`;
    const hourMinutes = option.minutes ?? CONSULTATION_HOURS.slotMinutes;
    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        // The same lock and the same check as the app's booking, so an app
        // booking and a web booking cannot both take overlapping hours.
        await this.holdHour(tx, record.id, scheduledFor as Date, hourMinutes);
        return tx.legalRequest.update({
          where: { id: record.id },
          data: {
            consultationMedium: dto.medium,
            consultationFee: option.feeNaira,
            consultationMinutes: option.minutes,
            consultationTxRef: txRef,
            // The picked hour was validated, clash-checked, and is written
            // here, so the calendar shows it taken.
            scheduledFor,
            status: 'awaiting_consultation_payment',
          },
        });
      });
    } catch (e) {
      // The partial unique index on `scheduledFor` stays the last guard; the
      // lock above is what makes the check reliable. Losing is a conflict,
      // not a 500.
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'That time has just been taken. Pick another.',
        );
      }
      throw e;
    }

    return {
      request: this.toResponse(updated),
      flutterwaveConfig: {
        txRef,
        amount: option.feeNaira,
        currency: 'NGN',
        publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
      },
      message: null,
    };
  }

  async verifyConsultationPayment(
    wawuUserId: string,
    id: string,
    transactionId: string,
  ) {
    const record = await this.owned(wawuUserId, id);
    if (record.consultationPaidAt) return this.toResponse(record);
    if (!record.consultationTxRef || record.consultationFee == null) {
      throw new BadRequestException(
        'No consultation has been booked on this request.',
      );
    }

    await this.verifier.verify({
      transactionId,
      expectedTxRef: record.consultationTxRef,
      expectedAmount: record.consultationFee,
    });

    // Conditional flip: the `consultationPaidAt` read above is not a lock, and
    // the Flutterwave webhook can settle this alongside the browser's /verify.
    await this.prisma.legalRequest.updateMany({
      where: { id: record.id, consultationPaidAt: null },
      data: {
        consultationPaidAt: new Date(),
        status: 'consultation_scheduled',
      },
    });
    const updated = await this.prisma.legalRequest.findUniqueOrThrow({
      where: { id: record.id },
    });
    return this.toResponse(updated);
  }

  /**
   * Ops action: record what the work will cost. Rejected before the
   * consultation is paid for, because quoting work nobody has discussed is
   * exactly what the consultation gate exists to prevent.
   */
  async quote(id: string, dto: QuoteLegalRequestDto, admin: AdminActor) {
    const record = await this.prisma.legalRequest.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Legal request not found.');
    if (record.path === 'consultation' && !record.consultationPaidAt) {
      throw new BadRequestException(
        'This request cannot be quoted until its consultation has been paid for.',
      );
    }
    const updated = await this.prisma.legalRequest.update({
      where: { id },
      data: {
        quoteAmount: dto.amountNaira,
        quoteNote: dto.note ?? null,
        status: 'quoted',
      },
    });
    // The price a client is billed used to be set anonymously behind a shared
    // key. The naira figure is recorded with it, not just the fact of a quote.
    await this.audit.record(admin, {
      resource: 'legal_request',
      resourceId: updated.id,
      subjectWawuId: updated.wawuUserId,
      action: 'legal_quoted',
      detail: {
        amountNaira: dto.amountNaira,
        note: dto.note ?? null,
        previousStatus: record.status,
      },
    });
    return this.toResponse(updated);
  }

  /**
   * Ops action: the consultation happened.
   *
   * `consultation_scheduled` was the end of the road — the client had paid
   * ₦25,000 or ₦45,000 for an hour and there was no state after it, so the
   * request could never be quoted-and-signed on from a status that reads as
   * "the call still hasn't happened". This is the step out.
   */
  async completeConsultation(
    id: string,
    dto: CompleteConsultationDto,
    admin: AdminActor,
  ) {
    const record = await this.requireRequest(id);
    if (!record.consultationPaidAt) {
      throw new BadRequestException(
        'No consultation has been paid for on this request.',
      );
    }
    if (record.status !== 'consultation_scheduled') {
      throw new ConflictException(
        `A consultation can only be completed from consultation_scheduled, not ${record.status}.`,
      );
    }

    const updated = await this.prisma.legalRequest.update({
      where: { id },
      data: {
        status: 'consultation_done',
        ...(dto.notes !== undefined && { consultationNotes: dto.notes }),
      },
    });
    // The notes themselves are NOT copied into the audit row: they are what
    // the client said to a lawyer. The trail records that the call was closed
    // out and by whom, which is what attribution needs.
    await this.audit.record(admin, {
      resource: 'legal_request',
      resourceId: updated.id,
      subjectWawuId: updated.wawuUserId,
      action: 'legal_consultation_completed',
      detail: { notesRecorded: dto.notes !== undefined },
    });
    return this.toResponse(updated);
  }

  /**
   * Ops action: the paid-for work is finished.
   *
   * `in_progress` is reached only after the client has signed the engagement
   * letter and paid the service fee in full — and it had no exit at all.
   * `delivered`, `deliverableUrl` and `deliveredAt` had no writer anywhere,
   * so every completed matter sat as "in progress" forever and the client
   * had no way to get the document they bought.
   */
  async deliver(id: string, dto: DeliverLegalRequestDto, admin: AdminActor) {
    const record = await this.requireRequest(id);
    if (record.status !== 'in_progress') {
      throw new ConflictException(
        `Only work in progress can be delivered, not a request that is ${record.status}.`,
      );
    }
    if (!record.servicePaidAt) {
      throw new BadRequestException('This work has not been paid for.');
    }

    const updated = await this.prisma.legalRequest.update({
      where: { id },
      data: {
        status: 'delivered',
        deliverableUrl: dto.deliverableUrl,
        deliveredAt: new Date(),
      },
    });
    await this.audit.record(admin, {
      resource: 'legal_request',
      resourceId: updated.id,
      subjectWawuId: updated.wawuUserId,
      action: 'legal_delivered',
      detail: { deliverableUrl: dto.deliverableUrl },
    });
    return this.toResponse(updated);
  }

  /**
   * Ops action: close a matter WAWU will not complete.
   *
   * Frees the calendar hour if one was held, and records why. It does NOT
   * refund anything: no adapter in this codebase can move money back to a
   * card, so a cancellation of something already paid for is an instruction
   * to a human, and the reason is where that is said out loud.
   */
  async cancel(id: string, dto: CancelLegalRequestDto, admin: AdminActor) {
    const record = await this.requireRequest(id);
    if (record.status === 'cancelled') {
      throw new ConflictException('This request is already cancelled.');
    }
    if (record.status === 'delivered') {
      throw new ConflictException('This request has already been delivered.');
    }

    const updated = await this.prisma.legalRequest.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancellationReason: dto.reason,
        cancelledAt: new Date(),
        // Hands the hour back. The partial unique index on `scheduledFor`
        // means a cancelled booking that keeps its timestamp blocks that hour
        // for everyone permanently — which is exactly how abandoned bookings
        // were eating the lawyer's calendar.
        scheduledFor: null,
      },
    });
    // Closing a matter money has already been taken for creates a manual
    // refund obligation nothing in this codebase can discharge, so the row
    // records what was already paid as well as who closed it.
    await this.audit.record(admin, {
      resource: 'legal_request',
      resourceId: updated.id,
      subjectWawuId: updated.wawuUserId,
      action: 'legal_cancelled',
      detail: {
        reason: dto.reason,
        previousStatus: record.status,
        consultationPaid: record.consultationPaidAt !== null,
        servicePaid: record.servicePaidAt !== null,
        quoteAmount: record.quoteAmount,
      },
    });
    return this.toResponse(updated);
  }

  /** Ops queue: everything sitting in one state, oldest first. */
  async listForOps(status?: string) {
    const rows = await this.prisma.legalRequest.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return rows.map((r) => this.toResponse(r));
  }

  private async requireRequest(id: string) {
    const record = await this.prisma.legalRequest.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Legal request not found.');
    return record;
  }

  /** The exact contract the client is about to sign. */
  async contractPreview(wawuUserId: string, id: string) {
    const record = await this.owned(wawuUserId, id);
    const service = legalService(record.serviceCode);
    if (!service) throw new BadRequestException('Unknown legal service.');
    if (record.quoteAmount == null) {
      throw new BadRequestException('This request has not been quoted yet.');
    }
    return {
      contractText: renderContract({
        service,
        clientName: record.contractSignedAs ?? 'the client',
        amountNaira: record.quoteAmount,
        scopeNote: record.quoteNote,
        requestId: record.id,
      }),
      amountNaira: record.quoteAmount,
      alreadySigned: Boolean(record.contractSignedAt),
    };
  }

  async signContract(
    wawuUserId: string,
    id: string,
    fullName: string,
    ip: string | undefined,
  ) {
    const record = await this.owned(wawuUserId, id);
    if (record.contractSignedAt) {
      throw new ConflictException('This contract has already been signed.');
    }
    if (record.quoteAmount == null) {
      throw new BadRequestException('This request has not been quoted yet.');
    }
    const service = legalService(record.serviceCode);
    if (!service) throw new BadRequestException('Unknown legal service.');

    const contractText = renderContract({
      service,
      clientName: fullName,
      amountNaira: record.quoteAmount,
      scopeNote: record.quoteNote,
      requestId: record.id,
    });

    const updated = await this.prisma.legalRequest.update({
      where: { id: record.id },
      data: {
        contractText,
        contractSignedAs: fullName,
        contractSignedAt: new Date(),
        contractSignedIp: ip ?? null,
        status: 'contract_signed',
      },
    });
    return this.toResponse(updated);
  }

  /** Checkout for the service fee. Blocked until the contract is signed. */
  async initServicePayment(wawuUserId: string, id: string) {
    const record = await this.owned(wawuUserId, id);
    if (record.quoteAmount == null) {
      throw new BadRequestException('This request has not been quoted yet.');
    }
    // The whole point of the contract step.
    if (!record.contractSignedAt) {
      throw new BadRequestException(
        'You need to read and sign the engagement letter before paying for this work.',
      );
    }
    if (record.servicePaidAt)
      throw new ConflictException('This work is already paid for.');

    const txRef = record.serviceTxRef ?? `wawu-legal-${randomUUID()}`;
    const updated = await this.prisma.legalRequest.update({
      where: { id: record.id },
      data: { serviceTxRef: txRef, status: 'awaiting_service_payment' },
    });

    return {
      request: this.toResponse(updated),
      flutterwaveConfig: {
        txRef,
        amount: record.quoteAmount,
        currency: 'NGN',
        publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY ?? '',
      },
    };
  }

  async verifyServicePayment(
    wawuUserId: string,
    id: string,
    transactionId: string,
  ) {
    const record = await this.owned(wawuUserId, id);
    if (record.servicePaidAt) return this.toResponse(record);
    if (!record.serviceTxRef || record.quoteAmount == null) {
      throw new BadRequestException('This request is not ready for payment.');
    }
    if (!record.contractSignedAt) {
      throw new BadRequestException(
        'The engagement letter has not been signed.',
      );
    }

    await this.verifier.verify({
      transactionId,
      expectedTxRef: record.serviceTxRef,
      expectedAmount: record.quoteAmount,
    });

    // Conditional flip — same race as the consultation stage above.
    await this.prisma.legalRequest.updateMany({
      where: { id: record.id, servicePaidAt: null },
      data: { servicePaidAt: new Date(), status: 'in_progress' },
    });
    const updated = await this.prisma.legalRequest.findUniqueOrThrow({
      where: { id: record.id },
    });
    return this.toResponse(updated);
  }

  async listMine(wawuUserId: string) {
    const rows = await this.prisma.legalRequest.findMany({
      where: { wawuUserId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toResponse(r));
  }

  async getMine(wawuUserId: string, id: string) {
    return this.toResponse(await this.owned(wawuUserId, id));
  }

  private async owned(wawuUserId: string, id: string) {
    const record = await this.prisma.legalRequest.findUnique({ where: { id } });
    if (!record || record.wawuUserId !== wawuUserId) {
      throw new NotFoundException('Legal request not found.');
    }
    return record;
  }

  private toResponse(r: {
    id: string;
    serviceCode: string;
    serviceName: string;
    category: string;
    path: string;
    status: string;
    documents: string[];
    consultationMedium: string | null;
    consultationFee: number | null;
    consultationPaidAt: Date | null;
    scheduledFor: Date | null;
    quoteAmount: number | null;
    quoteNote: string | null;
    contractSignedAt: Date | null;
    contractSignedAs: string | null;
    servicePaidAt: Date | null;
    deliverableUrl: string | null;
    deliveredAt: Date | null;
    cancellationReason: string | null;
    cancelledAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      serviceCode: r.serviceCode,
      serviceName: r.serviceName,
      category: r.category,
      path: r.path,
      status: r.status,
      documents: r.documents,
      consultationMedium: r.consultationMedium,
      consultationFee: r.consultationFee,
      consultationPaidAt: r.consultationPaidAt?.toISOString() ?? null,
      scheduledFor: r.scheduledFor?.toISOString() ?? null,
      quoteAmount: r.quoteAmount,
      quoteNote: r.quoteNote,
      contractSigned: Boolean(r.contractSignedAt),
      contractSignedAs: r.contractSignedAs,
      contractSignedAt: r.contractSignedAt?.toISOString() ?? null,
      servicePaidAt: r.servicePaidAt?.toISOString() ?? null,
      deliverableUrl: r.deliverableUrl,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      cancellationReason: r.cancellationReason,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

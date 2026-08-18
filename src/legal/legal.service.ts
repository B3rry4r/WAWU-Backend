import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { FlutterwaveCheckoutVerifier } from '../common/flutterwave/checkout-verifier';
import {
  CONSULTATION_FEES,
  LEGAL_CATEGORIES,
  LEGAL_SERVICES,
  legalService,
  type ConsultationMediumId,
} from './legal-catalogue';
import { renderContract } from './contract-template';
import type {
  BookConsultationDto,
  CreateLegalRequestDto,
  QuoteLegalRequestDto,
} from './dto/legal.dto';

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
  ) {}

  catalogue() {
    return {
      categories: LEGAL_CATEGORIES,
      consultationOptions: Object.values(CONSULTATION_FEES),
      services: LEGAL_SERVICES,
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
            : service.priceNaira
              ? 'quoted'
              : 'awaiting_quote',
        quoteAmount: service.path === 'simple' ? service.priceNaira : null,
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

    const option = CONSULTATION_FEES[dto.medium as ConsultationMediumId];

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
        message:
          'In-person consultations are booked by email and priced per matter. Our team will contact you to arrange it.',
      };
    }

    const txRef = `wawu-legal-consult-${randomUUID()}`;
    const updated = await this.prisma.legalRequest.update({
      where: { id: record.id },
      data: {
        consultationMedium: dto.medium,
        consultationFee: option.feeNaira,
        consultationTxRef: txRef,
        status: 'awaiting_consultation_payment',
      },
    });

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
      throw new BadRequestException('No consultation has been booked on this request.');
    }

    await this.verifier.verify({
      transactionId,
      expectedTxRef: record.consultationTxRef,
      expectedAmount: record.consultationFee,
    });

    const updated = await this.prisma.legalRequest.update({
      where: { id: record.id },
      data: { consultationPaidAt: new Date(), status: 'consultation_scheduled' },
    });
    return this.toResponse(updated);
  }

  /**
   * Ops action: record what the work will cost. Rejected before the
   * consultation is paid for, because quoting work nobody has discussed is
   * exactly what the consultation gate exists to prevent.
   */
  async quote(id: string, dto: QuoteLegalRequestDto) {
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
    return this.toResponse(updated);
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
    if (record.servicePaidAt) throw new ConflictException('This work is already paid for.');

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
      throw new BadRequestException('The engagement letter has not been signed.');
    }

    await this.verifier.verify({
      transactionId,
      expectedTxRef: record.serviceTxRef,
      expectedAmount: record.quoteAmount,
    });

    const updated = await this.prisma.legalRequest.update({
      where: { id: record.id },
      data: { servicePaidAt: new Date(), status: 'in_progress' },
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
      createdAt: r.createdAt.toISOString(),
    };
  }
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AdminOpsAuditService,
  type AdminActor,
} from '../common/audit/admin-ops-audit.service';
import {
  APP_LABELS,
  CONSULTATION_MEDIA,
  LEGAL_SERVICES,
  legalService,
  type ConsultationMediumId,
} from './legal-catalogue';
import type {
  AdminConsultationPriceView,
  AdminLegalPricesView,
  AdminServicePriceView,
} from './legal-consultation.types';
import type {
  SetConsultationPriceDto,
  SetServicePriceDto,
} from './dto/legal-consultation.dto';

/** One consultation kind as stored. Absent from the table reads as unset. */
export interface ConsultationOptionRow {
  medium: ConsultationMediumId;
  priceKobo: number | null;
  minutes: number | null;
  enabled: boolean;
  updatedAt: Date | null;
}

/**
 * Whether a kind can be booked now (R-14).
 *
 * An in-person consultation is arranged with the client directly and books no
 * hour, so it needs only the switch: a price and a length are shown when WAWU
 * set them, and "on request" when it did not. Every other kind needs both,
 * because a call with no price has nothing to charge and a call with no length
 * has no place in the calendar.
 */
export function isBookable(row: ConsultationOptionRow): boolean {
  if (!row.enabled) return false;
  if (row.medium === 'physical') return true;
  return row.priceKobo !== null && row.minutes !== null;
}

const KOBO_PER_NAIRA = 100;

/**
 * The prices WAWU sets in admin (R-14).
 *
 * The one place a legal price is read or written. Nothing here has a built-in
 * figure: a consultation kind or a service with no row has no price, and the
 * app offers nothing at a price nobody set. The rows are whole naira, so the
 * web's Flutterwave path, which charges whole naira, reads the same figure.
 */
@Injectable()
export class LegalPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminOpsAuditService,
  ) {}

  /** All four kinds, in a fixed order, with the unset ones filled in. */
  async consultationOptions(): Promise<ConsultationOptionRow[]> {
    const rows = await this.prisma.legalConsultationOption.findMany();
    const byMedium = new Map(rows.map((r) => [r.medium, r]));
    return CONSULTATION_MEDIA.map((medium) => {
      const row = byMedium.get(medium);
      return {
        medium,
        priceKobo: row?.priceKobo ?? null,
        minutes: row?.minutes ?? null,
        enabled: row?.enabled ?? true,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async consultationOption(
    medium: ConsultationMediumId,
  ): Promise<ConsultationOptionRow> {
    const all = await this.consultationOptions();
    return all.find((r) => r.medium === medium) as ConsultationOptionRow;
  }

  /** Fixed prices by service code, in kobo. */
  async servicePrices(): Promise<Map<string, number>> {
    const rows = await this.prisma.legalServicePrice.findMany();
    return new Map(rows.map((r) => [r.serviceCode, r.priceKobo]));
  }

  /** A service's fixed price in whole naira, or null when it is quoted. */
  async servicePriceNaira(serviceCode: string): Promise<number | null> {
    const row = await this.prisma.legalServicePrice.findUnique({
      where: { serviceCode },
    });
    return row ? row.priceKobo / KOBO_PER_NAIRA : null;
  }

  /** Whole naira of a stored kobo price. The rows only ever hold whole naira. */
  static toNaira(priceKobo: number | null): number | null {
    return priceKobo === null ? null : priceKobo / KOBO_PER_NAIRA;
  }

  /* ---------------------------------------------------------------- */
  /* Admin                                                             */
  /* ---------------------------------------------------------------- */

  async adminView(): Promise<AdminLegalPricesView> {
    const [options, prices] = await Promise.all([
      this.consultationOptions(),
      this.prisma.legalServicePrice.findMany(),
    ]);
    const byCode = new Map(prices.map((p) => [p.serviceCode, p]));
    return {
      consultations: options.map(toAdminConsultation),
      services: LEGAL_SERVICES.filter((s) => s.path === 'simple').map(
        (s): AdminServicePriceView => {
          const row = byCode.get(s.code);
          return {
            serviceCode: s.code,
            serviceName: s.name,
            category: s.category,
            priceKobo: row?.priceKobo ?? null,
            updatedAt: row?.updatedAt.toISOString() ?? null,
          };
        },
      ),
    };
  }

  async setConsultation(
    admin: AdminActor,
    medium: ConsultationMediumId,
    dto: SetConsultationPriceDto,
  ): Promise<AdminConsultationPriceView> {
    const before = await this.consultationOption(medium);
    const enabled = dto.enabled ?? true;
    const saved = await this.prisma.legalConsultationOption.upsert({
      where: { medium },
      create: {
        medium,
        priceKobo: dto.priceKobo,
        minutes: dto.minutes,
        enabled,
        updatedByAdminId: admin.id,
      },
      update: {
        priceKobo: dto.priceKobo,
        minutes: dto.minutes,
        enabled,
        updatedByAdminId: admin.id,
      },
    });
    await this.audit.record(admin, {
      resource: 'legal_price',
      resourceId: `consultation:${medium}`,
      subjectWawuId: '',
      action: 'legal_price_set',
      detail: {
        kind: 'consultation',
        medium,
        from: {
          priceKobo: before.priceKobo,
          minutes: before.minutes,
          enabled: before.enabled,
        },
        to: { priceKobo: dto.priceKobo, minutes: dto.minutes, enabled },
      },
    });
    return toAdminConsultation({
      medium,
      priceKobo: saved.priceKobo,
      minutes: saved.minutes,
      enabled: saved.enabled,
      updatedAt: saved.updatedAt,
    });
  }

  async setServicePrice(
    admin: AdminActor,
    serviceCode: string,
    dto: SetServicePriceDto,
  ): Promise<AdminServicePriceView> {
    const service = legalService(serviceCode);
    if (!service) throw new NotFoundException('Unknown legal service.');
    if (service.path !== 'simple') {
      throw new BadRequestException(
        `${service.name} is priced by a consultant's quote, not a fixed price.`,
      );
    }
    const before = await this.prisma.legalServicePrice.findUnique({
      where: { serviceCode },
    });
    let updatedAt: Date | null = null;
    if (dto.priceKobo === null) {
      await this.prisma.legalServicePrice.deleteMany({
        where: { serviceCode },
      });
    } else {
      const saved = await this.prisma.legalServicePrice.upsert({
        where: { serviceCode },
        create: {
          serviceCode,
          priceKobo: dto.priceKobo,
          updatedByAdminId: admin.id,
        },
        update: { priceKobo: dto.priceKobo, updatedByAdminId: admin.id },
      });
      updatedAt = saved.updatedAt;
    }
    await this.audit.record(admin, {
      resource: 'legal_price',
      resourceId: `service:${serviceCode}`,
      subjectWawuId: '',
      action: 'legal_price_set',
      detail: {
        kind: 'service',
        serviceCode,
        from: { priceKobo: before?.priceKobo ?? null },
        to: { priceKobo: dto.priceKobo },
      },
    });
    return {
      serviceCode: service.code,
      serviceName: service.name,
      category: service.category,
      priceKobo: dto.priceKobo,
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }
}

function toAdminConsultation(
  row: ConsultationOptionRow,
): AdminConsultationPriceView {
  return {
    medium: row.medium,
    label: APP_LABELS[row.medium],
    priceKobo: row.priceKobo,
    minutes: row.minutes,
    enabled: row.enabled,
    offered: isBookable(row),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

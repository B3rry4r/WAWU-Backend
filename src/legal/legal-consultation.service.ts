import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_LABELS, type ConsultationMediumId } from './legal-catalogue';
import { CONSULTATION_HOURS } from './availability';
import { buildSlotDays, isOfferedStart } from './consultation-slots';
import { LegalPricesService, isBookable } from './legal-prices.service';
import { LegalRequestsService, UNPAID_HOLD_MINUTES } from './legal.service';
import type {
  BookableMedium,
  ConsultationBookingView,
  ConsultationOptionsView,
  ConsultationSlotsView,
} from './legal-consultation.types';
import type { BookConsultationSlotDto } from './dto/legal-consultation.dto';

/** The kinds of consultation the app offers, in the order it lists them. */
const APP_MEDIA: BookableMedium[] = ['zoom', 'phone', 'physical'];

/**
 * Where a request can still be booked from: a fresh one, one whose brief a
 * consultant has yet to read, or one already holding an unpaid booking (so a
 * person can change their mind before paying).
 */
const BOOKABLE_FROM = new Set([
  'draft',
  'awaiting_quote',
  'awaiting_consultation_payment',
]);

/** `LegalRequest.consultationFee` is whole naira, as the web reads it. */
const KOBO_PER_NAIRA = 100;

/**
 * Booking a legal consultation (LEGAL-03, R-14): video, phone or in person,
 * each at the price and length WAWU set in admin, in an hour nobody else holds.
 *
 * Paying is a separate step (LEGAL-05). Booking holds the hour and records the
 * price, and the request stays `awaiting_consultation_payment` until the
 * payment lands.
 */
@Injectable()
export class LegalConsultationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prices: LegalPricesService,
    private readonly legal: LegalRequestsService,
  ) {}

  /** What the app offers: the kinds WAWU has priced and switched on. */
  async options(): Promise<ConsultationOptionsView> {
    const rows = await this.prices.consultationOptions();
    return {
      timeZone: CONSULTATION_HOURS.timeZone,
      options: APP_MEDIA.flatMap((medium) => {
        const row = rows.find((r) => r.medium === medium);
        if (!row || !isBookable(row)) return [];
        return [
          {
            medium,
            label: APP_LABELS[medium],
            minutes: row.minutes,
            priceKobo: row.priceKobo,
            onRequest: medium === 'physical',
          },
        ];
      }),
    };
  }

  /** The calendar for one kind of call, at that kind's length. */
  async slots(medium: 'zoom' | 'phone'): Promise<ConsultationSlotsView> {
    const row = await this.prices.consultationOption(medium);
    if (!isBookable(row) || row.minutes === null) {
      throw new BadRequestException(
        'That kind of consultation is not available right now.',
      );
    }
    const now = new Date();
    const held = await this.heldAppointments(now);
    return {
      medium,
      label: APP_LABELS[medium],
      minutes: row.minutes,
      timeZone: CONSULTATION_HOURS.timeZone,
      horizonDays: CONSULTATION_HOURS.horizonDays,
      days: buildSlotDays(held, row.minutes, now),
    };
  }

  /** Holds an hour (or records an in-person request) on the person's own request. */
  async book(
    wawuUserId: string,
    id: string,
    dto: BookConsultationSlotDto,
  ): Promise<ConsultationBookingView> {
    const record = await this.owned(wawuUserId, id);
    if (record.path !== 'consultation') {
      throw new BadRequestException(
        `${record.serviceName} does not need a consultation.`,
      );
    }
    if (record.consultationPaidAt) {
      throw new ConflictException('A consultation has already been paid for.');
    }
    if (!BOOKABLE_FROM.has(record.status)) {
      throw new ConflictException('This request cannot be booked now.');
    }

    const row = await this.prices.consultationOption(dto.medium);
    if (!isBookable(row)) {
      throw new BadRequestException(
        'That kind of consultation is not available right now.',
      );
    }

    if (dto.medium === 'physical') {
      if (dto.scheduledFor) {
        throw new BadRequestException(
          'In-person consultations are arranged directly, so they cannot be booked to a slot here.',
        );
      }
      const updated = await this.prisma.legalRequest.update({
        where: { id: record.id },
        data: {
          consultationMedium: 'physical',
          // What WAWU set for an in-person consultation, if it set anything;
          // otherwise it is priced per matter (LEGAL-07 sets it).
          consultationFee:
            row.priceKobo === null ? null : row.priceKobo / KOBO_PER_NAIRA,
          consultationMinutes: row.minutes,
          consultationTxRef: null,
          // An earlier hold on this request lets go of its hour.
          scheduledFor: null,
          status: 'awaiting_consultation_payment',
        },
      });
      return toBooking(updated);
    }

    // A video or phone call: the hour has to be one the calendar offers for
    // this kind of call, at this kind of call's length.
    const minutes = row.minutes as number;
    const priceKobo = row.priceKobo as number;
    if (!dto.scheduledFor) {
      throw new BadRequestException('Pick a time for your consultation.');
    }
    const start = new Date(dto.scheduledFor);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('Pick a time for your consultation.');
    }
    const now = new Date();
    if (start.getTime() <= now.getTime()) {
      throw new BadRequestException('Pick a time in the future.');
    }
    if (!isOfferedStart(start, minutes, now)) {
      throw new BadRequestException('Pick one of the times offered.');
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await this.legal.holdHour(tx, record.id, start, minutes);
        return tx.legalRequest.update({
          where: { id: record.id },
          data: {
            consultationMedium: dto.medium,
            consultationFee: priceKobo / KOBO_PER_NAIRA,
            consultationMinutes: minutes,
            // A new booking retires any checkout an earlier one started.
            consultationTxRef: null,
            scheduledFor: start,
            status: 'awaiting_consultation_payment',
          },
        });
      });
      return toBooking(updated);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'That time has just been taken. Pick another.',
        );
      }
      throw e;
    }
  }

  /** The person's own booking, as the app draws it. */
  async getBooking(
    wawuUserId: string,
    id: string,
  ): Promise<ConsultationBookingView> {
    return toBooking(await this.owned(wawuUserId, id));
  }

  /* ---------------------------------------------------------------- */

  private async heldAppointments(now: Date) {
    const rows = await this.prisma.legalRequest.findMany({
      where: this.legal.heldSlotsWhere(now),
      select: { scheduledFor: true, consultationMinutes: true },
    });
    return rows.flatMap((r) =>
      r.scheduledFor
        ? [{ scheduledFor: r.scheduledFor, minutes: r.consultationMinutes }]
        : [],
    );
  }

  private async owned(wawuUserId: string, id: string) {
    const record = await this.prisma.legalRequest.findUnique({ where: { id } });
    if (!record || record.wawuUserId !== wawuUserId) {
      throw new NotFoundException('Legal request not found.');
    }
    return record;
  }
}

function toBooking(r: {
  id: string;
  status: string;
  consultationMedium: string | null;
  consultationFee: number | null;
  consultationMinutes: number | null;
  consultationPaidAt: Date | null;
  scheduledFor: Date | null;
  updatedAt: Date;
}): ConsultationBookingView {
  const medium = r.consultationMedium as ConsultationMediumId | null;
  const paid = r.consultationPaidAt !== null;
  return {
    requestId: r.id,
    status: r.status,
    medium,
    label: medium ? APP_LABELS[medium] : null,
    minutes: r.consultationMinutes,
    priceKobo:
      r.consultationFee === null ? null : r.consultationFee * KOBO_PER_NAIRA,
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
    holdExpiresAt:
      !paid && r.scheduledFor
        ? new Date(
            r.updatedAt.getTime() + UNPAID_HOLD_MINUTES * 60_000,
          ).toISOString()
        : null,
    paid,
    paidAt: r.consultationPaidAt?.toISOString() ?? null,
  };
}

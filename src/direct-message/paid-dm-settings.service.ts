import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { commissionRate } from '../event-ticketing/event-ticketing.constants';
import type { UpdatePaidDmSettingsDto } from './dto/paid-dm-settings.dto';
import { paidDmSettingsConfig } from './paid-dm-settings.config';
import {
  PAID_MESSAGES_PAUSED,
  PaidDmPauseService,
} from './paid-dm-pause.service';
import type { PaidDmSettings } from './paid-dm-view.type';

const KOBO = 100;
/** What a creator who has never configured anything starts with (the same as `GET /creator/state`). */
const DEFAULT_RESPONSE_HOURS = 24;

/**
 * The creator's paid message settings as the app's I21 to I23 read and write
 * them (task INBOX-12). New routes beside the live `PATCH /creator/dm-settings`,
 * which stays exactly as it is: the web calls it. The stored price is whole
 * naira on `CreatorState.dmPrice`; this service speaks kobo.
 *
 * While a creator's paid messages are paused (R-13) the whole form is locked:
 * a save is refused with the same `paid_messages_paused` reason a fan's send
 * gets, so the app's locked screen and the server say the same thing. The
 * creator's own switch is left as it was, so the pause ending by the clock is
 * all it takes for paid messages to be back on.
 */
@Injectable()
export class PaidDmSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pause: PaidDmPauseService,
  ) {}

  async get(
    creatorWawuId: string,
    now: Date = new Date(),
  ): Promise<PaidDmSettings> {
    const state = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { dmEnabled: true, dmPrice: true, dmResponseHours: true },
    });
    return this.view(
      creatorWawuId,
      {
        enabled: state?.dmEnabled ?? false,
        priceNaira: state?.dmPrice ?? null,
        responseHours: state?.dmResponseHours ?? DEFAULT_RESPONSE_HOURS,
      },
      now,
    );
  }

  async save(
    creatorWawuId: string,
    dto: UpdatePaidDmSettingsDto,
    now: Date = new Date(),
  ): Promise<PaidDmSettings> {
    const standing = await this.pause.standing(creatorWawuId, now);
    if (standing.state === 'paused' && standing.pausedUntil) {
      throw new ForbiddenException({
        message: 'Paid messages are switched off for now.',
        reason: {
          code: PAID_MESSAGES_PAUSED,
          message: 'Paid messages are switched off for now.',
          pausedUntil: standing.pausedUntil,
        },
      });
    }

    const existing = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { dmPrice: true, dmResponseHours: true },
    });
    const cfg = paidDmSettingsConfig();

    if (dto.priceKobo !== undefined && dto.priceKobo % KOBO !== 0) {
      throw new BadRequestException(
        'The price must be a whole number of naira.',
      );
    }
    const priceNaira =
      dto.priceKobo === undefined ? existing?.dmPrice : dto.priceKobo / KOBO;
    if (dto.enabled && (priceNaira === undefined || priceNaira === null)) {
      throw new BadRequestException(
        'Set a price before you turn paid messages on.',
      );
    }
    if (
      dto.responseHours !== undefined &&
      dto.responseHours !== existing?.dmResponseHours &&
      !cfg.responseWindowHours.includes(dto.responseHours)
    ) {
      throw new BadRequestException('Pick one of the reply times on offer.');
    }

    // A creator with no row yet is a normal account: configuring is what
    // writes it (GET /creator/state says the same).
    const data = {
      dmEnabled: dto.enabled,
      ...(priceNaira === undefined || priceNaira === null
        ? {}
        : { dmPrice: priceNaira }),
      ...(dto.responseHours === undefined
        ? {}
        : { dmResponseHours: dto.responseHours }),
    };
    const saved = await this.prisma.creatorState.upsert({
      where: { wawuUserId: creatorWawuId },
      create: { wawuUserId: creatorWawuId, ...data },
      update: data,
      select: { dmEnabled: true, dmPrice: true, dmResponseHours: true },
    });
    return this.view(
      creatorWawuId,
      {
        enabled: saved.dmEnabled,
        priceNaira: saved.dmPrice,
        responseHours: saved.dmResponseHours,
      },
      now,
    );
  }

  private async view(
    creatorWawuId: string,
    stored: {
      enabled: boolean;
      priceNaira: number | null;
      responseHours: number;
    },
    now: Date,
  ): Promise<PaidDmSettings> {
    const cfg = paidDmSettingsConfig();
    const priceKobo =
      stored.priceNaira === null ? null : stored.priceNaira * KOBO;
    const creatorSharePct = Math.round((1 - commissionRate()) * 100);
    return {
      enabled: stored.enabled,
      priceKobo,
      responseHours: stored.responseHours,
      creatorSharePct,
      earnPerMessageKobo:
        priceKobo === null
          ? null
          : Math.floor((priceKobo * creatorSharePct) / 100),
      raiseToKobo:
        priceKobo === null
          ? null
          : (cfg.pricePresetsKobo.find((p) => p > priceKobo) ?? null),
      options: {
        minPriceKobo: cfg.minPriceKobo,
        maxPriceKobo: cfg.maxPriceKobo,
        pricePresetsKobo: cfg.pricePresetsKobo,
        responseWindowHours: cfg.responseWindowHours,
      },
      standing: await this.pause.standing(creatorWawuId, now),
    };
  }
}

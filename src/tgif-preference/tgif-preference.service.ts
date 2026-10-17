import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface TgifPreferenceView {
  /** Whether to send this person TGIF each morning (Z2). True until they turn it off. */
  show: boolean;
}

/**
 * HOME-11: the per-account TGIF switch. HOME-16 (R-59): it now means "send me
 * TGIF each morning" (Z2); the route, the shape and every saved value are
 * unchanged. The daily notice job (src/scheduler/tgif-daily-notice.service.ts),
 * the notification service and the push sender all read it. GET never writes
 * (no row = the default, on). PATCH is one upsert on the primary key, so
 * parallel writes cannot make two rows or fail; the last one wins.
 */
@Injectable()
export class TgifPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userWawuId: string): Promise<TgifPreferenceView> {
    const row = await this.prisma.tgifPreference.findUnique({
      where: { userWawuId },
      select: { show: true },
    });
    return { show: row?.show ?? true };
  }

  async set(userWawuId: string, show: boolean): Promise<TgifPreferenceView> {
    const row = await this.prisma.tgifPreference.upsert({
      where: { userWawuId },
      create: { userWawuId, show },
      update: { show },
      select: { show: true },
    });
    return { show: row.show };
  }
}

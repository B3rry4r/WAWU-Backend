import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface TgifPreferenceView {
  /** Whether TGIF shows on Today. True until the person turns it off. */
  show: boolean;
}

/**
 * HOME-11: the per-account "show TGIF on Today" preference. GET never writes
 * (no row = the default, shown). PATCH is one upsert on the primary key, so
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

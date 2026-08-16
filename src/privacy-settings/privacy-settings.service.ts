import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { PrivacySettings } from '../common/types';
import type { UpdatePrivacySettingsDto } from './dto/update-privacy-settings.dto';

/**
 * registry.json "PrivacySettings" — per-user visibility toggles (purchases,
 * saved items, following, member-list appearance). All four fields default
 * `true` in the schema (prisma/schema.prisma model PrivacySettings). Every
 * seeded user already has a row (prisma/seed.ts), but get-or-create mirrors
 * CreditsState's pattern defensively for any user without one yet.
 */
@Injectable()
export class PrivacySettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(userWawuId: string): Promise<PrivacySettings> {
    const existing = await this.prisma.privacySettings.findUnique({
      where: { userWawuId },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.privacySettings.create({
      data: { userWawuId },
    });
  }

  async update(userWawuId: string, dto: UpdatePrivacySettingsDto): Promise<PrivacySettings> {
    // Ensure a row exists first (upsert would work too, but get-or-create
    // keeps creation logic in one place and matches CreditsState's idiom).
    await this.getOrCreate(userWawuId);

    return this.prisma.privacySettings.update({
      where: { userWawuId },
      data: {
        ...(dto.showPurchases !== undefined && { showPurchases: dto.showPurchases }),
        ...(dto.showSavedItems !== undefined && { showSavedItems: dto.showSavedItems }),
        ...(dto.showFollowing !== undefined && { showFollowing: dto.showFollowing }),
        ...(dto.showInMemberLists !== undefined && { showInMemberLists: dto.showInMemberLists }),
      },
    });
  }
}

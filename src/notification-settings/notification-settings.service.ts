import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { NotificationSettings } from '../common/types';
import type { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';

/**
 * NotificationSettings (.pipeline/registry.json) — roles: ["any"], i.e. any
 * authenticated WAWU user, not creator-gated. Every seeded test user already
 * has a row (prisma/seed.ts upserts one per user alongside CreditsState/
 * PrivacySettings), but production accounts created via WAWU ID won't have
 * one until their first read/write here — both operations use `upsert` so
 * the row is lazily created with the Prisma model's own defaults
 * (mirrors UserProfile's PATCH-creates-on-first-call idiom noted in the
 * registry) rather than 404ing or requiring a separate provisioning step.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userWawuId: string): Promise<NotificationSettings> {
    return this.prisma.notificationSettings.upsert({
      where: { userWawuId },
      update: {},
      create: { userWawuId },
    });
  }

  async update(userWawuId: string, dto: UpdateNotificationSettingsDto): Promise<NotificationSettings> {
    return this.prisma.notificationSettings.upsert({
      where: { userWawuId },
      update: { ...dto },
      create: { userWawuId, ...dto },
    });
  }
}

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
/**
 * What the settings routes send. The two switches added by SETTINGS-07 are
 * absent until the person sets them (absent means on); the six older keys are
 * always present.
 */
export type NotificationSettingsWire = Omit<
  NotificationSettings,
  'moneyIn' | 'contentReviews'
> & {
  moneyIn?: boolean;
  contentReviews?: boolean;
};

@Injectable()
export class NotificationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userWawuId: string): Promise<NotificationSettingsWire> {
    return withoutUnsetSwitches(
      await this.prisma.notificationSettings.upsert({
        where: { userWawuId },
        update: {},
        create: { userWawuId },
      }),
    );
  }

  async update(
    userWawuId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsWire> {
    return withoutUnsetSwitches(
      await this.prisma.notificationSettings.upsert({
        where: { userWawuId },
        update: { ...dto },
        create: { userWawuId, ...dto },
      }),
    );
  }
}

/**
 * Switches added after the web shipped (SETTINGS-07) are nullable: NULL means
 * the person never touched them, which behaves as ON. They are left off the
 * wire while NULL, so a person who has not used them gets the same bytes as
 * before the columns existed. Once set, a key is always sent.
 */
function withoutUnsetSwitches(
  row: NotificationSettings,
): NotificationSettingsWire {
  const { moneyIn, contentReviews, ...rest } = row;
  return {
    ...rest,
    ...(moneyIn === null ? {} : { moneyIn }),
    ...(contentReviews === null ? {} : { contentReviews }),
  };
}

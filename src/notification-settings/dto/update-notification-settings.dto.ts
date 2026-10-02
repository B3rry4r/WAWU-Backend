import { IsBoolean, IsOptional } from 'class-validator';

/**
 * PATCH /settings/notifications body (.pipeline/registry.json
 * NotificationSettings endpoint). Every field is nullable/optional per the
 * contract — a partial update, not a full replace.
 */
export class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  newReplies?: boolean;

  @IsOptional()
  @IsBoolean()
  newFollowers?: boolean;

  @IsOptional()
  @IsBoolean()
  dmReminders?: boolean;

  @IsOptional()
  @IsBoolean()
  refunds?: boolean;

  @IsOptional()
  @IsBoolean()
  promotions?: boolean;

  @IsOptional()
  @IsBoolean()
  communityDigest?: boolean;

  /** Tips and sales (SETTINGS-07). Optional; absent leaves it as it is. */
  @IsOptional()
  @IsBoolean()
  moneyIn?: boolean;

  /** An upload approved or sent back (SETTINGS-07). Optional; absent leaves it as it is. */
  @IsOptional()
  @IsBoolean()
  contentReviews?: boolean;
}

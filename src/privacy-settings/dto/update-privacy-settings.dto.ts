import { IsBoolean, IsOptional } from 'class-validator';

/**
 * PATCH /settings/privacy body per registry.json "PrivacySettings" — every
 * field optional (partial update), boolean toggles only.
 */
export class UpdatePrivacySettingsDto {
  @IsOptional()
  @IsBoolean()
  showPurchases?: boolean;

  @IsOptional()
  @IsBoolean()
  showSavedItems?: boolean;

  @IsOptional()
  @IsBoolean()
  showFollowing?: boolean;

  @IsOptional()
  @IsBoolean()
  showInMemberLists?: boolean;
}

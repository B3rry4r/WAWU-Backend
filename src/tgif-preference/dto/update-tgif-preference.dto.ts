import { IsBoolean } from 'class-validator';

/** Body of PATCH /settings/tgif. `show` is required and must be a real boolean. */
export class UpdateTgifPreferenceDto {
  /** false stops the daily TGIF notification for this account; true sends one each morning (HOME-16, R-59). */
  @IsBoolean()
  show: boolean;
}

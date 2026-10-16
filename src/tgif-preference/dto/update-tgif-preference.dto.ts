import { IsBoolean } from 'class-validator';

/** Body of PATCH /settings/tgif. `show` is required and must be a real boolean. */
export class UpdateTgifPreferenceDto {
  /** false hides TGIF on Today for this account; true shows it again. */
  @IsBoolean()
  show: boolean;
}

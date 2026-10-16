import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  DM_PRICE_MAX_NAIRA,
  DM_PRICE_MIN_NAIRA,
  DM_RESPONSE_HOURS_MAX,
  DM_RESPONSE_HOURS_MIN,
} from '../paid-dm-settings.config';

/**
 * PUT /paid-dm/settings body (task INBOX-12). Money is integer kobo
 * (docs/contract/CONVENTIONS.md). The stored price is whole naira, so a price
 * that is not a whole number of naira is refused by the service with a 400.
 */
export class UpdatePaidDmSettingsDto {
  /** Whether fans may send paid messages. */
  @IsBoolean()
  enabled!: boolean;

  /** Price per message in kobo. Required when `enabled` is true and none is saved yet. */
  @IsOptional()
  @IsInt()
  @Min(DM_PRICE_MIN_NAIRA * 100)
  @Max(DM_PRICE_MAX_NAIRA * 100)
  priceKobo?: number;

  /** Hours the creator has to reply. Left out means unchanged. */
  @IsOptional()
  @IsInt()
  @Min(DM_RESPONSE_HOURS_MIN)
  @Max(DM_RESPONSE_HOURS_MAX)
  responseHours?: number;
}

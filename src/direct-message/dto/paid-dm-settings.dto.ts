import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import {
  DM_PRICE_MAX_NAIRA,
  DM_PRICE_MIN_NAIRA,
  DM_RESPONSE_HOURS_MAX,
  DM_RESPONSE_HOURS_MIN,
} from '../paid-dm-settings.config';

/** True when the field was sent at all (null counts as sent, and then fails the checks). */
const sent = (_body: unknown, value: unknown): boolean => value !== undefined;

/**
 * PUT /paid-dm/settings body (task INBOX-12). Money is integer kobo
 * (docs/contract/CONVENTIONS.md). The stored price is whole naira, so a price
 * that is not a whole number of naira is refused by the service with a 400.
 *
 * A field is either left out (it keeps its saved value) or sent with a real
 * value. `null` is never a value: `@IsOptional()` would wave it through, and
 * the service would save it as a price of 0, so the optional fields use
 * `@ValidateIf(...!== undefined)` and null is refused with a 400.
 */
export class UpdatePaidDmSettingsDto {
  /** Whether fans may send paid messages. */
  @IsBoolean()
  enabled!: boolean;

  /** Price per message in kobo. Required when `enabled` is true and none is saved yet. */
  @ApiPropertyOptional({ type: 'integer' })
  @ValidateIf(sent)
  @IsInt()
  @Min(DM_PRICE_MIN_NAIRA * 100)
  @Max(DM_PRICE_MAX_NAIRA * 100)
  priceKobo?: number;

  /** Hours the creator has to reply. Left out means unchanged. */
  @ApiPropertyOptional({ type: 'integer' })
  @ValidateIf(sent)
  @IsInt()
  @Min(DM_RESPONSE_HOURS_MIN)
  @Max(DM_RESPONSE_HOURS_MAX)
  responseHours?: number;
}

/**
 * GET /paid-dm/settings/earn query (task INBOX-12, R-21). The price is checked
 * like the one `PUT /paid-dm/settings` takes: integer kobo inside the same
 * bounds, and whole naira (the service refuses the rest with a 400).
 */
export class PaidDmEarnQueryDto {
  /** The price to price a message at, in kobo. */
  @ApiProperty({ type: 'integer' })
  // Plain digits without leading zeros only: Number() also takes 0x1388, 0005000, " 5000" and +5000, which the PUT could never receive (INBOX-12 R2-1).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value)
      ? Number(value)
      : value,
  )
  @IsInt()
  @Min(DM_PRICE_MIN_NAIRA * 100)
  @Max(DM_PRICE_MAX_NAIRA * 100)
  priceKobo!: number;
}

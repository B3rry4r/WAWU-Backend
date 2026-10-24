import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { isCleanText } from '../../admin/legal-documents/policy-input';

export const CARD_KINDS = ['virtual', 'single_use'] as const;
export const CARD_NAME_MAX = 30;
export const ADMIN_CARD_STATES = [
  'creating',
  'unknown',
  'active',
  'frozen',
  'cancelled',
  'failed',
] as const;

/** POST /money/cards */
export class CreateCardDto {
  /** A reusable card, or one for a single payment (blocked after its first). */
  @ApiProperty({ enum: CARD_KINDS })
  @IsIn(CARD_KINDS)
  kind!: (typeof CARD_KINDS)[number];

  /** What the person calls it; a default is used when absent. 30 characters at most. */
  @ApiPropertyOptional({ maxLength: CARD_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CARD_NAME_MAX)
  name?: string;
}

/** GET /money/cards/{id}/transactions */
export class CardTransactionsQueryDto {
  /** `nextCursor` from the previous page. Opaque: send it back as given. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /** Rows per page, 1 to 50. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 50,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

/** GET admin/money/cards */
export class AdminCardsQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_CARD_STATES })
  @IsOptional()
  @IsIn(ADMIN_CARD_STATES)
  state?: (typeof ADMIN_CARD_STATES)[number];

  /** One person's cards. */
  @IsOptional()
  @IsUUID()
  wawuUserId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/** The name a card is given: trimmed, clean text, or null when the person gave none. */
export function cleanCardName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '') return null;
  return isCleanText(name) ? name : null;
}

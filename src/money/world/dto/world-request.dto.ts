import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** GET /money/world/options. */
export class WorldOptionsQueryDto {
  @ApiProperty({
    pattern: '^[A-Z]{2}$',
    description: 'The country the person lives in, ISO 3166-1 alpha-2.',
  })
  @Transform(upper)
  @Matches(/^[A-Z]{2}$/, { message: 'country must be a 2-letter country code' })
  country!: string;
}

/** Admin: the list of world openings. */
export class AdminWorldOpeningsQueryDto {
  @ApiPropertyOptional({ pattern: '^[A-Z]{2}$' })
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{2}$/, { message: 'country must be a 2-letter country code' })
  country?: string;

  @ApiPropertyOptional({
    enum: [
      'started',
      'needs_documents',
      'checking',
      'rejected',
      'approved',
      'open',
      'stopped',
      'expired',
      'frozen',
      'cancelled',
    ],
  })
  @IsOptional()
  @IsIn([
    'started',
    'needs_documents',
    'checking',
    'rejected',
    'approved',
    'open',
    'stopped',
    'expired',
    'frozen',
    'cancelled',
  ])
  stage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 400)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Admin: freeze, unfreeze or cancel needs a reason. */
export class AdminWorldActDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @IsString()
  @Length(3, 300)
  reason!: string;
}

/** POST /money/world/first-account: pick another first currency, when the first was refused. */
export class WorldFirstAccountDto {
  @ApiPropertyOptional({
    enum: ['USD', 'EUR', 'GBP', 'CAD', 'AED', 'GHS'],
    description:
      'Change the currency of the first account before it is open (for example after the provider declined the first one).',
  })
  @IsOptional()
  @IsIn(['USD', 'EUR', 'GBP', 'CAD', 'AED', 'GHS'])
  currency?: 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AED' | 'GHS';
}

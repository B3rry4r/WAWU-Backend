import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PLAN_ACTIONS } from '../../plans/plans-config';
import { POINTS_LIMITS } from '../points-config';

const ACTION_MESSAGE = `action must be one of: ${PLAN_ACTIONS.join(', ')}.`;
const UNITS_MESSAGE = 'units must be a whole number of 1 or more.';
const LANGUAGES_MESSAGE = 'languages must be a whole number of 1 or more.';
const CHARACTERS_MESSAGE = 'characters must be a whole number of 0 or more.';

/** The most languages one dubbing job names: a request bound, not a product figure. */
const MOST_LANGUAGES = 100;
/** The most characters a request may state: a request bound, not a product figure. */
const MOST_CHARACTERS = 100_000_000;

/** `POST /points/quote`: which AI tool, and how much of it. */
export class PointsQuoteDto {
  /** The AI tool, by the plan's id (`GET /plans` `actions` lists them with their cost). */
  @ApiProperty({ enum: PLAN_ACTIONS })
  @IsIn(PLAN_ACTIONS, { message: ACTION_MESSAGE })
  action!: string;

  /** How many of the action's unit: minutes, tracks, messages or uses (`GET /plans` says which). */
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: POINTS_LIMITS.maxPoints,
  })
  @IsInt({ message: UNITS_MESSAGE })
  @Min(1, { message: UNITS_MESSAGE })
  @Max(POINTS_LIMITS.maxPoints, { message: UNITS_MESSAGE })
  units!: number;

  /** Dubbing only: how many languages (1 when left out). Any other action refuses more than 1. */
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: MOST_LANGUAGES })
  @IsOptional()
  @IsInt({ message: LANGUAGES_MESSAGE })
  @Min(1, { message: LANGUAGES_MESSAGE })
  @Max(MOST_LANGUAGES, { message: LANGUAGES_MESSAGE })
  languages?: number;

  /** The text's length in characters, for a job that takes text; checked against the per-job cap. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: MOST_CHARACTERS,
  })
  @IsOptional()
  @IsInt({ message: CHARACTERS_MESSAGE })
  @Min(0, { message: CHARACTERS_MESSAGE })
  @Max(MOST_CHARACTERS, { message: CHARACTERS_MESSAGE })
  characters?: number;
}

/** `POST /points/shortfall`: the job the person is short for, and the wallet quote they were shown. The PIN is in `X-Transaction-Pin`, never here. */
export class PointsShortfallDto extends PointsQuoteDto {
  /** `wallet.payment.totalKobo` from the points quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedTotalKobo!: number;

  /** `wallet.payment.quoteToken` from that quote: the server checks it is its own, for this person and this shortfall, and not past its end. */
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}

/** `PUT /me/points/settings`. */
export class PointsSettingsDto {
  /** "Use wallet": when points run short, the quote shows the wallet money for the shortfall. Off by default. */
  @ApiProperty()
  @IsBoolean({ message: 'useWallet must be true or false.' })
  useWallet!: boolean;
}

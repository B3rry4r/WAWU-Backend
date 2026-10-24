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
  ValidateNested,
} from 'class-validator';
import { ADD_MONEY_RAILS } from '../../wallet-provider/add-money';

const KOBO_MESSAGE = 'amountKobo must be a whole number of kobo, 1 or more.';
const MAX_KOBO = 100_000_000_000;

const digits = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^[0-9]{1,13}$/.test(value)
    ? Number(value)
    : value;

/** `GET /money/add-money/quote?rail=&amountKobo=`. */
export class AddMoneyQuoteQueryDto {
  @ApiProperty({ enum: ADD_MONEY_RAILS })
  @IsIn(ADD_MONEY_RAILS, { message: 'rail must be one of the ways listed.' })
  rail!: (typeof ADD_MONEY_RAILS)[number];

  @Transform(digits)
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_KOBO })
  @IsInt({ message: KOBO_MESSAGE })
  @Min(1, { message: KOBO_MESSAGE })
  @Max(MAX_KOBO, { message: KOBO_MESSAGE })
  amountKobo!: number;
}

/** The cardholder's billing address, as the card network asks for it. */
export class AddMoneyBillingDto {
  @ApiProperty({ minLength: 3, maxLength: 120 })
  @IsString()
  @Length(3, 120)
  line1!: string;

  @ApiProperty({ minLength: 2, maxLength: 60 })
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiProperty({ minLength: 2, maxLength: 60 })
  @IsString()
  @Length(2, 60)
  state!: string;

  @ApiPropertyOptional({ maxLength: 12 })
  @IsOptional()
  @IsString()
  @Length(1, 12)
  postalCode?: string;
}

/** What the phone says of itself, for 3-D Secure. Every part is optional: the Hub fills a plain default. */
export class AddMoneyDeviceDto {
  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @Length(2, 20)
  language?: string;

  @ApiPropertyOptional({ maxLength: 6 })
  @IsOptional()
  @Matches(/^[0-9]{3,5}$/)
  screenWidth?: string;

  @ApiPropertyOptional({ maxLength: 6 })
  @IsOptional()
  @Matches(/^[0-9]{3,5}$/)
  screenHeight?: string;

  @ApiPropertyOptional({ maxLength: 4 })
  @IsOptional()
  @Matches(/^[0-9]{1,2}$/)
  colorDepth?: string;

  @ApiPropertyOptional({
    description: 'Minutes from UTC, as the phone says, for example -60.',
  })
  @IsOptional()
  @Matches(/^-?[0-9]{1,4}$/)
  timezoneOffset?: string;
}

/** The card, as the phone encrypted it. Never the card itself. */
export class AddMoneyCardDto {
  @ApiProperty({
    description:
      'The card encrypted on the phone with the provider public key (RSA-OAEP, SHA-256, base64).',
    minLength: 40,
    maxLength: 2048,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'encrypted must be base64.' })
  @Length(40, 2048)
  encrypted!: string;

  @ApiProperty({ type: AddMoneyBillingDto })
  @ValidateNested()
  @Type(() => AddMoneyBillingDto)
  billing!: AddMoneyBillingDto;

  @ApiPropertyOptional({ type: AddMoneyDeviceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddMoneyDeviceDto)
  device?: AddMoneyDeviceDto;
}

export class AddMoneyUssdDto {
  @ApiPropertyOptional({
    description:
      'The paying phone in international form; left out, the phone on the account is used.',
  })
  @IsOptional()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'msisdn must be a phone number.' })
  msisdn?: string;
}

/**
 * `POST /money/add-money`: the way, what the wallet gets, and what the person
 * was shown they would pay. The PIN is in `X-Transaction-Pin`, never here.
 */
export class AddMoneyDto {
  @ApiProperty({ enum: ADD_MONEY_RAILS })
  @IsIn(ADD_MONEY_RAILS, { message: 'rail must be one of the ways listed.' })
  rail!: (typeof ADD_MONEY_RAILS)[number];

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_KOBO })
  @IsInt({ message: KOBO_MESSAGE })
  @Min(1, { message: KOBO_MESSAGE })
  @Max(MAX_KOBO, { message: KOBO_MESSAGE })
  amountKobo!: number;

  @ApiProperty({
    type: 'integer',
    description:
      'What the person was shown they pay. If the quote changed, 409 quote_changed and nothing is charged.',
  })
  @IsInt({ message: 'chargeKobo must be a whole number of kobo.' })
  @Min(1)
  @Max(MAX_KOBO)
  chargeKobo!: number;

  @ApiPropertyOptional({
    type: AddMoneyCardDto,
    description: 'Required for rail card.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddMoneyCardDto)
  card?: AddMoneyCardDto;

  @ApiPropertyOptional({ type: AddMoneyUssdDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddMoneyUssdDto)
  ussd?: AddMoneyUssdDto;
}

/** `GET /money/add-money?cursor=&limit=`. */
export class AddMoneyListQueryDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{1,3}$/.test(value)
      ? Number(value)
      : value,
  )
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

const STATUSES = [
  'created',
  'awaiting_user',
  'processing',
  'settled',
  'failed',
  'expired',
  'cancelled',
] as const;

/** `GET /admin/money/add-money`. */
export class AdminAddMoneyQueryDto extends AddMoneyListQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: ADD_MONEY_RAILS })
  @IsOptional()
  @IsIn(ADD_MONEY_RAILS)
  rail?: (typeof ADD_MONEY_RAILS)[number];

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  wawuUserId?: string;
}

/** `POST /admin/money/add-money/{id}/freeze|unfreeze|cancel`. */
export class AdminAddMoneyActDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  reason?: string;
}

import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDivisibleBy,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DEFAULT_MERCHANT_MAX_PER_TXN_KOBO } from '../../money/fees/fee-config';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The longest a consultation can run: the whole working day. A sanity bound on
 * what an admin can type, so a slip of a digit cannot make a consultation that
 * never fits the calendar. The product's own lengths come from admin.
 */
export const MAX_CONSULTATION_MINUTES = 480;

/** The shortest an admin can set. A sanity bound, not a product rule. */
export const MIN_CONSULTATION_MINUTES = 5;

/** The most files one delivery can carry. */
export const MAX_DELIVERED_FILES = 10;

/** The kinds of consultation the app books. */
export class BookConsultationSlotDto {
  @IsIn(['zoom', 'phone', 'physical'])
  medium!: 'zoom' | 'phone' | 'physical';

  /**
   * The start of the hour the person picked, exactly as `GET
   * /legal/consultation/slots` gave it. Required for a video or phone call;
   * an in-person consultation is arranged directly and books no hour.
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  scheduledFor?: string;
}

export class ConsultationSlotsQueryDto {
  /** A video or phone call. An in-person consultation has no calendar. */
  @IsIn(['zoom', 'phone'])
  medium!: 'zoom' | 'phone';
}

/** Admin: set one consultation kind. Replaces the price, the length and the switch. */
export class SetConsultationPriceDto {
  /**
   * The price in kobo, whole naira only (a multiple of 100), or null to leave
   * the kind unpriced so the app does not offer it. Always null for an
   * in-person consultation.
   */
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(100)
  @Max(DEFAULT_MERCHANT_MAX_PER_TXN_KOBO)
  @IsDivisibleBy(100, { message: 'priceKobo must be whole naira.' })
  priceKobo!: number | null;

  /** How long it runs, in minutes, or null to leave the kind unset. Null for in person. */
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(MIN_CONSULTATION_MINUTES)
  @Max(MAX_CONSULTATION_MINUTES)
  minutes!: number | null;

  /** Switch the kind off without losing its price. Defaults to on. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Admin: set or clear a fixed-price service. */
export class SetServicePriceDto {
  /** The price in kobo, whole naira only, or null to quote the service instead. */
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(100)
  @Max(DEFAULT_MERCHANT_MAX_PER_TXN_KOBO)
  @IsDivisibleBy(100, { message: 'priceKobo must be whole naira.' })
  priceKobo!: number | null;
}

export class DeliveredFileDto {
  /** What the file is called in the chat and on the delivery screen. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[^\u0000-\u001f\u007f]+$/, {
    message: 'fileName cannot contain control characters.',
  })
  fileName!: string;

  /** Object-storage URL from POST /uploads/presign. */
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'url must be a full link' },
  )
  @MaxLength(600)
  url!: string;

  /** Page count, when it is known. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  pages?: number;
}

export class DeliverFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DELIVERED_FILES)
  @ValidateNested({ each: true })
  @Type(() => DeliveredFileDto)
  files!: DeliveredFileDto[];
}

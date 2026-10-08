import { ApiProperty } from '@nestjs/swagger';
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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { storedKeyProblem } from '../../storage/storage.service';
import { DEFAULT_MERCHANT_MAX_PER_TXN_KOBO } from '../../money/fees/fee-config';

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
  // A time with no zone would be read in the server's zone, which is a
  // different hour on a different host.
  @Matches(
    // The offset needs its minutes: `+01` is ISO 8601 but no JavaScript
    // date reads it, so it is refused here, naming the field, like a time
    // with no zone.
    /T\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})$/i,
    {
      message: 'scheduledFor must end with Z or a +hh:mm offset.',
    },
  )
  // Whatever form it takes, it must be a time the server can read.
  @ValidateBy({
    name: 'readableTime',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' && !Number.isNaN(Date.parse(v)),
      defaultMessage: () => 'scheduledFor must be a date and time.',
    },
  })
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
  @ApiProperty({ type: 'integer', nullable: true })
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
  @ApiProperty({ type: 'integer', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(100)
  @Max(DEFAULT_MERCHANT_MAX_PER_TXN_KOBO)
  @IsDivisibleBy(100, { message: 'priceKobo must be whole naira.' })
  priceKobo!: number | null;
}

/**
 * Trims ordinary whitespace only. `String.trim` also removes the BOM and the
 * line and paragraph separators, which would let a name with one at its edge
 * through as a clean name instead of being refused.
 */
const trimPlainSpace = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string'
    ? value.replace(
        /^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g,
        '',
      )
    : value;

export class DeliveredFileDto {
  /** What the file is called in the chat and on the delivery screen. */
  @Transform(trimPlainSpace)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  // eslint-disable-next-line no-control-regex -- these ranges ARE the control characters being refused
  @Matches(/^[^\u0000-\u001f\u007f]+$/, {
    message: 'fileName cannot contain control characters.',
  })
  // A lone surrogate is not text: it cannot be stored or sent as UTF-8.
  @Matches(/^(?:[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])+$/, {
    message: 'fileName must be plain text.',
  })
  // No path: a name is a name, never a place to save to.
  @Matches(/^[^/\\]+$/, { message: 'fileName cannot contain / or \\.' })
  @Matches(/^(?!\.{1,2}$)/, { message: 'fileName cannot be . or ..' })
  // Bidirectional controls, line and paragraph separators, NEL and the BOM
  // change how a name reads, not what it is.
  @Matches(/^[^\u202a-\u202e\u2066-\u2069\u2028\u2029\u0085\ufeff]+$/, {
    message: 'fileName cannot contain direction or line-break characters.',
  })
  // Something must be left once format and whitespace characters are gone.
  @Matches(/[^\p{Cf}\p{Z}\s]/u, {
    message: 'fileName must have visible characters.',
  })
  fileName!: string;

  /**
   * The file's `fileUrl` or `key` from POST /uploads/presign: a link on WAWU
   * storage or a bare key, under `legal/document/`. Anything else is refused
   * with a 400 naming this field (N1).
   */
  @IsString({ message: 'url must be a link or an object key.' })
  @IsNotEmpty({ message: 'url must be a link or an object key.' })
  @MaxLength(600)
  // eslint-disable-next-line no-control-regex -- these ranges ARE the control characters being refused
  @Matches(/^[^\u0000-\u001f\u007f]+$/, {
    message: 'url cannot contain control characters.',
  })
  // A lone surrogate is not text: it would be stored as U+FFFD, a different link.
  @Matches(/^(?:[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])+$/, {
    message: 'url must be plain text.',
  })
  // The path, once decoded, must be storable as an object key.
  @ValidateBy({
    name: 'urlKey',
    validator: {
      validate: (v: unknown) => storedKeyProblem(v) === null,
      defaultMessage: (a) =>
        `url ${storedKeyProblem(a?.value) ?? 'cannot be used'}.`,
    },
  })
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
  // Every element must be an object (not null, a string, a number or an array).
  @ValidateBy({
    name: 'filesAreObjects',
    validator: {
      validate: (v: unknown) =>
        Array.isArray(v) &&
        v.every(
          (f) => typeof f === 'object' && f !== null && !Array.isArray(f),
        ),
      defaultMessage: () =>
        'files must each be an object with fileName and url.',
    },
  })
  @ValidateNested({ each: true })
  @Type(() => DeliveredFileDto)
  files!: DeliveredFileDto[];
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { EventFormat, EventType } from '../../../generated/prisma/enums';

/**
 * One speaker on a submitted event.
 *
 * `initials` is NOT accepted: it is derived from `name` on the way out
 * (event-view.type.ts), so there is exactly one definition of it.
 */
export class EventSpeakerDto {
  @IsString()
  @Matches(/\S/, { message: 'a speaker needs a name.' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  /** Display order. Defaulted by position when omitted. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  order?: number;
}

/**
 * POST /events body.
 *
 * ── NO TICKETING, ENFORCED HERE FIRST ────────────────────────────────────────
 * The global ValidationPipe runs with `forbidNonWhitelisted`, so a request
 * carrying `price`, `ticketPrice`, `amount`, `currency` or anything else not
 * declared below is a 400 before the service is ever reached. That is not an
 * accident of configuration — it is the cheapest possible enforcement of the
 * one line docs/01_SPEC.md draws around this feature. Paid registration, if the
 * organiser runs one, lives behind `externalUrl` on their own site.
 *
 * Creation is open to any authenticated WAWU user, not only creator accounts:
 * an event costs no upload slot and earns nobody anything, so there is no gate
 * for a paid subscription to be. The moderation queue is the gate.
 */
export class CreateEventDto {
  @IsString()
  @Matches(/\S/, { message: 'name is required.' })
  @MaxLength(160)
  name!: string;

  @IsString()
  @Matches(/\S/, { message: 'description is required.' })
  @MaxLength(5000)
  description!: string;

  /** The organisation running it — the old EventItem's `org`. */
  @IsString()
  @Matches(/\S/, { message: 'hostOrg is required.' })
  @MaxLength(160)
  hostOrg!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  hostOrgBio?: string;

  @IsEnum(EventFormat)
  format!: EventFormat;

  @IsEnum(EventType)
  type!: EventType;

  /**
   * ISO 8601. The authoritative instant — the only thing upcoming/past is
   * decided on. Not required to be in the future: an event whose start passes
   * while it sits in the moderation queue is a scheduling fact, not an invalid
   * submission, and a host writing up a past event's recap has to be able to
   * create it at all.
   */
  @IsDateString()
  startsAt!: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  /** Display only, e.g. "10:00 AM". The server never renders a local time itself. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  timeLabel?: string;

  /** Display only, e.g. "WAT". */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  timezone?: string;

  @IsString()
  @Matches(/\S/, { message: 'location is required.' })
  @MaxLength(160)
  location!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  /**
   * The organiser's own page. `require_protocol` and an http(s)-only protocol
   * list, so a submitted `javascript:` or `data:` URL cannot reach a client
   * that renders this as a link.
   */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  externalUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EventSpeakerDto)
  speakers?: EventSpeakerDto[];
}

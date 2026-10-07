import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EventCategory, TicketTier } from '../../../generated/prisma/enums';
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

  /** Object-storage URL from POST /uploads/presign (folder "event/speaker"). */
  @IsOptional()
  @IsUrl()
  photoUrl?: string;

  /** Display order. Defaulted by position when omitted. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  order?: number;
}

/** How many ticket types one submit may carry. */
export const MAX_TICKET_TYPES_PER_EVENT = 20;

// One message per field: class-validator reports a single constraint, and for a
// value that is not a number it is the range one, which names the wrong problem.
const PRICE_MESSAGE =
  'priceNaira must be a whole number of naira, from 0 to 10000000.';
const QUANTITY_MESSAGE = 'quantity must be a whole number, from 1 to 1000000.';

/**
 * One ticket type sent with a new event: what the host wizard asks for, a
 * name, a price and how many.
 *
 * `tier` is optional because the wizard never asks for one. Left out, a price
 * of 0 is the `free` tier (R-8: a ₦0 event is allowed) and any other price is
 * `regular`. Sent, it follows the same rules PUT /events/:id/tickets applies:
 * a paid tier needs a price above 0 and a free tier cannot have one.
 */
export class NewEventTicketTypeDto {
  @IsString()
  @Matches(/\S/, { message: 'a ticket type needs a name.' })
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  /** Naira, like every ticket price this backend stores. 0 is a free ticket. */
  // No `@Type(() => Number)` here or on `quantity`: JSON must carry a number.
  // Coercion turned `""` into a free ticket and `"5000"`, `true` and `"0x10"`
  // into values the host never typed. PUT /events/:id/tickets refuses them too.
  @IsInt({ message: PRICE_MESSAGE })
  @Min(0, { message: PRICE_MESSAGE })
  @Max(10_000_000, { message: PRICE_MESSAGE })
  priceNaira!: number;

  /** How many exist. A venue has a capacity, so there is no unlimited option. */
  @IsInt({ message: QUANTITY_MESSAGE })
  @Min(1, { message: QUANTITY_MESSAGE })
  @Max(1_000_000, { message: QUANTITY_MESSAGE })
  quantity!: number;

  @IsOptional()
  @IsEnum(TicketTier)
  tier?: TicketTier;
}

/**
 * POST /events body.
 *
 * ── PRICES ONLY THROUGH `ticketTypes` ─────────────────────────────────────────
 * The global ValidationPipe runs with `forbidNonWhitelisted`, so a request
 * carrying `price`, `ticketPrice`, `amount`, `currency` or anything else not
 * declared below is a 400 before the service is ever reached. The one place a
 * price enters an event is a ticket type: `ticketTypes` here (EVENTS-02, so
 * the app's wizard submits once) or PUT /events/:id/tickets. Selling a ticket
 * is EventTicketingService's, never this module's.
 *
 * Hosting is for verified accounts only (EventService.assertMayHost). The
 * moderation queue then decides whether anyone else ever sees the event.
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

  /**
   * The city or venue line the card shows. Optional (EVENTS-02): the app's
   * host wizard asks only for the street address, so when this is left out
   * the server fills it from `address`, and leaves it empty when there is no
   * address either. A value sent here is stored as sent, as before.
   */
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'location cannot be blank.' })
  @MaxLength(160)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  /**
   * The venue by NAME, e.g. "Eko Convention Centre".
   *
   * Separate from `location`, which the card renders as the city. An online
   * event simply omits it, and so may an in-person one whose organiser has
   * only given a city, which is why nothing here is required.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  venueName?: string;

  /**
   * The organiser's own page. `require_protocol` and an http(s)-only protocol
   * list, so a submitted `javascript:` or `data:` URL cannot reach a client
   * that renders this as a link.
   */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  externalUrl?: string;

  /** Banner image. Object-storage URL from POST /uploads/presign. */
  @IsOptional()
  @IsUrl()
  bannerUrl?: string;

  /** What the event is about. Defaults to `other` when not stated. */
  @IsOptional()
  @IsEnum(EventCategory)
  category?: EventCategory;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactPhone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EventSpeakerDto)
  speakers?: EventSpeakerDto[];

  /**
   * The ticket types, sent with the event in the same submit (EVENTS-02), so
   * the event and its tickets go to review together. Omitted or empty, the
   * event sells nothing, exactly as before. The tiers can still be replaced
   * afterwards through PUT /events/:id/tickets.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TICKET_TYPES_PER_EVENT)
  // `@ValidateNested` lets an element that is an array (`[[]]`) through, and
  // the service then failed on it with a 500. Every element that is not a
  // plain object (an array, null, a string, a number) is a 400 here, before
  // anything is written.
  @IsObject({ each: true, message: 'each ticket type must be an object' })
  @ValidateNested({ each: true })
  @Type(() => NewEventTicketTypeDto)
  ticketTypes?: NewEventTicketTypeDto[];
}

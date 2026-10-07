import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AdCampaignStatus,
  AdCtaDestination,
  AdPlacement,
} from '../../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { AD_WEIGHT_MAX, AD_WEIGHT_MIN } from '../../../ads/ads-limits';
import { AD_TEXT_LIMITS } from '../../../ads/ads-text-limits';
import { AdText, IsArtworkUrl, IsUtcInstant } from './ad-field-decorators';

/**
 * "Optional" for a field that cannot be null: a field left out is unchanged, a
 * field sent as null is refused (class-validator's own IsOptional would let
 * null through to the database).
 */
const Optional = () => ValidateIf((_, value) => value !== undefined);

/** The placements and statuses as plain lists, so `@IsIn` names them in its message. */
const PLACEMENTS = Object.values(AdPlacement);
const STATUSES = Object.values(AdCampaignStatus);
const DESTINATIONS = Object.values(AdCtaDestination);
const PHASES = ['upcoming', 'running', 'over'] as const;

/**
 * Event ids are uuids, but the version is not pinned: ids already stored are
 * not all v4 (the same reason the events routes leave ParseUUIDPipe unpinned).
 * Lower-cased so one event has one spelling.
 */
const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lowerCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * The card (H33 and H36). Everything on it is here and nothing else. The
 * global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so an
 * undeclared field is a 400.
 */
export class CreateAdCreativeDto {
  @AdText('headline', AD_TEXT_LIMITS.headline)
  headline!: string;

  /** Place, date and price as the team types them. Leave it out for no second line. */
  @IsOptional()
  @AdText('subline', AD_TEXT_LIMITS.subline)
  subline?: string | null;

  @AdText('ctaLabel', AD_TEXT_LIMITS.ctaLabel)
  ctaLabel!: string;

  /** What the button opens. The allow-list is the AdCtaDestination enum: `event` today. */
  @IsIn(DESTINATIONS)
  ctaDestination!: AdCtaDestination;

  /** For `event`, an Event id. The event must be published and not over. */
  @Transform(lowerCase)
  @IsString()
  @Matches(UUID_LIKE, { message: 'ctaDestinationId must be an event id.' })
  ctaDestinationId!: string;

  /** An https link to the picture. Leave it out for a card without one. */
  @IsOptional()
  @IsArtworkUrl()
  artworkUrl?: string | null;
}

/** POST /admin/ads. Creates a draft: nothing is served until it is scheduled. */
export class CreateAdCampaignDto {
  @AdText('advertiser', AD_TEXT_LIMITS.advertiser)
  advertiser!: string;

  @IsIn(PLACEMENTS)
  placement!: AdPlacement;

  /** UTC, ISO 8601 ending in Z. It may be in the past: the card then starts when scheduled. */
  @IsUtcInstant('startsAt')
  startsAt!: string;

  /** UTC. Must come after startsAt, and must not have passed yet. */
  @IsUtcInstant('endsAt')
  endsAt!: string;

  /** Ranks bookings that overlap on one placement. Range: src/ads/ads-limits.ts. */
  @Optional()
  @IsInt()
  @Min(AD_WEIGHT_MIN)
  @Max(AD_WEIGHT_MAX)
  weight?: number;

  @IsObject()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => CreateAdCreativeDto)
  creative!: CreateAdCreativeDto;
}

/** The card's fields that may change. A field left out is unchanged; null clears the two that are optional. */
export class UpdateAdCreativeDto {
  @Optional()
  @AdText('headline', AD_TEXT_LIMITS.headline)
  headline?: string;

  @IsOptional()
  @AdText('subline', AD_TEXT_LIMITS.subline)
  subline?: string | null;

  @Optional()
  @AdText('ctaLabel', AD_TEXT_LIMITS.ctaLabel)
  ctaLabel?: string;

  @Optional()
  @IsIn(DESTINATIONS)
  ctaDestination?: AdCtaDestination;

  @Optional()
  @Transform(lowerCase)
  @IsString()
  @Matches(UUID_LIKE, { message: 'ctaDestinationId must be an event id.' })
  ctaDestinationId?: string;

  @IsOptional()
  @IsArtworkUrl()
  artworkUrl?: string | null;
}

/** PATCH /admin/ads/:id. Only a draft or a paused campaign can be edited. */
export class UpdateAdCampaignDto {
  @Optional()
  @AdText('advertiser', AD_TEXT_LIMITS.advertiser)
  advertiser?: string;

  @Optional()
  @IsIn(PLACEMENTS)
  placement?: AdPlacement;

  @Optional()
  @IsUtcInstant('startsAt')
  startsAt?: string;

  @Optional()
  @IsUtcInstant('endsAt')
  endsAt?: string;

  @Optional()
  @IsInt()
  @Min(AD_WEIGHT_MIN)
  @Max(AD_WEIGHT_MAX)
  weight?: number;

  @Optional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateAdCreativeDto)
  creative?: UpdateAdCreativeDto;
}

/**
 * GET /admin/ads/report filters. `from` and `to` keep the campaigns whose
 * window overlaps [from, to): they start before `to` and end after `from`.
 */
export class AdCampaignFilterDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: AdCampaignStatus;

  @IsOptional()
  @IsIn(PLACEMENTS)
  placement?: AdPlacement;

  /** What the window is doing now: `upcoming`, `running` or `over`. */
  @IsOptional()
  @IsIn(PHASES)
  phase?: (typeof PHASES)[number];

  @IsOptional()
  @IsUtcInstant('from')
  from?: string;

  @IsOptional()
  @IsUtcInstant('to')
  to?: string;
}

/**
 * GET /admin/ads query: the report's filters, plus offset pages like every
 * other admin list (PaginationQueryDto) and a sort.
 */
export class AdCampaignListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: AdCampaignStatus;

  @IsOptional()
  @IsIn(PLACEMENTS)
  placement?: AdPlacement;

  @IsOptional()
  @IsIn(PHASES)
  phase?: (typeof PHASES)[number];

  @IsOptional()
  @IsUtcInstant('from')
  from?: string;

  @IsOptional()
  @IsUtcInstant('to')
  to?: string;

  /** By window start: `latest` (newest first, the default) or `soonest`. Ties break on id. */
  @IsOptional()
  @IsIn(['latest', 'soonest'])
  sort: 'latest' | 'soonest' = 'latest';
}

/**
 * GET /admin/ads/:id/report. `from` and `to` choose which days of counts are
 * added up: the UTC days with any part inside [from, to), `to` exclusive. They
 * do not filter the campaign, which is the one in the path.
 */
export class AdReportRangeDto {
  @IsOptional()
  @IsUtcInstant('from')
  from?: string;

  @IsOptional()
  @IsUtcInstant('to')
  to?: string;
}

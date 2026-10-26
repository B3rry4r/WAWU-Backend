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
import {
  AdText,
  IsArtworkUrl,
  IsCtaUrl,
  IsUtcInstant,
} from './ad-field-decorators';

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
/** `missing`: the campaigns that still need artwork (saved before R-59 without any, not ended). */
const ARTWORK_FILTERS = ['missing'] as const;

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

  /**
   * The button's words. Required for `event` and `link`; a `none` card has no
   * button, so it must not carry one. Which of the two applies is checked in
   * the service, with the rest of the destination's rules.
   */
  @Optional()
  @AdText('ctaLabel', AD_TEXT_LIMITS.ctaLabel)
  ctaLabel?: string;

  /**
   * What a tap does (R-92): `link` opens `ctaUrl` in the phone's browser,
   * `none` does nothing, `event` opens an event (kept for the campaigns that
   * already use it; the dashboard no longer offers it).
   */
  @IsIn(DESTINATIONS)
  ctaDestination!: AdCtaDestination;

  /** For `event` only, an Event id. The event must be published and not over. */
  @Optional()
  @Transform(lowerCase)
  @IsString()
  @Matches(UUID_LIKE, { message: 'ctaDestinationId must be an event id.' })
  ctaDestinationId?: string;

  /**
   * For `link` only: the https address the card opens, as the artwork link is
   * checked (public host, no password, no spaces, at most AD_LINK_URL_MAX),
   * stored in its normal form.
   */
  @Optional()
  @IsCtaUrl()
  ctaUrl?: string;

  /**
   * An https link to the picture. REQUIRED (R-59): a campaign without artwork
   * is refused with 422 "Add artwork before you save this campaign". It is
   * checked in the service, after the rest of the body has passed, so the
   * refusal is a 422 and not the validation pipe's 400.
   */
  @IsOptional()
  @IsArtworkUrl()
  artworkUrl?: string | null;

  /**
   * The landscape picture (R-92): 16:9, 1920 x 1080, an https link (the one an
   * upload to `POST /admin/ads/artwork` returns, or one that is hosted already).
   * It shows in the Explore slider AND on the Today strip. Optional; a booking
   * needs this, `portraitUrl` or both (422 "Add artwork ..." otherwise).
   */
  @IsOptional()
  @IsArtworkUrl()
  landscapeUrl?: string | null;

  /**
   * The portrait picture (R-92): 1080 x 2340, the shape of a phone screen. It
   * shows in the TGIF full screen. Optional, as `landscapeUrl`.
   */
  @IsOptional()
  @IsArtworkUrl()
  portraitUrl?: string | null;
}

/** POST /admin/ads. Creates a draft: nothing is served until it is scheduled. */
export class CreateAdCampaignDto {
  @AdText('advertiser', AD_TEXT_LIMITS.advertiser)
  advertiser!: string;

  /**
   * Only for a booking made with the single `creative.artworkUrl` (the body the
   * dashboard sent until R-92's two shapes), where it is required: 400 without
   * it. A booking made with `creative.landscapeUrl` or `portraitUrl` takes none,
   * and is refused with 400 if one is sent: where it shows follows from its
   * pictures.
   */
  @Optional()
  @IsIn(PLACEMENTS)
  placement?: AdPlacement;

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

  /** A new address for a `link` card. Only a card that opens a link has one. */
  @Optional()
  @IsCtaUrl()
  ctaUrl?: string;

  /** A new https link to the picture. Sending null, or leaving a campaign that has none without one, is refused with 422 (R-59). Only for a booking saved before the two shapes. */
  @IsOptional()
  @IsArtworkUrl()
  artworkUrl?: string | null;

  /**
   * A new landscape picture (16:9, 1920 x 1080), or null to take it away. Sending
   * it for a booking that has the single `artworkUrl` moves the booking to the
   * two shapes: its own picture stays where it showed (as the landscape or the
   * portrait picture) unless this request names that shape.
   */
  @IsOptional()
  @IsArtworkUrl()
  landscapeUrl?: string | null;

  /** A new portrait picture (1080 x 2340), or null to take it away. */
  @IsOptional()
  @IsArtworkUrl()
  portraitUrl?: string | null;
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

  /** `missing`: only the campaigns that need artwork before they can be served. */
  @IsOptional()
  @IsIn(ARTWORK_FILTERS)
  artwork?: (typeof ARTWORK_FILTERS)[number];

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

  /** `missing`: only the campaigns that need artwork before they can be served. */
  @IsOptional()
  @IsIn(ARTWORK_FILTERS)
  artwork?: (typeof ARTWORK_FILTERS)[number];

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

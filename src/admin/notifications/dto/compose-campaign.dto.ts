import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NotificationAudience } from '../../../../generated/prisma/enums';

/**
 * Tones a campaign may use.
 *
 * `danger` and `warning` are missing on purpose. Those two are the app's
 * money-and-deadline colours: red is "your paid DM expires in an hour", amber
 * is "you are out of credits". A promotion borrowing them is the oldest dark
 * pattern there is, and one campaign dressed as an emergency teaches every
 * user to ignore the real one.
 */
export const CAMPAIGN_TONES = ['accent', 'info', 'neutral', 'success'] as const;
export type CampaignTone = (typeof CAMPAIGN_TONES)[number];

/**
 * No em-dash in anything a user reads. A product-owner instruction
 * (CLAUDE.md, 1 Sep 2026), and campaign copy is the one place in this backend
 * where a human types a user-facing string at runtime, so it is the one place
 * the rule cannot be held by code review.
 *
 * En-dash is refused with it: it is the same typographic import from a word
 * processor and reads identically at 13px.
 */
const NO_DASHES = /^[^—–]*$/;
const DASH_MESSAGE =
  'copy must not contain an em-dash or en-dash. Use a comma, a colon, brackets, or two sentences.';

/**
 * POST /admin/notifications/campaigns body (build brief C8).
 *
 * Bounds, and why each one:
 *
 * `title`   70 chars. The notification list truncates a title to one line at
 *           390px; past ~70 nobody reads the end of it anyway.
 * `body`    220 chars. Two lines under a 16:9 picture. This is the number
 *           that keeps the card a card rather than an essay with a photo on
 *           top, and the composer shows the count as you type.
 * `imageUrl` an https URL. Not a file upload: this backend has no admin-side
 *           presign route, and inventing one to fake completeness would be
 *           worse than saying so. See DECISIONS.md D17d.
 *
 * The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`
 * (src/main.ts), so an undeclared property is a 400 here as everywhere else.
 */
export class ComposeCampaignDto {
  @IsString()
  @MinLength(3)
  @MaxLength(70)
  @Matches(NO_DASHES, { message: DASH_MESSAGE })
  title!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(220)
  @Matches(NO_DASHES, { message: DASH_MESSAGE })
  body!: string;

  /**
   * The picture. Optional: an announcement with nothing to show renders as
   * the compact row, which is better than a stock photograph chosen to fill a
   * frame.
   */
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  imageUrl?: string;

  /**
   * Button label and destination. BOTH or NEITHER, enforced in the service:
   * a label with no destination is a dead control, and a destination with no
   * label is unreachable.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(24)
  @Matches(NO_DASHES, { message: DASH_MESSAGE })
  actionLabel?: string;

  /** Checked against CAMPAIGN_DESTINATIONS in the service, which is the allowlist. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  actionHref?: string;

  @IsOptional()
  @IsIn(CAMPAIGN_TONES)
  tone: CampaignTone = 'accent';

  @IsEnum(NotificationAudience)
  audience!: NotificationAudience;
}

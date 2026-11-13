import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { BadRequestException } from '@nestjs/common';
import { EMAIL_BRANDS, MAX_CAMPAIGN_RECIPIENTS } from '../email-config';

/** No em-dash or en-dash in anything a person reads (CLAUDE.md, R-5). */
const NO_DASHES = /^[^—–]*$/;
const DASH_MESSAGE =
  'must not contain an em-dash or en-dash. Use a comma, a colon, brackets, or two sentences.';

/** One line, no em-dash or en-dash. */
const ONE_LINE_NO_DASHES = /^[^\r\n—–]*$/;
/** https only; a merge field may stand for the start ({{app_link}}). */
const HTTPS_OR_FIELD = /^(https:\/\/\S+|\{\{\s*(app|join)_link\s*\}\}\S*)$/i;

/** EMAIL-03: optional brand and button, shared by the template and the preview. */
export class EmailBrandButtonDto {
  @IsOptional()
  @IsIn(EMAIL_BRANDS)
  brand?: (typeof EMAIL_BRANDS)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(ONE_LINE_NO_DASHES, {
    message: 'buttonText must be one line with no em-dash or en-dash.',
  })
  buttonText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(HTTPS_OR_FIELD, {
    message: 'buttonUrl must be an https address.',
  })
  buttonUrl?: string | null;
}

/** Both button fields or neither (400 otherwise). */
export function assertButtonPair(
  text: string | null | undefined,
  url: string | null | undefined,
): void {
  if (Boolean(text) !== Boolean(url)) {
    throw new BadRequestException(
      'Give both the button text and the button link, or neither.',
    );
  }
}

export class EmailTemplateDto extends EmailBrandButtonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(NO_DASHES, { message: `subject ${DASH_MESSAGE}` })
  subject!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(NO_DASHES, { message: `previewText ${DASH_MESSAGE}` })
  previewText?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  @Matches(NO_DASHES, { message: `body ${DASH_MESSAGE}` })
  body!: string;

  /** The version the editor loaded. A save over a newer one is refused. */
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class EmailPreviewDto extends EmailBrandButtonDto {
  @IsString()
  @MaxLength(200)
  subject!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  previewText?: string;

  @IsString()
  @MaxLength(20000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;
}

export class EmailTestSendDto extends EmailPreviewDto {
  @IsEmail()
  @MaxLength(254)
  to!: string;
}

export const REGISTRANT_FILTERS = [
  'all',
  'paid',
  'not_paid',
  'opted_in',
] as const;
export type RegistrantFilter = (typeof REGISTRANT_FILTERS)[number];

export class RegistrantAudienceQueryDto {
  /** The brand of the template the list is for, so the count uses the build's skip rules. */
  @IsOptional()
  @IsIn(EMAIL_BRANDS)
  brand?: (typeof EMAIL_BRANDS)[number];

  @IsOptional()
  @IsIn(REGISTRANT_FILTERS)
  filter: RegistrantFilter = 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CAMPAIGN_RECIPIENTS)
  limit?: number;
}

export class CreateRegistrantCampaignDto extends RegistrantAudienceQueryDto {
  @IsUUID()
  templateId!: string;
}

/** The multipart fields next to the CSV file. */
export class CreateCsvCampaignDto {
  @IsUUID()
  templateId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CAMPAIGN_RECIPIENTS)
  limit?: number;
}

export class EmailTemplateListQueryDto {
  @IsOptional()
  @IsIn(EMAIL_BRANDS)
  brand?: (typeof EMAIL_BRANDS)[number];
}

/** The count for the accounts and Voices lists: just a limit. */
export class MemberAudienceQueryDto {
  /** The brand of the template the list is for, so the count uses the build's skip rules. */
  @IsOptional()
  @IsIn(EMAIL_BRANDS)
  brand?: (typeof EMAIL_BRANDS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CAMPAIGN_RECIPIENTS)
  limit?: number;
}

export class CreateMemberCampaignDto extends MemberAudienceQueryDto {
  @IsUUID()
  templateId!: string;
}

export const DELIVERY_RESULTS = [
  'delivered',
  'delayed',
  'bounced',
  'complained',
  'failed',
] as const;

export const RECIPIENT_STATUSES = [
  'queued',
  'sent',
  'failed',
  'skipped',
] as const;

export class EmailRecipientQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum({
    queued: 'queued',
    sent: 'sent',
    failed: 'failed',
    skipped: 'skipped',
  })
  status?: (typeof RECIPIENT_STATUSES)[number];

  /** EMAIL-03: what the provider reported after the mail was accepted. */
  @IsOptional()
  @IsIn(DELIVERY_RESULTS)
  delivery?: (typeof DELIVERY_RESULTS)[number];
}

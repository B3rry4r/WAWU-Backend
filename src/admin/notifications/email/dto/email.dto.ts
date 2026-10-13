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
import { MAX_CAMPAIGN_RECIPIENTS } from '../email-config';

/** No em-dash or en-dash in anything a person reads (CLAUDE.md, R-5). */
const NO_DASHES = /^[^—–]*$/;
const DASH_MESSAGE =
  'must not contain an em-dash or en-dash. Use a comma, a colon, brackets, or two sentences.';

export class EmailTemplateDto {
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

export class EmailPreviewDto {
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
}

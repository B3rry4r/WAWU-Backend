import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { EventCategory } from '../../../generated/prisma/enums';
import { EventFormat, EventType } from '../../../generated/prisma/enums';
import { EventSpeakerDto } from './create-event.dto';

/**
 * PATCH /events/:id body — every field optional, spelled out rather than
 * derived with `PartialType`, because `@nestjs/mapped-types` is not a
 * dependency of this project and adding one for four lines of convenience is
 * not worth the supply chain.
 *
 * `featured` and `status` are ABSENT on purpose and cannot be added. A host
 * pinning their own event to the featured rail, or publishing it themselves,
 * would be the whole moderation gate handed to the submitter. Both belong to
 * `src/admin/events/` alone.
 *
 * Same `forbidNonWhitelisted` protection as create: no price, no ticket, no
 * amount, no currency reaches the service, because none of them is declared.
 *
 * Supplying `speakers` REPLACES the whole list — a partial merge on an ordered
 * child collection has no correct answer for "which of these is the row I
 * meant". Omitting it leaves the existing speakers untouched.
 */
export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'name cannot be blank.' })
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'description cannot be blank.' })
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'hostOrg cannot be blank.' })
  @MaxLength(160)
  hostOrg?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  hostOrgBio?: string;

  @IsOptional()
  @IsEnum(EventFormat)
  format?: EventFormat;

  @IsOptional()
  @IsEnum(EventType)
  type?: EventType;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  timeLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'location cannot be blank.' })
  @MaxLength(160)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

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

  /**
   * The post-event write-up. Update-only, not part of create: a recap is
   * something that exists after the event, and the host posting it goes back
   * through review like any other edit — a "recap" field is a free-text box on
   * a published page, which is exactly what moderation is for.
   */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  recapUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  recapText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EventSpeakerDto)
  speakers?: EventSpeakerDto[];
}

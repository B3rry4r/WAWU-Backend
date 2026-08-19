import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';
import { AccountType } from '../../../generated/prisma/enums';

/**
 * PATCH /users/me body — registry.json UserProfile contract. Exactly the
 * registry's declared body fields; `websiteUrl` is deliberately NOT here
 * even though it's a UserProfile column, because the registry's PATCH body
 * list omits it (read-only via this endpoint per the frozen contract).
 * `@IsOptional()` treats an explicit `null` the same as `undefined` (skips
 * the rest of that field's validators), so a client MAY send `null` to
 * clear a nullable field, matching CreateCommentDto's `replyToId` idiom.
 */
export class UpdateUserProfileDto {
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  interests?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[a-zA-Z0-9_.]+$/, {
    message: 'handle may only contain letters, numbers, underscores, and dots',
  })
  handle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  instagramHandle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  whatsappHandle?: string | null;

  /**
   * The rest of where a creator can be reached. Handles are short strings;
   * the three URL fields take a full link, validated as one so a profile
   * cannot publish something that will not open.
   */
  @IsOptional() @IsString() @MaxLength(50) xHandle?: string | null;
  @IsOptional() @IsString() @MaxLength(50) tiktokHandle?: string | null;
  @IsOptional() @IsUrl({}, { message: 'youtubeUrl must be a full link' }) @MaxLength(200) youtubeUrl?: string | null;
  @IsOptional() @IsUrl({}, { message: 'facebookUrl must be a full link' }) @MaxLength(200) facebookUrl?: string | null;
  @IsOptional() @IsUrl({}, { message: 'linkedinUrl must be a full link' }) @MaxLength(200) linkedinUrl?: string | null;
  @IsOptional() @IsUrl({}, { message: 'websiteUrl must be a full link' }) @MaxLength(200) websiteUrl?: string | null;
}

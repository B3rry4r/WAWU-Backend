import { IsOptional, IsString } from 'class-validator';

/**
 * registry.json § Mentor — `GET /services/mentors` accepts an optional
 * `category` query filter (matches the `@@index([category])` the schema
 * agent put on Mentor). `category` is a plain String on the schema (no
 * enum given in the registry), so this is a free-text filter, not an
 * `@IsIn` allowlist.
 */
export class ListMentorsQueryDto {
  @IsOptional()
  @IsString()
  category?: string;
}

import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { EventCategory, EventFormat, EventType } from '../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * GET /events query.
 *
 * The old app sent ONE `filter` chip whose value could be either a format
 * ("In-Person", "Online") or a type ("Workshop", "Summit", …) and had a
 * `matchEv` helper on the client to work out which. Here they are two
 * parameters, because one string that means two different columns is a filter
 * that cannot be indexed and cannot be combined ("online workshops" was
 * unaskable). The "All" chip is simply neither parameter.
 *
 * Offset pagination inherited from the app's own PaginationQueryDto rather
 * than a second convention (conventions.md § Pagination).
 */
export class ListEventsQueryDto extends PaginationQueryDto {
  /**
   * `upcoming` (default) or `past`, decided on `endsAt ?? startsAt` against
   * now — a two-day summit is still upcoming on its second morning.
   */
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  view: 'upcoming' | 'past' = 'upcoming';

  @IsOptional()
  @IsEnum(EventFormat)
  format?: EventFormat;

  @IsOptional()
  @IsEnum(EventType)
  type?: EventType;

  /**
   * The browse-by-category chip row. Independent of `format` and `type`: a
   * music event can be online or in person, and a workshop or a summit.
   */
  @IsOptional()
  @IsEnum(EventCategory)
  category?: EventCategory;

  /**
   * The featured rail is `?featured=true&perPage=1`, not a second endpoint and
   * not an extra key hung off the list envelope — the ResponseInterceptor
   * renders exactly one canonical envelope and a bespoke `featured` sibling
   * would be a second one.
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  featured?: boolean;

  /**
   * One host's PUBLISHED events, for the Events tab on their profile.
   *
   * Without this there was no way to ask for somebody else's events at all.
   * The profile called GET /events/mine, which is the CALLER's events, so a
   * visitor opening a creator's profile saw their OWN events listed under
   * that creator's name. /events/mine cannot serve this: it deliberately
   * returns every status, including pending and rejected submissions, which
   * belong to the host alone.
   *
   * This filters the PUBLIC list, so it inherits `status: published` and the
   * time window with everything else. A visitor sees exactly what the
   * calendar shows.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  host?: string;
}

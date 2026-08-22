import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional } from 'class-validator';
import { EventFormat, EventType } from '../../../generated/prisma/enums';
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
}

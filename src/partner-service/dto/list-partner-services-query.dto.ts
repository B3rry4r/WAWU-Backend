import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { OptionalPaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * GET /services query.
 *
 * `featured=true` is the Marketplace screen's "Featured Services" rail, asked
 * for the same way the Events featured rail is: a filter on the one list
 * endpoint, never a second endpoint and never an extra key hung off the list
 * envelope, because the ResponseInterceptor renders exactly one canonical
 * envelope.
 *
 * Both parameters are optional and absent by default, so a caller that sends
 * neither gets the whole catalogue exactly as before.
 */
export class ListPartnerServicesQueryDto extends OptionalPaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  featured?: boolean;

  /** The category chip row. Free text, matching the column. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}

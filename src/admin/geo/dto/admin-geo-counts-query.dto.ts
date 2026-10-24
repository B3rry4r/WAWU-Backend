import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * GET /admin/geo/counts query. The global ValidationPipe runs with
 * `forbidNonWhitelisted`, so every accepted field is declared here.
 */
export class AdminGeoCountsQueryDto {
  /**
   * Count only this country, ISO 3166-1 alpha-2 ("NG", any case) from
   * GET /geo/countries. An unknown code is a 400. The totals and `unknown`
   * stay those of every account.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  countryCode?: string;
}

import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  LOCATION_MAX_LENGTH,
  OPEN_TO_MAX_COUNT,
  OPEN_TO_MAX_LENGTH,
  SKILLS_MAX_COUNT,
  SKILL_MAX_LENGTH,
  SOCIAL_ORDER_MAX_COUNT,
  SOCIAL_PLATFORMS,
  THREADS_HANDLE_MAX_LENGTH,
} from '../profile-fields';

/**
 * PATCH /users/me/profile-fields (ME-05). Every key is optional and a key left
 * out is left as it is. Their limits are PROVISIONAL and live in
 * ../profile-fields.ts.
 *
 * `@IsOptional()` treats an explicit `null` like `undefined`, so a client
 * clears a text field with "" and a list with [] (null on a list is ignored).
 */
export class UpdateProfileFieldsDto {
  /** Where the person is, free text ("Lagos, Nigeria"). null or "" clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(LOCATION_MAX_LENGTH)
  location?: string | null;

  /**
   * Country of residence, ISO 3166-1 alpha-2 from GET /geo/countries ("NG",
   * any case). null or "" clears it (and the region, which belonged to it).
   * Changing it clears a region that is not sent again.
   */
  @IsOptional()
  @IsString()
  countryCode?: string | null;

  /**
   * Region, the full ISO 3166-2 code from GET /geo/countries/{code}/regions
   * ("NG-LA"; its tail "LA" is accepted too). It must belong to the country
   * saved or sent with it. null or "" clears it.
   */
  @IsOptional()
  @IsString()
  regionCode?: string | null;

  /**
   * The region's name ("Lagos"). Beside a regionCode it must be that code's
   * name; alone it is looked up in the country's list; for a country with
   * no list it is saved as typed. null or "" clears it.
   */
  @IsOptional()
  @IsString()
  regionName?: string | null;

  /**
   * City, free text ("Ikeja"). null or "" clears it. The one limit, 80
   * characters (CITY_MAX_LENGTH in geo.service.ts), is checked there: any longer
   * city is a 400 with `reason.code` `city_too_long`, not a validation message
   * that depends on how long it is. The four place keys carry no length rule of
   * their own for the same reason: GeoService.checkLocation answers them all.
   */
  @IsOptional()
  @IsString()
  city?: string | null;

  /** Skills and expertise chips. [] clears them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SKILLS_MAX_COUNT)
  @IsString({ each: true })
  @MaxLength(SKILL_MAX_LENGTH, { each: true })
  skills?: string[];

  /** What the person is open to, as chips. [] clears them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(OPEN_TO_MAX_COUNT)
  @IsString({ each: true })
  @MaxLength(OPEN_TO_MAX_LENGTH, { each: true })
  openTo?: string[];

  /** Threads handle, with or without the "@". null or "" clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(THREADS_HANDLE_MAX_LENGTH)
  threadsHandle?: string | null;

  /**
   * The order the social links show in, first to last, as platform keys. Each
   * key once. [] puts them back in the default order.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SOCIAL_ORDER_MAX_COUNT)
  @ArrayUnique()
  @IsIn(SOCIAL_PLATFORMS, { each: true })
  socialOrder?: string[];
}

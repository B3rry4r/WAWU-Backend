import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
} from 'class-validator';

/**
 * `POST /admin/featured-creators/order`: every featured creator once, in the
 * order the rail should show them. The Hub numbers them 0, 1, 2 and so on in
 * one save, so two admins never leave two creators on the same place.
 */
export class ReorderFeaturedCreatorsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { each: true })
  order!: string[];
}

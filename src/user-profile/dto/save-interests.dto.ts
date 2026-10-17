import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
} from 'class-validator';
import { EXPLORE_CATEGORY_IDS } from '../../explore/explore-categories';
import {
  MAX_SIGNUP_INTERESTS,
  MIN_SIGNUP_INTERESTS,
} from '../signup-interests';

/**
 * PUT /users/me/interests (AUTH-06). Ids from `GET /users/me/interests` (the
 * same twelve as `GET /explore/categories`), each once, at least the minimum
 * that route names. Anything else is a 400.
 */
export class SaveInterestsDto {
  @IsArray()
  @ArrayMinSize(MIN_SIGNUP_INTERESTS)
  @ArrayMaxSize(MAX_SIGNUP_INTERESTS)
  @ArrayUnique()
  @IsIn(EXPLORE_CATEGORY_IDS, { each: true })
  interests!: string[];
}

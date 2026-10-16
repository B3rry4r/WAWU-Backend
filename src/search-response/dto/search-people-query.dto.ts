import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** The most people one call may ask for: the app asks for one screen of results at a time. */
export const MAX_PEOPLE_PER_CALL = 50;

/** An account id as WAWU ID writes it: letters, digits, `-` and `_`, never long. */
export const PERSON_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Query for GET /search/people. */
export class SearchPeopleQueryDto {
  /**
   * The accounts to describe, as a comma-separated list of ids (1 to 50), in
   * the order the answer should keep.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PEOPLE_PER_CALL * 65)
  @Matches(/^[A-Za-z0-9_,-]+$/, {
    message: 'ids must be account ids separated by commas',
  })
  ids: string;
}

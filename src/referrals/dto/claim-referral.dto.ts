import { IsString, MaxLength, MinLength } from 'class-validator';

/** The body of `POST /me/referrals/claim`. */
export class ClaimReferralDto {
  /**
   * The code to use, or the link it came in (`wawu/r/lennox`). Any case.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  code!: string;
}

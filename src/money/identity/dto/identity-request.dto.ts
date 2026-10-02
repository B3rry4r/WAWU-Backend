import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Request bodies of Open your wallet's identity step (task KYC-01).
 *
 * The BVN and NIN travel in a body, never in a URL or a query (proxy logs,
 * browser history). Validation messages never repeat what was sent.
 */

/** A26: the BVN and the NIN, as the person typed them (digits only). */
export class BvnCheckDto {
  /** The Bank Verification Number: 11 digits, no spaces. */
  @Matches(/^[0-9]{11}$/, { message: 'bvn must be 11 digits' })
  bvn!: string;

  /** The National Identification Number: 11 digits, no spaces. Fintava needs it to open the account. */
  @Matches(/^[0-9]{11}$/, { message: 'nin must be 11 digits' })
  nin!: string;
}

/** A5: the occupation the person typed. */
export class IdentityOccupationDto {
  /** 2 to 80 characters with at least one letter; spaces at either end are dropped. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(80, { message: 'occupation must be 80 characters or fewer' })
  @Matches(/^(?=.*\p{L})[^\p{Cc}<>]{2,80}$/u, {
    message: 'occupation must be 2 to 80 characters and include a letter',
  })
  occupation!: string;
}

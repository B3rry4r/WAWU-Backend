import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, ValidateBy } from 'class-validator';

/**
 * The body of `POST /money/wallet/open` (task MONEY-12): what Fintava's
 * create needs that WAWU does not keep (BACKEND_GAPS G-25 in the mobile
 * repo). The BVN and NIN must be the ones whose check passed (KYC-01, compared
 * as keyed hashes); the name and date of birth are A5's, as the BVN check
 * prefilled them; the address is the one the person typed. None of it is
 * stored: it goes to Fintava once and is dropped. Validation messages never
 * repeat what was sent.
 */

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A real calendar date, `YYYY-MM-DD`, from 1900 up to today. */
export function isBirthDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return false;
  }
  return y >= 1900 && date.getTime() <= Date.now();
}

const NAME = /^\p{L}[\p{L}\p{M}' .-]{0,49}$/u;

export class OpenNairaWalletDto {
  /** The BVN whose check passed: 11 digits, no spaces. */
  @Matches(/^[0-9]{11}$/, { message: 'bvn must be 11 digits' })
  bvn!: string;

  /** The NIN given with that check: 11 digits, no spaces. */
  @Matches(/^[0-9]{11}$/, { message: 'nin must be 11 digits' })
  nin!: string;

  /** A5's first name, as the BVN check prefilled it. */
  @Transform(trim)
  @IsString()
  @Matches(NAME, {
    message:
      'firstName must be 1 to 50 letters, spaces, dots, dashes or apostrophes',
  })
  firstName!: string;

  /** A5's last name, as the BVN check prefilled it. */
  @Transform(trim)
  @IsString()
  @Matches(NAME, {
    message:
      'lastName must be 1 to 50 letters, spaces, dots, dashes or apostrophes',
  })
  lastName!: string;

  /** A5's date of birth, `YYYY-MM-DD`. */
  @ValidateBy({
    name: 'isBirthDate',
    validator: {
      validate: isBirthDate,
      defaultMessage: () => 'dateOfBirth must be a real date, YYYY-MM-DD',
    },
  })
  dateOfBirth!: string;

  /**
   * The full home address in one line (street, town, state), 5 to 200
   * characters with a letter in it. Fintava takes it as one field.
   */
  @Transform(trim)
  @IsString()
  @MaxLength(200, { message: 'address must be 200 characters or fewer' })
  @Matches(/^(?=.*\p{L})[^\p{Cc}<>]{5,200}$/u, {
    message: 'address must be 5 to 200 characters and include a letter',
  })
  address!: string;
}

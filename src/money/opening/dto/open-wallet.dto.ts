import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { CHECK_HANDLE_MAX_LENGTH } from '../../identity/check-handle';
import { CHECK_HANDLE_INVALID_MESSAGE } from '../../identity/dto/identity-request.dto';

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

const sendsNumbers = (o: OpenNairaWalletDto) =>
  o.checkHandle === undefined || o.bvn !== undefined || o.nin !== undefined;

export class OpenNairaWalletDto {
  /**
   * The BVN whose check passed: 11 digits, no spaces. Leave it and `nin` out
   * and send `checkHandle` instead (KYC-03); never both.
   */
  @ApiPropertyOptional({ pattern: '^[0-9]{11}$' })
  @ValidateIf(sendsNumbers)
  @Matches(/^[0-9]{11}$/, { message: 'bvn must be 11 digits' })
  bvn?: string;

  /** The NIN given with that check: 11 digits, no spaces. Left out with `checkHandle`. */
  @ApiPropertyOptional({ pattern: '^[0-9]{11}$' })
  @ValidateIf(sendsNumbers)
  @Matches(/^[0-9]{11}$/, { message: 'nin must be 11 digits' })
  nin?: string;

  /**
   * The `checkHandle` the passed BVN check answered, in place of `bvn` and
   * `nin` (KYC-03): the server takes both from it. Never with them.
   */
  @ApiPropertyOptional({ maxLength: CHECK_HANDLE_MAX_LENGTH })
  @ValidateIf((o: OpenNairaWalletDto) => o.checkHandle !== undefined)
  @IsString({ message: CHECK_HANDLE_INVALID_MESSAGE })
  @MaxLength(CHECK_HANDLE_MAX_LENGTH, { message: CHECK_HANDLE_INVALID_MESSAGE })
  @ValidateBy({
    name: 'checkHandleAlone',
    validator: {
      validate: (_: unknown, args) => {
        const o = args?.object as OpenNairaWalletDto;
        return o.bvn === undefined && o.nin === undefined;
      },
      defaultMessage: () => 'Send checkHandle, or bvn and nin, not both.',
    },
  })
  checkHandle?: string;

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

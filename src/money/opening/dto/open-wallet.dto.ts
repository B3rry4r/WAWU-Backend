import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
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

/** A town, a state or an address line: 1 to 100 characters with a letter in it. */
const PLACE = /^(?=.*\p{L})[^\p{Cc}<>]{1,100}$/u;

/** NUV-02: what a reviewing provider takes (Nuvion's `gender` is m or f). */
export const GENDERS = ['male', 'female'] as const;
/** NUV-02: Nuvion's `identification.document.type`. */
export const ID_TYPES = [
  'international_passport',
  'drivers_license',
  'national_id',
] as const;
/** NUV-02: Nuvion's `identification.proof_of_address.type`. */
export const PROOF_OF_ADDRESS_TYPES = ['utility_bill', 'bank_statement'] as const;

/** A real calendar date, `YYYY-MM-DD`, today or later, before 2100. */
export function isUnexpiredDate(value: unknown): boolean {
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
  const today = new Date();
  const startOfToday = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return y < 2100 && date.getTime() >= startOfToday;
}

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

  // -------------------------------------------------------------------------
  // NUV-02, additive: what a provider that reviews the person itself
  // (Nuvion) needs. Each is checked when sent; under such a provider the
  // opening asks for the ones it needs (a plain 400 naming the first one
  // missing), and `address` is then the street line. A server on Fintava
  // takes none of them and sends none on. None is stored or logged.
  // -------------------------------------------------------------------------

  /** A middle name, when the person has one. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(NAME, {
    message:
      'middleName must be 1 to 50 letters, spaces, dots, dashes or apostrophes',
  })
  middleName?: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsIn(GENDERS, { message: 'gender must be male or female' })
  gender?: (typeof GENDERS)[number];

  /** A second address line (flat, estate), when there is one. */
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(PLACE, {
    message: 'addressLine2 must be 1 to 100 characters and include a letter',
  })
  addressLine2?: string;

  /** The town or city. */
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(PLACE, {
    message: 'city must be 1 to 100 characters and include a letter',
  })
  city?: string;

  /** The state (Lagos, FCT ...). */
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(PLACE, {
    message: 'state must be 1 to 100 characters and include a letter',
  })
  state?: string;

  /** The postal code, 1 to 20 letters, digits, spaces or dashes. */
  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/, {
    message: 'postalCode must be 1 to 20 letters, digits, spaces or dashes',
  })
  postalCode?: string;

  /** The ID document the person will upload (NUV-03). */
  @ApiPropertyOptional({ enum: ID_TYPES })
  @IsOptional()
  @IsIn(ID_TYPES, {
    message: 'idType must be international_passport, drivers_license or national_id',
  })
  idType?: (typeof ID_TYPES)[number];

  /** Its number, as printed: 5 to 30 letters, digits or dashes. Never stored. */
  @ApiPropertyOptional({ minLength: 5, maxLength: 30 })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{4,29}$/, {
    message: 'idNumber must be 5 to 30 letters, digits or dashes',
  })
  idNumber?: string;

  /** When it was issued, `YYYY-MM-DD`, when it says. */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateBy({
    name: 'isPastDate',
    validator: {
      validate: isBirthDate,
      defaultMessage: () => 'idIssueDate must be a real date, YYYY-MM-DD',
    },
  })
  idIssueDate?: string;

  /** When it expires, `YYYY-MM-DD`, when it says; not already passed. */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateBy({
    name: 'isExpiryDate',
    validator: {
      validate: isUnexpiredDate,
      defaultMessage: () =>
        'idExpiryDate must be a real date, YYYY-MM-DD, that has not passed',
    },
  })
  idExpiryDate?: string;

  /** The proof of address the person will upload (NUV-03). */
  @ApiPropertyOptional({ enum: PROOF_OF_ADDRESS_TYPES })
  @IsOptional()
  @IsIn(PROOF_OF_ADDRESS_TYPES, {
    message: 'proofOfAddressType must be utility_bill or bank_statement',
  })
  proofOfAddressType?: (typeof PROOF_OF_ADDRESS_TYPES)[number];
}

/**
 * The fields a reviewing provider needs (NUV-02), in the order a missing
 * one is named.
 */
export const REVIEW_REQUIRED_FIELDS = [
  'gender',
  'city',
  'state',
  'postalCode',
  'idType',
  'idNumber',
  'proofOfAddressType',
] as const;

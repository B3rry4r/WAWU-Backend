import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { CHECK_HANDLE_MAX_LENGTH } from '../check-handle';
import { isJpeg, isPng } from '../selfie-image';

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

/** The one sentence a malformed check handle gets: it never says what was sent, or what was wrong with it. */
export const CHECK_HANDLE_INVALID_MESSAGE =
  'Your BVN check could not be read. Check your BVN again to continue.';

/** The longest selfie accepted, in base64 characters (about 75 KB of image). */
export const SELFIE_IMAGE_MAX_CHARS = 100_000;
/** The smallest selfie accepted, in bytes once decoded: anything smaller is not a photo. */
export const SELFIE_IMAGE_MIN_BYTES = 1_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True when `value` is plain base64 (no `data:` prefix, no spaces) of a
 * JPEG or PNG of at least SELFIE_IMAGE_MIN_BYTES. Checked before Fintava is
 * asked, because every selfie match is charged, a broken one too.
 *
 * The file is walked from its first byte to its last (`selfie-image.ts`):
 * a PNG chunk by chunk (lengths, CRCs, IHDR first, the pixel data, IEND
 * last), a JPEG marker by marker through its scans to the EOI that ends it.
 * A file that only starts or ends like an image (JPEG or PNG framing around
 * HTML, a ZIP or random bytes, or an image with anything appended) is
 * refused. Nothing may follow the end, so the app sends the photo as its
 * encoder wrote it (a re-encoded capture, not a file with a trailer).
 */
export function isSelfieImage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > SELFIE_IMAGE_MAX_CHARS || value.length % 4 !== 0) {
    return false;
  }
  if (!BASE64.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < SELFIE_IMAGE_MIN_BYTES) return false;
  return isJpeg(bytes) || isPng(bytes);
}

/**
 * The selfie step (task KYC-02, A6). The BVN is the one whose check passed
 * (KYC-01); it is compared with the stored keyed hash, never stored. The
 * image is matched once and dropped: it is never stored or logged, and no
 * validation message repeats it.
 */
export class SelfieMatchDto {
  /**
   * The BVN whose check passed: 11 digits, no spaces. Leave it out and send
   * `checkHandle` instead (KYC-03); one of the two, never both.
   */
  @ApiPropertyOptional({ pattern: '^[0-9]{11}$' })
  @ValidateIf(
    (o: SelfieMatchDto) => o.checkHandle === undefined || o.bvn !== undefined,
  )
  @Matches(/^[0-9]{11}$/, { message: 'bvn must be 11 digits' })
  bvn?: string;

  /**
   * The `checkHandle` the passed BVN check answered, in place of `bvn`
   * (KYC-03): the server takes the BVN from it. One of the two, never both.
   */
  @ApiPropertyOptional({ maxLength: CHECK_HANDLE_MAX_LENGTH })
  @ValidateIf((o: SelfieMatchDto) => o.checkHandle !== undefined)
  @IsString({ message: CHECK_HANDLE_INVALID_MESSAGE })
  @MaxLength(CHECK_HANDLE_MAX_LENGTH, { message: CHECK_HANDLE_INVALID_MESSAGE })
  @ValidateBy({
    name: 'checkHandleAlone',
    validator: {
      validate: (_: unknown, args) =>
        (args?.object as SelfieMatchDto).bvn === undefined,
      defaultMessage: () => 'Send checkHandle or bvn, not both.',
    },
  })
  checkHandle?: string;

  /**
   * The selfie: plain base64 (no `data:` prefix) of a JPEG or PNG, 1 KB to
   * about 75 KB (at most 100,000 base64 characters), at most 2,048 pixels
   * on each side. A face match against the BVN photo, not a liveness check.
   */
  @ApiProperty({
    type: 'string',
    format: 'byte',
    maxLength: SELFIE_IMAGE_MAX_CHARS,
  })
  @IsString({ message: 'image must be a base64 JPEG or PNG' })
  @ValidateBy(
    {
      name: 'isSelfieImage',
      validator: { validate: (value: unknown) => isSelfieImage(value) },
    },
    {
      message:
        'image must be a base64 JPEG or PNG of 1 KB to 75 KB and at most 2048 pixels a side, without a data: prefix',
    },
  )
  image!: string;
}

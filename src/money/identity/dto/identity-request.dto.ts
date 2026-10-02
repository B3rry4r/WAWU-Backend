import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, ValidateBy } from 'class-validator';

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

/** The longest selfie accepted, in base64 characters (about 75 KB of image). */
export const SELFIE_IMAGE_MAX_CHARS = 100_000;
/** The smallest selfie accepted, in bytes once decoded: anything smaller is not a photo. */
export const SELFIE_IMAGE_MIN_BYTES = 1_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** A PNG's first chunk: length 13, then `IHDR` (bytes 8 to 15). */
const PNG_IHDR = Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
/** A PNG's last chunk, whole: length 0, `IEND`, and its fixed CRC. */
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/**
 * True when `value` is plain base64 (no `data:` prefix, no spaces) of a
 * JPEG or PNG of at least SELFIE_IMAGE_MIN_BYTES. Checked before Fintava is
 * asked, because every selfie match is charged, a broken one too.
 *
 * Both ends of the file are checked, so a file that only starts like an
 * image (JPEG or PNG magic followed by HTML, a ZIP or random bytes, or an
 * image with a ZIP appended) is refused: a JPEG starts `FF D8 FF` and ends
 * with the end-of-image marker `FF D9`; a PNG starts with its signature and
 * the `IHDR` chunk and ends with the `IEND` chunk. Nothing may follow the
 * end, so the app sends the photo as the camera's encoder wrote it (a
 * re-encoded capture, not a file with a trailer appended).
 */
export function isSelfieImage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > SELFIE_IMAGE_MAX_CHARS || value.length % 4 !== 0) {
    return false;
  }
  if (!BASE64.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < SELFIE_IMAGE_MIN_BYTES) return false;
  const jpeg =
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
  const png =
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.subarray(8, 16).equals(PNG_IHDR) &&
    bytes.subarray(bytes.length - PNG_IEND.length).equals(PNG_IEND);
  return jpeg || png;
}

/**
 * The selfie step (task KYC-02, A6). The BVN is the one whose check passed
 * (KYC-01); it is compared with the stored keyed hash, never stored. The
 * image is matched once and dropped: it is never stored or logged, and no
 * validation message repeats it.
 */
export class SelfieMatchDto {
  /** The BVN whose check passed: 11 digits, no spaces. */
  @Matches(/^[0-9]{11}$/, { message: 'bvn must be 11 digits' })
  bvn!: string;

  /**
   * The selfie: plain base64 (no `data:` prefix) of a JPEG or PNG, 1 KB to
   * about 75 KB (at most 100,000 base64 characters). A face match against
   * the BVN photo, not a liveness check.
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
        'image must be a base64 JPEG or PNG of 1 KB to 75 KB, without a data: prefix',
    },
  )
  image!: string;
}

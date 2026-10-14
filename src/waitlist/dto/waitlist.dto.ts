import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { WaitlistStatus } from '../../../generated/prisma/enums';
import {
  NAME_MAX,
  NAME_MIN,
  SHORT_TEXT_MAX,
  WAITLIST_CITIES,
  WAITLIST_CRAFTS,
} from '../waitlist-config';

/** POST /waitlist/registrations. */
export class CreateWaitlistRegistrationDto {
  /** The offer the page showed (`GET /waitlist/offers/current`). */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  offerId!: string;

  /** Full name, as the person writes it. */
  @IsString()
  @MinLength(NAME_MIN)
  @MaxLength(NAME_MAX)
  fullName!: string;

  /**
   * Phone. A Nigerian mobile in any common form (`08031234567`,
   * `8031234567`, `2348031234567`, `+2348031234567`), or a number from
   * elsewhere written with its country code. The server stores E.164.
   */
  @IsString()
  @MaxLength(30)
  phone!: string;

  /** Email. The server stores it in lower case. */
  @IsString()
  @MaxLength(254)
  email!: string;

  /** The state they are in (optional, up to 60 characters). */
  @IsOptional()
  @IsString()
  @MaxLength(SHORT_TEXT_MAX)
  state?: string;

  /** What they make (optional, up to 60 characters). */
  @IsOptional()
  @IsString()
  @MaxLength(SHORT_TEXT_MAX)
  makes?: string;

  /**
   * What they make or do (optional): one of `WAITLIST_CRAFTS`, written as in
   * the list (Music, Fashion, Film and video, Photography, Art, Design, Food,
   * Digital art, Tech and software, Writing and media, Professional services,
   * Founder or business, Other).
   */
  @IsOptional()
  @IsIn(WAITLIST_CRAFTS, {
    message: 'Choose what you make or do from the list.',
  })
  craft?: (typeof WAITLIST_CRAFTS)[number];

  /**
   * The conference city they will attend (optional): Lagos, Abuja, Port
   * Harcourt, Enugu or Online.
   */
  @IsOptional()
  @IsIn(WAITLIST_CITIES, { message: 'Choose a city from the list.' })
  city?: (typeof WAITLIST_CITIES)[number];

  /**
   * They asked for launch and conference updates on WhatsApp and email
   * (optional). Sending nothing means the question was not asked.
   */
  @IsOptional()
  @IsBoolean()
  updatesOptIn?: boolean;

  /** The consent line (with the privacy link) was accepted. Must be true. */
  @IsBoolean()
  consent!: boolean;

  /**
   * A referral code (optional): 3 to 20 letters and numbers, in any case.
   * Leave it out, or empty, to pay the standard price. A code we do not have
   * is refused (`referral_unknown`); one that is switched off or full is not
   * refused: the person registers at the standard price and the answer's
   * `referral` says the code was not applied.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referralCode?: string;
}

/** POST /waitlist/registrations/verify. */
export class VerifyWaitlistRegistrationDto {
  /** The reference POST /waitlist/registrations gave. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;

  /** The transaction id the payment modal handed back (digits). */
  @IsString()
  @Matches(/^[0-9]{1,20}$/, {
    message: 'transactionId must be the transaction number the payment gave',
  })
  transactionId!: string;
}

/**
 * What a body with no code, an empty code, a code that is not text or a code
 * far too long is told (JOIN-03 round 2, N5). The app never sends one; a
 * person reading it should not meet the validator's "must be shorter than or
 * equal to 40 characters". The first message is the one the error shape
 * carries, and the validator checks the length rules first, so every rule
 * gives the same words for the same fault.
 */
const ENTER_CODE = 'Enter your access code.';
const CODE_TOO_LONG = 'Type the 8 letters and numbers of your access code.';
const codeWords = ({ value }: { value?: unknown }): string =>
  typeof value === 'string' && value.length > 0 ? CODE_TOO_LONG : ENTER_CODE;

/** POST /waitlist/claims (JOIN-03). */
export class ClaimWaitlistRegistrationDto {
  /**
   * The launch access code from the registration page: 8 letters and numbers
   * (0 to 9, A to F), written "XXXX XXXX". Spaces, dashes and lower case are
   * accepted; the server reads it without them.
   */
  @IsString({ message: codeWords })
  @MinLength(1, { message: codeWords })
  @MaxLength(40, { message: codeWords })
  code!: string;
}

/** GET /admin/waitlist/registrations. */
export class AdminWaitlistListQueryDto extends PaginationQueryDto {
  /** Only this offer. Omitted means every offer. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  offerId?: string;

  /** Only this status. Omitted means every status. */
  @IsOptional()
  @IsEnum(WaitlistStatus)
  status?: WaitlistStatus;

  /** Only registrations counted under this referral code (any case). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referralCode?: string;

  /** `true`: only registrations with no referral code (including every one made before codes existed). Not with `referralCode`. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  noReferral?: boolean;
}

/** GET /admin/waitlist/registrations/export. */
export class AdminWaitlistExportQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  offerId?: string;

  @IsOptional()
  @IsEnum(WaitlistStatus)
  status?: WaitlistStatus;

  /** Only registrations counted under this referral code (any case). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referralCode?: string;

  /** `true`: only registrations with no referral code. Not with `referralCode`. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  noReferral?: boolean;
}

/** GET /admin/waitlist/registrations/summary. */
export class AdminWaitlistSummaryQueryDto {
  /** Only this offer. Omitted means every offer. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  offerId?: string;
}

import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { WaitlistStatus } from '../../../generated/prisma/enums';
import { NAME_MAX, NAME_MIN, SHORT_TEXT_MAX } from '../waitlist-config';

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

  /** The consent line (with the privacy link) was accepted. Must be true. */
  @IsBoolean()
  consent!: boolean;
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
}

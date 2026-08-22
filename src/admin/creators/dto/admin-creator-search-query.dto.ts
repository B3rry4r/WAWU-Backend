import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { AccountType, CreatorTier, ReviewStatus } from '../../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * ── WHAT THIS BACKEND CAN AND CANNOT LOOK A CREATOR UP BY ────────────────
 *
 * It can: `UserProfile.handle` and `UserProfile.wawuUserId`.
 *
 * It cannot: email or phone. Not "not yet" — there is no column. Every
 * identity-bearing table in `prisma/schema.prisma` was checked: `UserProfile`
 * holds a handle, a bio, interests and social handles; `CreatorState`,
 * `CreatorSubscription`, `KycSubmission` and `VerificationSubmission` key on
 * `wawuUserId` and hold no contact field. The only `email` and `phoneNumber`
 * columns in the whole schema belong to `HealthSubscription` (a WellaHealth
 * enrollee's own details, required because WellaHealth keys on phone),
 * `BillPayment.customerRef` (a meter or smartcard number, not the payer), and
 * `AdminUser.email` — none of which is the creator's account identity.
 *
 * Email and phone live in WAWU ID, on the token claim
 * (`src/common/auth/wawu-jwt-claims.interface.ts`), and this backend never
 * persists them — every resource keys on `sub` only, by design. Nor can they
 * be proxied: WAWU ID's internal service API exposes tier elevation, trust
 * score, phone change and deletion, all addressed BY user id. There is no
 * lookup-by-contact endpoint to call, so a Hub-side email search would have
 * nothing to ask.
 *
 * The honest consequence is this constraint. An operator who pastes an email
 * or a phone number gets a 400 that says why, rather than a 200 with an empty
 * list — because "no results" is a lie that reads as "this person does not
 * exist", and the difference matters when the person on the other end of the
 * ticket definitely does.
 */
@ValidatorConstraint({ name: 'creatorSearchIsSupported', async: false })
export class CreatorSearchIsSupportedConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value !== 'string' || unsupportedLookupKind(value) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const kind = unsupportedLookupKind(String(args.value));
    const what = kind === 'email' ? 'an email address' : 'a phone number';
    return `Creator lookup cannot search by ${what}. This backend stores no email or phone for a creator account — both live in WAWU ID, which exposes no lookup-by-contact API. Search by handle (partial, case-insensitive) or by WAWU ID instead.`;
  }
}

/** UUID in any version — `wawuUserId` values in this data are not all v4. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Anything with an `@` in it is being typed as an email, whether or not it parses as one. */
const EMAIL_SHAPE = /@/;

/** Digits with the separators people actually type, optionally `+`-prefixed. */
const PHONE_SHAPE = /^\+?[\d\s()-]{7,20}$/;

/**
 * Which unsupported identity the operator is trying to search by, or null when
 * the query is something this backend can actually match.
 *
 * Exported because the service documents the same limitation and the two must
 * not drift.
 */
export function unsupportedLookupKind(raw: string): 'email' | 'phone' | null {
  const q = raw.trim();
  if (q.length === 0) return null;

  // Checked first: a wawuUserId is a supported lookup and must never be
  // mistaken for a phone number. `00000000-0000-4000-8000-000000000001` is a
  // real id shape in this data and is all digits once the dashes are stripped.
  if (UUID_SHAPE.test(q)) return null;

  if (EMAIL_SHAPE.test(q)) return 'email';

  // 7–20 characters of digits and separators. Bounded at the top so a bare
  // 32-hex-digit id fragment is not read as a phone number, and at the bottom
  // so a short numeric handle is not either.
  const digits = q.replace(/\D/g, '');
  if (PHONE_SHAPE.test(q) && digits.length >= 7) return 'phone';

  return null;
}

/**
 * GET /admin/creators query.
 *
 * Offset pagination, inherited from the app's own PaginationQueryDto rather
 * than a second admin convention (conventions.md § Pagination). The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so every accepted field has
 * to be declared here or the request is a 400.
 */
export class AdminCreatorSearchQueryDto extends PaginationQueryDto {
  /**
   * Matched against `handle` (partial, case-insensitive) and `wawuUserId`
   * (prefix, case-insensitive). See the constraint above for what it
   * deliberately refuses.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Validate(CreatorSearchIsSupportedConstraint)
  q?: string;

  /**
   * Present, but NOT defaulted to `creator`, and that is deliberate.
   *
   * The support ticket this endpoint exists for is frequently "I paid and I am
   * still not a creator" — an account whose payment landed but whose
   * `accountType` never flipped. Defaulting the filter to `creator` would hide
   * exactly the accounts an operator is looking for and report them as
   * nonexistent. So the search spans every profile and returns `accountType`
   * as a field, and the operator narrows it only when they mean to.
   */
  @IsOptional()
  @IsIn(Object.values(AccountType))
  accountType?: AccountType;

  @IsOptional()
  @IsIn(Object.values(CreatorTier))
  tier?: CreatorTier;

  /** The upload gate, as a filter: "who paid?" / "who has not?" */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  subscriptionPaid?: boolean;

  /**
   * The earning gate, as a filter. `not_started` is accepted alongside the
   * three stored values because it is a real, distinguishable state the app
   * already shows the creator (hazard H-5) — a filter that could not express
   * it would put "never submitted" and "waiting on us" in one bucket, which is
   * the difference between chasing the creator and chasing a reviewer.
   */
  @IsOptional()
  @IsIn([...Object.values(ReviewStatus), 'not_started'])
  kycStatus?: ReviewStatus | 'not_started';

  @IsOptional()
  @IsIn(['newest', 'oldest', 'handle'])
  sort: 'newest' | 'oldest' | 'handle' = 'newest';
}

import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Operator actions on a ServiceApplication.
 *
 * Applications used to stop dead at `submitted`/`under_review`: nothing
 * appended to `timeline`, nothing set `rejection`, nothing set
 * `certificateExpectedBy`, so the app's tracking screen could only ever show
 * the one entry written at intake and could never show a date or a refusal.
 * These are the three writes that were missing.
 *
 * They are ops actions, not user actions, so they sit behind AdminAuthGuard +
 * AdminRolesGuard (`superadmin`, `support` — see
 * ../service-application-ops.controller.ts for the matrix and its reasoning).
 * They used to sit behind AdminKeyGuard, a single shared static secret with no
 * identity and no role model; every write is now attributable to a named
 * admin through AdminOpsAudit.
 */
export class ProgressApplicationDto {
  /** The timeline entry's heading, e.g. "Under review", "Names checked". */
  @IsString() @IsNotEmpty() @MaxLength(120) label!: string;

  @IsOptional() @IsString() @MaxLength(1000) note?: string;

  /**
   * Free-form because the column is a plain String and the shipped client
   * maps four known values (`under_review`, `approved`, `rejected`,
   * `pending`) with a fallback — constraining it to an enum here would break
   * intake's own `awaiting_payment` and `submitted`.
   */
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(80) statusLabel?: string;

  /** Date only (YYYY-MM-DD) — the column is `@db.Date`. */
  @IsOptional() @IsISO8601() certificateExpectedBy?: string;
}

export class RejectApplicationDto {
  /**
   * Why it was refused. Shown to the applicant verbatim, so it is required
   * and has to say something: a rejection with no reason is the dead end
   * this endpoint exists to end.
   */
  @IsString()
  @MinLength(10, { message: 'Tell the applicant why this was refused.' })
  @MaxLength(1000)
  reason!: string;

  @IsOptional() @IsString() @MaxLength(80) statusLabel?: string;
}

export class ApproveApplicationDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsString() @MaxLength(80) statusLabel?: string;

  /**
   * The issued certificate, uploaded via POST /uploads/presign. Appended to
   * the existing `documents` array rather than given a column of its own:
   * ServiceApplication is one of the bare Prisma re-exports returned by
   * spread, so a new column would silently widen a live app response.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(600)
  certificateUrl?: string;
}

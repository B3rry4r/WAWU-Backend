import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { VERIFICATION_KINDS } from '../../common/verification/verification-state';

/**
 * Body for the admin tick routes.
 *
 * `until` is optional on a grant, and omitting it means PERPETUAL, which is
 * what the accounts grandfathered off the old ladder hold. It is ignored on a
 * revoke, where both dates are cleared: "verified until" is the whole of the
 * state, so clearing it is the whole of the revocation.
 */
export class AdminTickDto {
  @IsIn(VERIFICATION_KINDS as unknown as string[])
  kind!: 'creator' | 'professional';

  /** ISO 8601. Omit for a tick that does not expire. */
  @IsOptional()
  @IsISO8601()
  until?: string;
}

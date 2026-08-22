import { IsUUID } from 'class-validator';

/**
 * Body for POST /settings/privacy/blocked.
 *
 * `blockedWawuId` is the WAWU ID `sub` of the account being blocked (a v4
 * UUID), never a handle — the same convention as
 * FollowRelationshipController's `:wawuId` param.
 */
export class CreateBlockedAccountDto {
  @IsUUID('4')
  blockedWawuId: string;
}

import { IsIn } from 'class-validator';

/**
 * PUT /users/me/account-type (AUTH-06). The two types a person can be, as the
 * sign-up sequence and "Become a creator" name them. Exact: anything else is a 400.
 */
export class SetAccountTypeDto {
  @IsIn(['user', 'creator'])
  accountType!: 'user' | 'creator';
}

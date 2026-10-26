import { IsIn } from 'class-validator';

/**
 * Where the person agreed. Only `signup` today: the box at sign-up (A3) that
 * says "I agree to WAWU's Terms of Service, Privacy Policy and our other
 * policies". The Hub decides which documents and which dates are recorded (the
 * ones it has published now); the caller names no slug and no date.
 */
export class AcceptPoliciesDto {
  @IsIn(['signup'])
  how!: 'signup';
}

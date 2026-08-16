import { IsIn, IsOptional, IsString } from 'class-validator';

/** POST /verification/submissions/:id/review body per registry.json (roles: ["admin"]). */
export class ReviewVerificationSubmissionDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

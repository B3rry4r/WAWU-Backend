import { IsIn, IsOptional, IsString } from 'class-validator';

/** POST /kyc/:id/review body per registry.json (roles: ["admin"]). */
export class ReviewKycSubmissionDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

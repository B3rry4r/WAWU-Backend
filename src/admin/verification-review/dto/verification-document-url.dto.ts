import { IsInt, Min } from 'class-validator';

/**
 * POST /admin/verification/:id/document-url body.
 *
 * `VerificationSubmission.documents` is a String[], so unlike a KYC ID there
 * is no single document to mean — the caller says which one, and the audit row
 * records which one they opened. The upper bound is the row's own array
 * length, checked in the service rather than here because the DTO cannot see
 * the row.
 */
export class VerificationDocumentUrlDto {
  @IsInt()
  @Min(0)
  documentIndex!: number;
}

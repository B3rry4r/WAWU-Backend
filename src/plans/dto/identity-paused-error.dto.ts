import { ApiProperty } from '@nestjs/swagger';

/**
 * Why a publish or upload was refused while the person's identity check is
 * paused (S7 round 2, F3). Identity is checked when a wallet is opened (R-6);
 * a check waiting for documents, refused, stopped or closed unfinished pauses
 * publishing until it passes. One code, and the Hub's own sentence.
 */
export class IdentityPausedReasonDto {
  @ApiProperty({ enum: ['identity_paused'] })
  code!: 'identity_paused';

  /** The Hub's sentence: what is paused, why, and what to do. The app shows it as it is. No em-dash. */
  message!: string;

  /**
   * Where the check stands: `needs_documents` (the documents the bank asked
   * for are still needed), `rejected`, `stopped` (for good) or `expired`
   * (left unfinished too long). The same words as `review.stage` on
   * `GET /money/wallet`.
   */
  @ApiProperty({
    enum: ['needs_documents', 'rejected', 'stopped', 'expired'],
  })
  stage!: 'needs_documents' | 'rejected' | 'stopped' | 'expired';
}

/** The body of a 403 from a route that publishes or accepts a file. */
export class IdentityPausedErrorEnvelope {
  /** 403. */
  @ApiProperty({ type: 'integer', example: 403 })
  statusCode!: number;

  /** Same as reason.message. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;

  @ApiProperty({ type: () => IdentityPausedReasonDto })
  reason!: IdentityPausedReasonDto;
}

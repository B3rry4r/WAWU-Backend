import {
  IsArray,
  IsISO8601,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateLegalRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(60) serviceCode!: string;

  /** Whatever the service's intake form collected. */
  @IsOptional() @IsObject() details?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  documents?: string[];
}

export class BookConsultationDto {
  @IsIn(['chat', 'zoom', 'physical'])
  medium!: 'chat' | 'zoom' | 'physical';

  /**
   * The slot the client picked, from GET /legal/availability. Required for
   * chat and Zoom; physical consultations are arranged directly and book no
   * slot, so it is optional here and rejected in the service for physical.
   */
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}

export class VerifyPaymentDto {
  @IsString() @IsNotEmpty() @MaxLength(120) transactionId!: string;
}

export class SignContractDto {
  /**
   * The signer types their own full name. This is the signature: it is stored
   * with the exact contract text and a timestamp.
   */
  @IsString() @IsNotEmpty() @MaxLength(120) fullName!: string;
}

/** Admin/ops: what WAWU quotes after the consultation. */
export class QuoteLegalRequestDto {
  @IsInt() @Min(1) amountNaira!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

/**
 * Admin/ops: the consultation happened.
 *
 * `consultation_scheduled` was terminal — reached only after the client had
 * paid ₦25,000 (chat) or ₦45,000 (Zoom), and with no way out of it. This is
 * the transition that ends it.
 */
export class CompleteConsultationDto {
  /** What was discussed. Kept so the quote that follows has a basis. */
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

/** Admin/ops: the paid-for work is finished and the document is ready. */
export class DeliverLegalRequestDto {
  /** Object-storage URL from POST /uploads/presign. */
  @IsUrl({}, { message: 'deliverableUrl must be a full link' })
  @MaxLength(600)
  deliverableUrl!: string;
}

/**
 * Admin/ops: close a matter WAWU will not be completing.
 *
 * The reason is required and shown to the client. It says nothing about
 * money: if a consultation or service fee was already taken, refunding it is
 * a real transfer that nothing in this codebase performs, so the reason is
 * where an operator says what is actually happening about it.
 */
export class CancelLegalRequestDto {
  @IsString()
  @MinLength(10, { message: 'Tell the client why this is being cancelled.' })
  @MaxLength(1000)
  reason!: string;
}

/** Admin/ops: the queue of requests waiting on WAWU. */
export class ListLegalRequestsQueryDto {
  @IsOptional()
  @IsIn([
    'draft',
    'awaiting_quote',
    'awaiting_consultation_payment',
    'consultation_scheduled',
    'consultation_done',
    'quoted',
    'contract_signed',
    'awaiting_service_payment',
    'in_progress',
    'delivered',
    'cancelled',
  ])
  status?: string;
}

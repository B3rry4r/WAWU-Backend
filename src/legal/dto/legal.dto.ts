import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
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

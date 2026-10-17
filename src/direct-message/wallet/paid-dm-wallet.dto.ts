import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_QUESTION_LENGTH } from './paid-dm-wallet-rules';

/** POST /dm/{creatorWawuId}/send/wallet. Header: Idempotency-Key (optional). */
export class AskPaidQuestionDto {
  /** The question, 2,000 characters at most. */
  @ApiProperty({ maxLength: MAX_QUESTION_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_QUESTION_LENGTH)
  text!: string;
}

/** POST /dm/send/wallet/pay. Headers: Idempotency-Key, X-Transaction-Pin. */
export class PayPaidQuestionDto {
  /** `question.id` from the quote: the question being paid for. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  questionId!: string;

  /** `payment.totalKobo` from the quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedTotalKobo!: number;

  /** `payment.quoteToken` from that quote. */
  @ApiProperty()
  @IsString()
  @Length(1, 1024)
  quoteToken!: string;
}

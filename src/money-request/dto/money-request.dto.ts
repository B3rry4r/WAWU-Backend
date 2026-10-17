import { ApiProperty } from '@nestjs/swagger';
import {
  registerDecorator,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { isCleanText } from '../../admin/legal-documents/policy-input';

/**
 * Text the database can store: no NUL and no lone surrogate (the wallet
 * DTOs' rule, read by `isCleanText`). A blank value passes when allowed and
 * is stored as none.
 */
function IsStorableText(blankAllowed = false) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isStorableText',
      target: object.constructor,
      propertyName,
      options: {
        message: '$property must have no null characters or broken characters',
      },
      validator: {
        validate: (v: unknown) =>
          typeof v === 'string' &&
          ((blankAllowed && v.trim() === '') || isCleanText(v)),
      },
    });
}

/** The longest reason a request carries: the wallet send's note, which it becomes. */
export const MONEY_REQUEST_MEMO_MAX = 100;

/** POST /chats/:chatId/money-requests (I16). */
export class CreateMoneyRequestDto {
  /** What is asked for, in kobo. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  /** What it is for ("Logo edits, round 2"). */
  @IsOptional()
  @IsString()
  @MaxLength(MONEY_REQUEST_MEMO_MAX)
  @IsStorableText(true)
  memo?: string;

  /**
   * The sender app's own id for this request, so a resend after a lost
   * answer returns the first request instead of asking twice.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/)
  clientRequestId?: string;
}

/**
 * POST /chats/:chatId/money-requests/:requestId/pay (I18). Headers:
 * Idempotency-Key, X-Transaction-Pin. The same two fields a send to a WAWU
 * user carries; who gets the money and how much come from the request.
 */
export class PayMoneyRequestDto {
  /** `totalKobo` from the fee quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  expectedTotalKobo!: number;

  /** `quoteToken` from that fee quote (`GET /money/fees/quote?kind=wawu_transfer`). */
  @IsString()
  @Length(1, 1024)
  @IsStorableText()
  quoteToken!: string;
}

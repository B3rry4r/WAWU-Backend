import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { MONEY_ERROR_CODES, type MoneyErrorCode } from './money-enums';
import type {
  BankTransferBlock,
  FeeQuoteView,
  PaymentQuoteView,
} from '../money-view.type';

/**
 * The one error shape of the Naira wallet contract (task MONEY-04).
 *
 * It is the envelope every route in this backend already answers with
 * (AllExceptionsFilter: `{ statusCode, message, data: null }`), plus the
 * `reason` object that filter already carries through untouched, the way
 * POST /events refuses an unverified host. Money routes always set `reason`
 * with a stable `code`; a 400 without `reason` is the global ValidationPipe
 * refusing a malformed body or query.
 *
 * Detail fields are flat and optional rather than one schema per code, so a
 * generated client reads `reason.shortfallKobo` without narrowing a union.
 * docs/contract/CONVENTIONS.md lists which fields each code sets.
 */
export class MoneyErrorReason {
  @ApiProperty({ enum: MONEY_ERROR_CODES })
  code!: MoneyErrorCode;

  /** A sentence the app may show as it is. Never an em-dash, never a provider's raw text. */
  message!: string;

  /** pin_incorrect: wrong tries left before the PIN locks. reset_code_invalid: tries left on this code. */
  triesLeft?: number;

  /** pin_locked: when the lock ends, ISO 8601 UTC. */
  lockedUntil?: string;

  /** insufficient_funds: Fintava's available balance when the payment was refused. */
  balanceKobo?: number;

  /** insufficient_funds, daily_limit_exceeded: the total the request needed (amount plus fees). */
  totalKobo?: number;

  /** insufficient_funds: totalKobo minus balanceKobo, what to add before trying again. */
  shortfallKobo?: number;

  /** daily_limit_exceeded: what is left of today's limit. */
  remainingTodayKobo?: number;

  /** amount_out_of_range: the smallest amount accepted. */
  minimumKobo?: number;

  /** amount_out_of_range: the largest amount accepted. */
  maximumKobo?: number;

  /** quote_changed on a transfer: the quote as it stands now. */
  @ApiPropertyOptional({ allOf: [{ $ref: getSchemaPath('FeeQuoteView') }] })
  feeQuote?: FeeQuoteView;

  /** quote_changed on a payment: the quote as it stands now. */
  @ApiPropertyOptional({ allOf: [{ $ref: getSchemaPath('PaymentQuoteView') }] })
  paymentQuote?: PaymentQuoteView;

  /** bank_transfers_blocked: why (W18). */
  @ApiPropertyOptional({
    enum: ['kyc_pending', 'kyc_rejected', 'kyc_not_submitted'],
  })
  blockedBy?: BankTransferBlock;

  /** provider_unreachable, idempotency_in_progress: seconds to wait before trying again. */
  retryAfterSeconds?: number;
}

/** The body of every refused money request. */
export class MoneyErrorEnvelope {
  /** The HTTP status again. */
  statusCode!: number;

  /** Same as reason.message. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;

  reason!: MoneyErrorReason;
}

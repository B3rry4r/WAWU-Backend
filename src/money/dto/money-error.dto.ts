import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { MONEY_ERROR_CODES, type MoneyErrorCode } from './money-enums';
import {
  MONEY_LIMIT_NAMES,
  type MoneyLimitName,
} from '../limits/money-limit-names';
import type {
  BankTransferBlock,
  FeeQuoteView,
  PaymentQuoteView,
} from '../money-view.type';
import type { PointsConvertQuoteView } from '../../points/convert/points-convert-view.type';

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

  /** insufficient_funds: the wallet provider's available balance when the movement was refused. */
  @ApiPropertyOptional({ type: 'integer' })
  balanceKobo?: number;

  /** insufficient_funds, daily_limit_exceeded: the total the request needed (amount plus fees). */
  @ApiPropertyOptional({ type: 'integer' })
  totalKobo?: number;

  /** insufficient_funds: totalKobo minus balanceKobo, what to add before trying again. */
  @ApiPropertyOptional({ type: 'integer' })
  shortfallKobo?: number;

  /** daily_limit_exceeded, limit_reached: what is left of today's limit. */
  @ApiPropertyOptional({ type: 'integer' })
  remainingTodayKobo?: number;

  /** limit_reached on the account's daily limit (WALLET-23): the limit itself, in kobo. */
  @ApiPropertyOptional({ type: 'integer' })
  limitKobo?: number;

  /**
   * The same figures for an account that is not naira (WALLET-21): an integer
   * in the smallest unit of `currency`. insufficient_funds, limit_reached,
   * amount_out_of_range on a foreign account, a swap or a crypto send.
   */
  @ApiPropertyOptional({ type: 'integer' })
  balanceMinor?: number;

  @ApiPropertyOptional({ type: 'integer' })
  totalMinor?: number;

  @ApiPropertyOptional({ type: 'integer' })
  shortfallMinor?: number;

  @ApiPropertyOptional({ type: 'integer' })
  remainingTodayMinor?: number;

  @ApiPropertyOptional({ type: 'integer' })
  limitMinor?: number;

  /** The currency the Minor figures above are in (a WAWU code: USD, USDT ...). */
  @ApiPropertyOptional()
  currency?: string;

  @ApiPropertyOptional({ type: 'integer' })
  minimumMinor?: number;

  @ApiPropertyOptional({ type: 'integer' })
  maximumMinor?: number;

  /**
   * The fields a provider refused, by key (`recipient_details_invalid`).
   * Also, on `account_not_opened` for a world opening (WALLET-41): the names
   * of the fields the provider's own refusal pointed at (for example
   * `person.ssn`), never a value. The app asks for them; the list is the
   * provider's, not a fixed one of ours.
   */
  @ApiPropertyOptional({ type: [String] })
  fields?: string[];

  /** amount_out_of_range: the smallest amount accepted. */
  @ApiPropertyOptional({ type: 'integer' })
  minimumKobo?: number;

  /** amount_out_of_range: the largest amount accepted. */
  @ApiPropertyOptional({ type: 'integer' })
  maximumKobo?: number;

  /** quote_changed on a transfer: the quote as it stands now. */
  @ApiPropertyOptional({ allOf: [{ $ref: getSchemaPath('FeeQuoteView') }] })
  feeQuote?: FeeQuoteView;

  /** quote_changed on a payment: the quote as it stands now. */
  @ApiPropertyOptional({ allOf: [{ $ref: getSchemaPath('PaymentQuoteView') }] })
  paymentQuote?: PaymentQuoteView;

  /** quote_changed on a points conversion: the quote as it stands now, with a new token. */
  @ApiPropertyOptional({
    allOf: [{ $ref: getSchemaPath('PointsConvertQuoteView') }],
  })
  pointsQuote?: PointsConvertQuoteView;

  /** payment_in_progress: the payment for this item still being confirmed (MONEY-17). */
  paymentId?: string;

  /**
   * account_name_changed: the name the bank gives for the account now (the
   * name to show for the person to confirm), and the bank's name for it.
   */
  accountName?: string;

  bankName?: string;

  /**
   * account_not_in_your_name: the name on the person's wallet, set beside
   * `accountName` (the bank's name for the account) and `bankName`. Left out
   * when the wallet holds no name to show. The comparison itself is made on
   * the verified name's keyed hashes, never on this text (WALLET-37).
   */
  verifiedName?: string;

  /** bank_transfers_blocked: why (W18). */
  @ApiPropertyOptional({
    enum: ['kyc_pending', 'kyc_rejected', 'kyc_not_submitted'],
  })
  blockedBy?: BankTransferBlock;

  /** provider_unreachable, idempotency_in_progress, identity_checks_exhausted, open_address_limited, selfie_checks_exhausted, reset_codes_exhausted, recipient_search_rate_limited, name_check_rate_limited: seconds to wait before trying again. */
  retryAfterSeconds?: number;

  /** bvn_not_confirmed, bvn_phone_mismatch: BVN checks left in the current 24 hours. selfie_not_matched: selfie matches left in the current 24 hours. */
  checksLeft?: number;

  /** limit_reached: which limit the movement passes (NUV-07), WAWU's own or the provider's. */
  @ApiPropertyOptional({ enum: MONEY_LIMIT_NAMES })
  limit?: MoneyLimitName;

  /** below_minimum: the fewest points one conversion to cash takes (POINTS-04). */
  @ApiPropertyOptional({ type: 'integer' })
  minimumPoints?: number;

  /** below_minimum, insufficient_points: the points the person has now. */
  @ApiPropertyOptional({ type: 'integer' })
  balancePoints?: number;

  /** insufficient_points: the points asked for. */
  @ApiPropertyOptional({ type: 'integer' })
  neededPoints?: number;

  /** insufficient_points: neededPoints minus balancePoints. */
  @ApiPropertyOptional({ type: 'integer' })
  shortfallPoints?: number;

  /** points_cap_reached (POINTS-03): which cap stopped the job. */
  @ApiPropertyOptional({
    enum: ['daily', 'characters_per_job', 'minutes_per_job'],
  })
  cap?: 'daily' | 'characters_per_job' | 'minutes_per_job';

  /** points_cap_reached: the cap's size, in `capUnit`. */
  @ApiPropertyOptional({ type: 'integer' })
  capLimit?: number;

  /** points_cap_reached: what the cap counts. */
  @ApiPropertyOptional({ enum: ['points', 'characters', 'minutes'] })
  capUnit?: 'points' | 'characters' | 'minutes';

  /** points_cap_reached, daily cap: points of AI jobs held or spent today. */
  @ApiPropertyOptional({ type: 'integer' })
  usedPoints?: number;

  /** points_cap_reached, daily cap: points still free today. */
  @ApiPropertyOptional({ type: 'integer' })
  remainingPoints?: number;

  /** points_cap_reached, daily cap: when the day's count starts again (ISO 8601). */
  @ApiPropertyOptional({ type: 'string', nullable: true })
  resetsAt?: string | null;
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

/**
 * The body of a 400 for a malformed field (the global ValidationPipe, or a
 * route's own plain refusal): the same envelope with no `reason`
 * (docs/contract/CONVENTIONS.md section 3). The app switches on the status.
 */
export class MoneyPlainErrorEnvelope {
  /** 400. */
  statusCode!: number;

  /** A sentence about the first field that is wrong. */
  message!: string;

  /** Always null on an error. */
  @ApiProperty({ nullable: true, type: Object, example: null })
  data!: null;
}

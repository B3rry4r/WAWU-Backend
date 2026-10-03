import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  APPROVAL_BIOMETRICS,
  type ApprovalBiometricKind,
  BENEFICIARY_KINDS,
  type BeneficiaryKind,
  FEE_QUOTE_KINDS,
  type FeeQuoteKind,
  HOLD_ROLES,
  type HoldRole,
  PAYMENT_KINDS,
  type PaymentKind,
  TRANSACTION_FILTERS,
  type TransactionFilter,
} from './money-enums';

/**
 * Request bodies and queries of the Naira wallet contract (task MONEY-04).
 * Conventions every field follows are in docs/contract/CONVENTIONS.md: money
 * in integer kobo, phones normalised by the server, the PIN only ever in the
 * X-Transaction-Pin header of the request that needs it (or, when setting a
 * new PIN, in the body of the PIN route itself).
 */

/** Four digits. Validation only; what the PIN may be beyond that is MONEY-09's. */
const PIN_PATTERN = /^[0-9]{4}$/;
const PIN_MESSAGE = 'A PIN is four digits.';

/**
 * A bank code: 3 to 6 digits, as the Flutterwave wallet already accepts.
 * Fintava's are 4 to 6 and are never left-padded (sandbox/01-bank-list.md).
 */
const BANK_CODE_PATTERN = /^[0-9]{3,6}$/;

/** NUBAN: ten digits, never anything but digits. */
const NUBAN_PATTERN = /^[0-9]{10}$/;

/**
 * The largest amount validation lets through: the largest integer a JSON
 * number carries exactly. It is a correctness bound, not a money rule.
 * The money rules are applied by the service, never here, so they answer
 * with a reason (CONVENTIONS.md section 1):
 * - a customer's own send is bounded by the daily limit;
 * - anything through WAWU's merchant wallet (a payment, a hold, a payout) is
 *   bounded by MERCHANT_MAX_PER_TXN_KOBO from config, and above it the answer
 *   is `amount_out_of_range` with `maximumKobo` (Lead ruling, 2 Oct 2026).
 */
const MAX_EXACT_KOBO = Number.MAX_SAFE_INTEGER;

/** A payment's target id as the owning feature returns it: a uuid, or a short slug such as a tick kind. */
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** YYYY-MM. */
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/* ------------------------------------------------------------------ */
/* PIN                                                                 */
/* ------------------------------------------------------------------ */

/** POST /money/pin: set the first PIN (A9 then A10, W36). Both entries travel together; the server compares them. */
export class SetPinDto {
  @ApiProperty({ pattern: PIN_PATTERN.source })
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  pin!: string;

  /** The second entry (A10 "Enter it again"). A difference is `pin_mismatch`. */
  @ApiProperty({ pattern: PIN_PATTERN.source })
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  pinConfirmation!: string;
}

/** PUT /money/pin: change the PIN. The current PIN goes in X-Transaction-Pin, never here. */
export class ChangePinDto {
  @ApiProperty({ pattern: PIN_PATTERN.source })
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  newPin!: string;

  @ApiProperty({ pattern: PIN_PATTERN.source })
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  newPinConfirmation!: string;
}

/** POST /money/pin/reset/confirm: the code sent to the phone on file, and the new PIN (W37 then W36). */
export class ConfirmPinResetDto {
  /** From POST /money/pin/reset. */
  @IsUUID()
  resetId!: string;

  /** The code from the text message. Its length is set by whoever sends it (MONEY-14). */
  @ApiProperty({ pattern: '^[0-9]{4,8}$' })
  @Matches(/^[0-9]{4,8}$/, { message: 'Enter the code from the text message.' })
  code!: string;

  @ApiProperty({ pattern: PIN_PATTERN.source })
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  newPin!: string;

  @ApiProperty({ pattern: PIN_PATTERN.source })
  @Matches(PIN_PATTERN, { message: PIN_MESSAGE })
  newPinConfirmation!: string;
}

/**
 * PUT /money/device: register this phone's key for biometric approval (W35,
 * MONEY-14). The current PIN goes in X-Transaction-Pin.
 */
export class RegisterApprovalDeviceDto {
  /**
   * The public half of a P-256 key the phone made, as SubjectPublicKeyInfo
   * (DER), base64url without padding. Its private half stays on the phone,
   * unlocked only by the phone's biometric.
   */
  @ApiProperty({ pattern: '^[A-Za-z0-9_-]{80,200}$' })
  @Matches(/^[A-Za-z0-9_-]{80,200}$/, {
    message: 'publicKey is a P-256 public key (SPKI DER, base64url).',
  })
  publicKey!: string;

  /** What the phone approves with, for W35's label. */
  @ApiProperty({ enum: APPROVAL_BIOMETRICS })
  @IsIn(APPROVAL_BIOMETRICS, { message: 'biometric is fingerprint or face.' })
  biometric!: ApprovalBiometricKind;
}

/* ------------------------------------------------------------------ */
/* Banks, recipients, beneficiaries, payout account                    */
/* ------------------------------------------------------------------ */

/**
 * POST /money/banks/name-check. A POST although it reads: an account number
 * in a URL ends up in proxy logs, the reason POST /wallet/resolve-account
 * gives for the Flutterwave wallet.
 */
export class NameCheckDto {
  @ApiProperty({ pattern: BANK_CODE_PATTERN.source })
  @Matches(BANK_CODE_PATTERN, {
    message: 'bankCode must be a numeric bank code',
  })
  bankCode!: string;

  @ApiProperty({ pattern: NUBAN_PATTERN.source })
  @Matches(NUBAN_PATTERN, { message: 'accountNumber must be 10 digits' })
  accountNumber!: string;
}

/**
 * GET /money/recipients?q=. A name, an @handle, or a phone number in any
 * common Nigerian form (080..., 234..., +234..., spaces allowed); the
 * server normalises a phone to +234 before matching, and matches a phone
 * only in full.
 */
export class RecipientSearchQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  q!: string;
}

/**
 * POST /money/beneficiaries. A bank account is name-checked by the server
 * before it is saved. The fields of the other kind are refused (a plain
 * 400), so a body names exactly one place (WALLET-14).
 */
export class CreateBeneficiaryDto {
  @ApiProperty({ enum: BENEFICIARY_KINDS })
  @IsIn(BENEFICIARY_KINDS)
  kind!: BeneficiaryKind;

  /** Required when kind is wawu_user. */
  @ValidateIf((o: CreateBeneficiaryDto) => o.kind === 'wawu_user')
  @IsUUID()
  wawuUserId?: string;

  /** Required when kind is bank_account. */
  @ApiPropertyOptional({ pattern: BANK_CODE_PATTERN.source })
  @ValidateIf((o: CreateBeneficiaryDto) => o.kind === 'bank_account')
  @Matches(BANK_CODE_PATTERN, {
    message: 'bankCode must be a numeric bank code',
  })
  bankCode?: string;

  /** Required when kind is bank_account. */
  @ApiPropertyOptional({ pattern: NUBAN_PATTERN.source })
  @ValidateIf((o: CreateBeneficiaryDto) => o.kind === 'bank_account')
  @Matches(NUBAN_PATTERN, { message: 'accountNumber must be 10 digits' })
  accountNumber?: string;
}

/** PUT /money/payout-account (A21). The server name-checks it and compares the name with the BVN name. */
export class PayoutAccountDto {
  @ApiProperty({ pattern: BANK_CODE_PATTERN.source })
  @Matches(BANK_CODE_PATTERN, {
    message: 'bankCode must be a numeric bank code',
  })
  bankCode!: string;

  @ApiProperty({ pattern: NUBAN_PATTERN.source })
  @Matches(NUBAN_PATTERN, { message: 'accountNumber must be 10 digits' })
  accountNumber!: string;
}

/* ------------------------------------------------------------------ */
/* Fee quotes and transfers                                            */
/* ------------------------------------------------------------------ */

/** GET /money/fees/quote?kind=&amountKobo= */
export class FeeQuoteQueryDto {
  @ApiProperty({ enum: FEE_QUOTE_KINDS })
  @IsIn(FEE_QUOTE_KINDS)
  kind!: FeeQuoteKind;

  /** What the recipient should get, in kobo. */
  @Type(() => Number)
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  amountKobo!: number;
}

/** POST /money/transfers/wawu (W7 to W12). Headers: Idempotency-Key, X-Transaction-Pin. */
export class WawuTransferDto {
  @IsUUID()
  recipientWawuUserId!: string;

  /** What the recipient gets, in kobo. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  amountKobo!: number;

  /** `totalKobo` from the fee quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  expectedTotalKobo!: number;

  /** W9's optional note. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  note?: string;
}

/**
 * POST /money/transfers/bank (W8, W10 to W14, W17 to W19; a withdrawal is a
 * bank send to the payout account). Headers: Idempotency-Key,
 * X-Transaction-Pin. The server runs the name check again and sends to the
 * name the bank returns; the app never sends a typed name.
 */
export class BankTransferDto {
  @ApiProperty({ pattern: BANK_CODE_PATTERN.source })
  @Matches(BANK_CODE_PATTERN, {
    message: 'bankCode must be a numeric bank code',
  })
  bankCode!: string;

  @ApiProperty({ pattern: NUBAN_PATTERN.source })
  @Matches(NUBAN_PATTERN, { message: 'accountNumber must be 10 digits' })
  accountNumber!: string;

  /** What the bank account gets, in kobo. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  amountKobo!: number;

  /** `totalKobo` from the fee quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  expectedTotalKobo!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Pay from wallet                                                     */
/* ------------------------------------------------------------------ */

/** GET /money/payments/quote?kind=&targetId=&amountKobo= */
export class PaymentQuoteQueryDto {
  @ApiProperty({ enum: PAYMENT_KINDS })
  @IsIn(PAYMENT_KINDS)
  kind!: PaymentKind;

  /** The id the owning feature returns for the thing being paid for (docs/contract/WALLET.md). */
  @ApiProperty({ pattern: TARGET_ID_PATTERN.source })
  @Matches(TARGET_ID_PATTERN, { message: 'targetId is not a valid id' })
  targetId!: string;

  /** Only for a tip, where the payer chooses the amount. Refused on every other kind. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  amountKobo?: number;
}

/** POST /money/payments (H14 to H18 and every "Pay from wallet"). Headers: Idempotency-Key, X-Transaction-Pin. */
export class PaymentDto {
  @ApiProperty({ enum: PAYMENT_KINDS })
  @IsIn(PAYMENT_KINDS)
  kind!: PaymentKind;

  @ApiProperty({ pattern: TARGET_ID_PATTERN.source })
  @Matches(TARGET_ID_PATTERN, { message: 'targetId is not a valid id' })
  targetId!: string;

  /** Only for a tip. Every other price is the server's own record of the item. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_EXACT_KOBO)
  amountKobo?: number;

  /** `totalKobo` from the payment quote the person saw. A different server total is `quote_changed`. */
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  expectedTotalKobo!: number;

  /** Only for a tip: the message that goes with it, 500 characters as POST /tips takes today. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Cursor pages: history and holds                                     */
/* ------------------------------------------------------------------ */

/** Shared by every cursor-paged money list. */
class CursorQueryDto {
  /** `nextCursor` from the previous page. Opaque: send it back as given. Absent for the first page. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /** Rows per page, 1 to 100. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/** GET /money/transactions (W26, W28). */
export class TransactionListQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: TRANSACTION_FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(TRANSACTION_FILTERS)
  filter?: TransactionFilter = 'all';

  /**
   * Free-text search over the counterparty's name, the description, the
   * note and the reference. Spaces around it are dropped first; what is
   * left must be 2 to 60 characters.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  q?: string;

  /**
   * A grouped row's `group.key`: lists the movements it stands for, one per
   * row, instead of the history. Opaque: send it back as given.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  group?: string;

  /** Only rows from this month, YYYY-MM in Africa/Lagos time (W28 "Bills in September"). */
  @ApiPropertyOptional({ pattern: MONTH_PATTERN.source })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'month must look like 2026-09' })
  month?: string;
}

/** GET /money/transactions/summary?month= */
export class MonthlySummaryQueryDto {
  /** YYYY-MM in Africa/Lagos time. */
  @ApiProperty({ pattern: MONTH_PATTERN.source })
  @Matches(MONTH_PATTERN, { message: 'month must look like 2026-09' })
  month!: string;
}

/** GET /money/holds */
export class HoldListQueryDto extends CursorQueryDto {
  /** payer: money I paid that is held. payee: money held for me. */
  @ApiProperty({ enum: HOLD_ROLES })
  @IsIn(HOLD_ROLES)
  role!: HoldRole;
}

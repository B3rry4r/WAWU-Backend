import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** Largest page of any list here; a page that asks for balances is smaller (the provider is asked once per row). */
export const ADMIN_MONEY_MAX_LIMIT = 50;
/** Largest page of wallets when `withBalance=true`. */
export const ADMIN_MONEY_BALANCE_PAGE_CAP = 25;

export class AdminMoneyPageQueryDto {
  /** The `nextCursor` of the last page, as given. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ADMIN_MONEY_MAX_LIMIT,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_MONEY_MAX_LIMIT)
  limit?: number;
}

export class AdminMoneyWalletsQueryDto extends AdminMoneyPageQueryDto {
  /** Finds a wallet by handle, WAWU ID, account name or the last digits of its account number. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  /**
   * `true`: ask the wallet provider for each row's balance. The page then holds at most 25 rows, and a row the provider
   * did not answer for carries `balanceUnavailable` and no figure.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === '1'
      ? true
      : value === 'false' || value === '0'
        ? false
        : value,
  )
  @IsBoolean()
  withBalance?: boolean;
}

export class AdminMoneyRevenueQueryDto {
  /** Inclusive lower bound, ISO 8601. With neither bound: the current calendar month (UTC). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Exclusive upper bound, ISO 8601. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** A balance exactly as the provider answered, in kobo. */
export class AdminMoneyBalanceView {
  /** What can be spent. */
  availableKobo!: number;
  /** Including what is pending settlement. */
  bookedKobo!: number;
  /** Always `provider`: this figure is the provider's own answer, never a sum of our rows. */
  source!: 'provider';
  /** When the provider was asked. */
  asOf!: string;
}

export class AdminMoneyWalletView {
  wawuId!: string;
  handle!: string | null;
  /** The name the provider holds the account under (our stored copy); null when it never said. */
  displayName!: string | null;
  /** `fintava` or `nuvion`: always the provider this server runs. */
  provider!: string;
  openedAt!: string;
  /** The wallet exists, so it is open. */
  status!: 'open';
  /** The last four digits of the account number; the full number never leaves the Hub here. */
  accountLast4!: string;
  /** Present only with `withBalance=true` (and on one wallet), and only when the provider answered. */
  balance?: AdminMoneyBalanceView;
  /** Present when a balance was asked for and the provider did not answer: why, in plain words. No figure goes with it. */
  balanceUnavailable?: string;
}

export class AdminMoneyWalletPage {
  items!: AdminMoneyWalletView[];
  nextCursor!: string | null;
}

/** One of OUR ledger rows. A record of a movement, never a balance. */
export class AdminMoneyLedgerRowView {
  id!: string;
  direction!: 'in' | 'out';
  status!: 'pending' | 'completed' | 'failed' | 'reversed';
  category!: string;
  amountKobo!: number;
  feeKobo!: number;
  totalKobo!: number;
  counterpartyName!: string | null;
  /** What it paid for (a payment kind) and its title, when a feature set them. */
  linkKind!: string | null;
  linkTitle!: string | null;
  reference!: string | null;
  occurredAt!: string;
}

export class AdminMoneyWalletDetailView {
  wallet!: AdminMoneyWalletView;
  /** Plain words: the rows below are our records of movements, not a balance. */
  recordsNote!: string;
  /** Newest first. */
  records!: AdminMoneyLedgerRowView[];
  nextCursor!: string | null;
}

export class AdminMoneyHeldByKindView {
  kind!: string;
  count!: number;
  /** What our records say is held, before the 85/15 split. */
  heldKobo!: number;
  payeeShareKobo!: number;
  wawuShareKobo!: number;
}

export class AdminMoneyHeldView {
  id!: string;
  kind!: string;
  title!: string;
  payerWawuId!: string | null;
  payerHandle!: string | null;
  /** Null when WAWU itself is paid (a bill). */
  payeeWawuId!: string | null;
  payeeHandle!: string | null;
  amountKobo!: number;
  payeeShareKobo!: number;
  wawuShareKobo!: number;
  heldAt!: string;
  /** Why nothing has moved yet, when our record says. */
  waiting!: string | null;
  /** True when a person has to look at it. */
  inReview!: boolean;
}

export class AdminMoneyMerchantView {
  provider!: string;
  /** WAWU's own account at the provider: the provider's answer, or the reason there is none. */
  account!: {
    accountLast4: string;
    accountName: string;
    balance: AdminMoneyBalanceView;
  } | null;
  balanceUnavailable?: string;
  /** Plain words: what follows is our records of held money, not a balance. */
  recordsNote!: string;
  /** Held money by kind (paid DMs, tickets, bills, school fees), all of it. */
  heldByKind!: AdminMoneyHeldByKindView[];
  /** The holds themselves, oldest first, a cursor page. */
  holds!: AdminMoneyHeldView[];
  nextCursor!: string | null;
}

export class AdminMoneyBreakdownView {
  key!: string;
  label!: string;
  count!: number;
  grossKobo!: number;
  /** Sales counted but carrying no price in our records (a tier or a points pack from a store): never guessed. */
  unpricedCount!: number;
}

export class AdminMoneyStreamView {
  key!: string;
  label!: string;
  /** Which rail took the money: Apple, Google, the wallet provider's name, or Flutterwave (/join only). */
  rail!: string;
  /** The table the figures are read from. */
  source!: string;
  /** The statuses of that table which count. */
  statuses!: string[];
  count!: number;
  grossKobo!: number;
  /** Sales counted but carrying no price in our records; 0 where every row has one. */
  unpricedCount!: number;
  /** What `grossKobo` is, in plain words. */
  grossBasis!: string;
  /** WAWU's 15% and the creators' 85%, as stored on each payment; null where a split does not apply to the stream. */
  wawuKobo!: number | null;
  creatorsKobo!: number | null;
  /** Money given back on held payments of the stream in the window; null where it does not apply. */
  refundedKobo!: number | null;
  breakdown?: AdminMoneyBreakdownView[];
}

export class AdminMoneyRevenueView {
  period!: { from: string; to: string; window: string };
  split!: { creatorsPercent: number; wawuPercent: number };
  streams!: AdminMoneyStreamView[];
  note!: string;
}

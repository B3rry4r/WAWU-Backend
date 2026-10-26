/**
 * Foreign-currency accounts at the wallet provider (task WALLET-21, R-83,
 * R-84): the part of the seam for dollar, euro, pound, Canadian dollar,
 * dirham and cedi accounts, the stablecoins USDT, USDC and RLUSD, the quote
 * and swap between them and the naira wallet, and the send of a stablecoin to
 * an outside address.
 *
 * Optional on `WalletProvider` (`fx`), like freezing: a provider without it
 * (Fintava) leaves it out and the Hub answers `currency_not_supported`; it is
 * never guessed. Nothing here is a provider's wire shape. Currencies are
 * WAWU's codes (`USD`, `USDT` ...), chains are `eth | base | matic | sol`, and
 * `NGN` stands for the person's naira wallet (kobo). Every other amount is an
 * integer in the currency's smallest unit as a `bigint` (`...Minor`).
 */

export type ProviderFxChain = 'eth' | 'base' | 'matic' | 'sol';

/** The person at the provider: the naira wallet is the rail of a swap to or from naira. */
export interface ProviderFxPerson {
  /** The provider's customer (Nuvion: the entity). */
  customerId: string;
  /** The naira wallet's id (`ProviderCustomer.walletId`). */
  walletId: string;
}

/** One foreign account as the provider describes it. */
export interface ProviderFxAccount {
  /** The provider's id for the account. */
  accountId: string;
  currency: string;
  /** What a book transfer is routed on to this account; null if none is issued. */
  ban: string | null;
  availableMinor: bigint;
  bookedMinor: bigint;
}

/** The details payers use. Fields the provider did not issue are null. */
export interface ProviderFxDetails {
  /** The provider's id for the details. */
  detailsId: string;
  status: 'pending' | 'active';
  beneficiaryName: string | null;
  accountNumber: string | null;
  routingNumber: string | null;
  swiftCode: string | null;
  iban: string | null;
  sortCode: string | null;
  bankName: string | null;
  bankAddress: string | null;
  chain: ProviderFxChain | null;
  /** A stablecoin account's wallet address. */
  address: string | null;
}

/** What reading (and, when asked, issuing) an account's details answered. */
export interface ProviderFxDetailsRead {
  /** Null when the provider holds none. */
  details: ProviderFxDetails | null;
  /**
   * The provider's own words when it would not issue them just now (Nuvion
   * answered 503 for CAD and AED on dev); null when it held them or was not
   * asked to issue them.
   */
  refusal: string | null;
}

export interface ProviderFxOpened {
  account: ProviderFxAccount;
  /** Null when the provider could not issue them yet (read them again later). */
  details: ProviderFxDetails | null;
  /** Why not, in the provider's words, when it said. */
  detailsRefusal: string | null;
}

/** A side of a quote or a swap: a foreign account, or the naira wallet (`NGN`). */
export interface ProviderFxSide {
  currency: string;
  /** The provider's account id; null for NGN. */
  accountId: string | null;
  /** The account's routing number for a book transfer; null for NGN or unknown. */
  ban?: string | null;
}

export interface ProviderFxQuoteInput {
  person: ProviderFxPerson;
  from: ProviderFxSide;
  to: ProviderFxSide;
  /** Exactly one of the two. */
  amountFromMinor?: bigint;
  amountToMinor?: bigint;
}

export interface ProviderFxQuote {
  /** The provider's quote id. */
  id: string;
  amountFromMinor: bigint;
  amountToMinor: bigint;
  /** The provider's rate, as it sent it (smallest units per smallest unit). */
  rate: string;
  /** The provider's real expiry. */
  expiresAt: Date;
  /** The provider's charge, if its quote names one; null when it names none. */
  feeMinor: bigint | null;
}

export type ProviderFxTransferStatus = 'pending' | 'completed' | 'failed';

export interface ProviderFxTransfer {
  /** The provider's transfer id. */
  transferId: string;
  /** Our reference, as the provider has it. */
  reference: string;
  status: ProviderFxTransferStatus;
  /** What the provider charged on top, when it says. */
  feeMinor: bigint | null;
  /** The provider's reason for a failure, in plain words; null otherwise. */
  failureReason: string | null;
}

export interface ProviderFxSwapInput {
  person: ProviderFxPerson;
  /** Ours; the provider's idempotency key. */
  reference: string;
  /** The quote to apply; null for a transfer in one currency (WAWU's fee leg). */
  quoteId: string | null;
  from: ProviderFxSide;
  /** The receiving side; `ban` names the account when it is not the naira wallet or the person's own. */
  to: ProviderFxSide;
  amountFromMinor: bigint;
  /** What the provider's statement shows beside the move; default 'WAWU swap'. */
  narration?: string;
}

export interface ProviderFxSendInput {
  person: ProviderFxPerson;
  reference: string;
  accountId: string;
  currency: string;
  chain: ProviderFxChain;
  address: string;
  amountMinor: bigint;
  /** The sender's name, for the payee record. */
  holderName: string;
}

/** What the provider knows of a transfer we made, found again by its id or reference. */
export type ProviderFxTransferLookup =
  | { state: 'found'; transfer: ProviderFxTransfer }
  | { state: 'absent' }
  | { state: 'unknown' };

export interface ProviderFxStatementLine {
  id: string;
  direction: 'in' | 'out';
  status: 'completed' | 'pending' | 'failed' | 'reversed';
  amountMinor: bigint;
  feeMinor: bigint;
  balanceAfterMinor: bigint | null;
  description: string;
  counterpartyName: string | null;
  reference: string;
  occurredAt: string;
  conversion: {
    fromCurrency: string;
    toCurrency: string;
    rate: string;
    fromMinor: bigint;
    toMinor: bigint;
  } | null;
}

export interface ProviderFxStatementPage {
  lines: ProviderFxStatementLine[];
  /** Pages of this month remain after this one; pass back as `cursor`. */
  nextCursor: string | null;
}

export interface ProviderForeignAccounts {
  /** Which currencies this provider holds (WAWU codes). */
  readonly currencies: readonly string[];

  /**
   * Opens an account in one currency on the person's entity and asks for its
   * details. Fails `refused`/`validation` with the provider's words when it
   * will not (a USD account for a person it cannot serve, say).
   */
  openAccount(input: {
    person: ProviderFxPerson;
    currency: string;
    chain: ProviderFxChain | null;
    displayName: string;
    holderName: string;
  }): Promise<ProviderFxOpened>;

  /** One account with its balance, read now. */
  readAccount(
    person: ProviderFxPerson,
    accountId: string,
  ): Promise<ProviderFxAccount>;

  /**
   * The account's details; asked for (made) when `ensure` and the provider
   * holds none. Null when it holds none and `ensure` is false, or when it
   * cannot issue them yet.
   */
  readDetails(
    person: ProviderFxPerson,
    account: {
      accountId: string;
      currency: string;
      chain: ProviderFxChain | null;
    },
    ensure: boolean,
  ): Promise<ProviderFxDetailsRead>;

  quote(input: ProviderFxQuoteInput): Promise<ProviderFxQuote>;

  /**
   * PAY-FX (R-91): WAWU's own naira account as the SOURCE of a conversion
   * into a person's foreign account (a refund of a payment that came from
   * that account, in its currency, the same amount). Optional, like the rest
   * of the provider's extras: a provider without it cannot pay such a refund
   * back, and the Hub says so. `to` is the person's foreign account (its
   * `ban` names it); `amountToMinor` is what must arrive, in its currency.
   */
  quoteFromMerchant?(input: {
    to: ProviderFxSide;
    amountToMinor: bigint;
  }): Promise<ProviderFxQuote>;

  /** The move that applies a `quoteFromMerchant` quote. Idempotent by `reference`. */
  swapFromMerchant?(input: {
    reference: string;
    quoteId: string;
    to: ProviderFxSide;
    /** The quote's `amountFromMinor`, in kobo. */
    amountFromMinor: bigint;
    narration?: string;
  }): Promise<ProviderFxTransfer>;

  /** Finds a move made from WAWU's own naira account by its reference. */
  findMerchantTransfer?(reference: string): Promise<ProviderFxTransferLookup>;

  /** A book transfer between two of the person's accounts at the quoted rate. Idempotent by `reference`. */
  swap(input: ProviderFxSwapInput): Promise<ProviderFxTransfer>;

  /** A stablecoin send to an outside address. Idempotent by `reference`. */
  send(input: ProviderFxSendInput): Promise<ProviderFxTransfer>;

  /**
   * Finds a transfer made by us from its reference, after an answer was lost
   * (`absent` only when the provider proves there is none; `unknown` when the
   * lookup could not).
   */
  findTransferByReference(
    person: ProviderFxPerson,
    accountId: string,
    reference: string,
  ): Promise<ProviderFxTransferLookup>;

  /** The state of a transfer made by us. */
  readTransfer(
    person: ProviderFxPerson,
    transferId: string,
  ): Promise<ProviderFxTransferLookup>;

  /** One page of an account's statement for a month (1 to 12), oldest first. */
  statement(
    person: ProviderFxPerson,
    account: { accountId: string; currency: string },
    query: {
      year: number;
      month: number;
      cursor: string | null;
      limit: number;
    },
  ): Promise<ProviderFxStatementPage>;
}

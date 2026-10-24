import type { WalletProvider } from './wallet-provider.interface';

/**
 * Sending abroad through the wallet provider seam (task NUV-11, R-84).
 *
 * `src/money/abroad/` reaches the provider only through this: the running
 * `WALLET_PROVIDER` offers it as `abroad`, and a provider that cannot pay a
 * foreign bank or mobile money wallet (Fintava) has none, which the money
 * layer answers as `currency_not_supported`. Nothing in this file is a
 * provider's own word; the Nuvion adapter (src/nuvion/areas/abroad.ts) maps
 * its calls onto these shapes and its failures onto `AbroadRefusal`.
 */

/** Whose money: the person's customer id and the wallet id the seam handed out. */
export interface AbroadHolder {
  customerId: string;
  walletId: string;
}

export interface AbroadBank {
  code: string;
  name: string;
  swiftBic: string | null;
}

/** An account the person can send from. */
export interface AbroadSource {
  currency: string;
  /** The provider's account, opaque to the money layer; handed back on a quote and a send. */
  accountRef: string;
  displayName: string | null;
  /** What can be spent now, in the currency's smallest unit; null when the provider could not say. */
  availableMinor: number | null;
}

export interface AbroadRecipientInput {
  holder: AbroadHolder;
  country: string;
  currency: string;
  method: 'bank' | 'mobile_money';
  /** The scheme the person picked, or null when the rail has one the provider infers. */
  scheme: string | null;
  holderName: string;
  /** The corridor's fields by the keys of abroad-corridors.ts (`bank` holds a directory code). */
  fields: Record<string, string>;
  /** Ours: lets a lost answer be found again. */
  marker: string;
}

export interface AbroadRecipientSaved {
  counterpartyId: string;
  paymentDetailId: string;
  /** The bank's name as the provider holds it, when it has one. */
  bankName: string | null;
}

export interface AbroadQuoteInput {
  holder: AbroadHolder;
  fromCurrency: string;
  toCurrency: string;
  fromAccountRef: string;
  amountMinor: number;
  /** `send`: `amountMinor` leaves the account; `receive`: the recipient gets it. */
  side: 'send' | 'receive';
}

export interface AbroadProviderQuote {
  /** The provider's quote id; null when the currencies are the same and there is none. */
  quoteRef: string | null;
  amountFromMinor: number;
  amountToMinor: number;
  /** Units of the destination currency per unit of the source, as text; null when not converted. */
  rate: string | null;
  expiresAt: Date;
  validForSeconds: number;
}

export interface AbroadSendInput {
  holder: AbroadHolder;
  fromAccountRef: string;
  fromCurrency: string;
  toCurrency: string;
  amountFromMinor: number;
  counterpartyId: string;
  paymentDetailId: string;
  method: 'bank' | 'mobile_money';
  quoteRef: string | null;
  narration: string;
  /** Ours, always: the idempotency key at the provider (at most 64 plain characters). */
  reference: string;
}

export type AbroadTransferState =
  'pending' | 'completed' | 'failed' | 'reversed';

export interface AbroadTransfer {
  id: string;
  state: AbroadTransferState;
  /** The provider's own word for the state, kept for the admin and logs. */
  providerStatus: string;
  providerReason: string | null;
  /** What the provider charged, in `feeCurrency`'s smallest unit; null until it says. */
  feeMinor: number | null;
  currency: string;
  amountMinor: number;
  reference: string | null;
  createdAt: Date | null;
}

export type AbroadLookup =
  | { state: 'found'; transfer: AbroadTransfer }
  | { state: 'absent' }
  | { state: 'unknown' };

/**
 * WAWU's fee on a send from a foreign account (WALLET-42, R-87): a book move in that account's own currency, between the person's
 * account and WAWU's collecting account in the same currency (named by its routing number, from config). `take` moves it to WAWU;
 * `give_back` moves the same money back when the send did not stand. Idempotent by `reference`.
 */
export interface AbroadFeeLegRef {
  holder: AbroadHolder;
  currency: string;
  /** The person's account the fee leaves (take) or returns to (give back). */
  accountRef: string;
  /** WAWU's collecting account in the same currency, by its routing number. */
  collectorBan: string;
  direction: 'take' | 'give_back';
}

export interface AbroadFeeLegInput extends AbroadFeeLegRef {
  /** In the currency's smallest unit. */
  amountMinor: bigint;
  /** Ours: the idempotency key at the provider. */
  reference: string;
  narration: string;
}

/** What the provider's own record of a fee leg says. */
export interface AbroadFeeLeg {
  state: 'pending' | 'completed' | 'failed';
  amountMinor: bigint;
  /** What the provider charged for moving it (the fee leg's fee is given back too). */
  feeMinor: bigint;
}

export type AbroadFeeLegLookup =
  | { state: 'found'; leg: AbroadFeeLeg }
  | { state: 'absent' }
  | { state: 'unknown' };

export interface AbroadProvider {
  banks(country: string): Promise<AbroadBank[]>;
  sources(holder: AbroadHolder): Promise<AbroadSource[]>;
  saveRecipient(input: AbroadRecipientInput): Promise<AbroadRecipientSaved>;
  quote(input: AbroadQuoteInput): Promise<AbroadProviderQuote>;
  send(input: AbroadSendInput): Promise<AbroadTransfer>;
  read(holder: AbroadHolder, transferId: string): Promise<AbroadTransfer>;
  /** Finds a send by our reference; `absent` only after a complete search. */
  findByReference(
    holder: AbroadHolder,
    reference: string,
    since: Date | null,
  ): Promise<AbroadLookup>;
  /**
   * WAWU's fee out of (or back into) a foreign account (WALLET-42). Optional: a provider without it cannot take a fee from a
   * foreign account, and the money layer then does not offer a send that would owe one.
   */
  feeLeg?(input: AbroadFeeLegInput): Promise<AbroadFeeLeg>;
  /** The provider's record of a fee leg, found by reference; `absent` only after a complete search. */
  findFeeLeg?(
    ref: AbroadFeeLegRef,
    reference: string,
  ): Promise<AbroadFeeLegLookup>;
}

/** The provider says no, in a way a person can act on. Nothing moved. */
export type AbroadRefusalReason =
  | 'invalid_details'
  | 'corridor_not_supported'
  | 'rate_unavailable'
  | 'quote_expired'
  | 'amount_out_of_range'
  | 'insufficient_funds'
  | 'declined';

export class AbroadRefusal extends Error {
  constructor(
    readonly reason: AbroadRefusalReason,
    /** A sentence a person may read: no provider name, no em-dash. */
    message: string,
    readonly detail: { fields?: string[]; minimumMinor?: number } = {},
  ) {
    super(message);
    this.name = 'AbroadRefusal';
  }
}

/** The running provider's abroad side, or null when it has none (Fintava). */
export function abroadOf(provider: WalletProvider): AbroadProvider | null {
  const maybe = (provider as unknown as { abroad?: AbroadProvider }).abroad;
  return maybe ?? null;
}

/**
 * Everything this service asks Flutterwave to do with a creator's wallet.
 *
 * Declared as an interface plus a DI token, per conventions.md's "external
 * calls behind an interface so contract tests can stub them" rule. The real
 * client talks to api.flutterwave.com; the stub is what every test uses, so
 * no test can move money or depend on a network.
 */

/** A payout subaccount, as Flutterwave returns it. */
export interface PsaWallet {
  accountReference: string;
  barterId: string;
  nuban: string | null;
  bankName: string | null;
  bankCode: string | null;
  status: string;
}

export interface PsaBalance {
  /** Whole naira. Flutterwave reports NGN as a decimal; we round to naira. */
  availableNgn: number;
}

export interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
}

export interface Bank {
  code: string;
  name: string;
}

export interface TransferResult {
  /** Flutterwave's id for the transfer, for reconciling the webhook. */
  transferId: string;
  /** Their immediate view. The webhook is what settles it. */
  status: string;
}

export interface FlutterwaveWalletGateway {
  /** Opens a wallet at Flutterwave MFB in this person's name. */
  createWallet(input: {
    accountName: string;
    email: string;
    country: string;
    mobilenumber?: string;
  }): Promise<PsaWallet>;

  /** What Flutterwave says is in it. The authoritative balance. */
  balance(accountReference: string): Promise<PsaBalance>;

  /** Moves money from WAWU's own balance INTO a creator's wallet. */
  fundWallet(input: {
    barterId: string;
    amount: number;
    reference: string;
    narration: string;
  }): Promise<TransferResult>;

  /** Moves money OUT of a creator's wallet to their bank account. */
  withdraw(input: {
    accountReference: string;
    bankCode: string;
    accountNumber: string;
    amount: number;
    reference: string;
    narration: string;
  }): Promise<TransferResult>;

  /** Confirms an account number belongs to the name we are about to pay. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount>;

  /** The banks a creator can withdraw to. */
  banks(): Promise<Bank[]>;

  /**
   * What became of one transfer, asked directly rather than waited for.
   *
   * The webhook is the normal path; this is what settles a movement when the
   * webhook never arrives, which does happen. Returns null when Flutterwave
   * has no record of the reference at all - which is itself the answer:
   * the request never landed, and the money never moved.
   */
  transferByReference(reference: string): Promise<{ status: string; message?: string } | null>;
}

export const FLUTTERWAVE_WALLET_GATEWAY = Symbol('FLUTTERWAVE_WALLET_GATEWAY');

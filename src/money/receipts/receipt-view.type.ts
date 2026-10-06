import type { TransactionView } from '../money-view.type';

/**
 * Receipts (task WALLET-18): what the owner's routes answer. A receipt is
 * one transaction (MONEY-15's TransactionView, unchanged) with a short code
 * anyone can check at wawu/r/<code>, and the lines the image and the PDF
 * print (W41 to W43).
 */

/** One side of the movement as the receipt prints it. */
export interface ReceiptPartyView {
  /** The name printed: the account name Fintava gave, or the name the movement recorded. */
  name: string;
  /**
   * The full account number, set only on the owner's own side (W41 draws
   * "Lennox Emmanuel · 812 345 6789"): it is the owner's to share. Never
   * set for the other side.
   */
  accountNumber: string | null;
  /** The other side's account, last 4 digits only, when the movement names one. */
  accountNumberLast4: string | null;
  /** The other side's bank, when it is a bank account and the bank is known. */
  bankName: string | null;
}

/** One label and value row of the printed receipt, in order. */
export interface ReceiptLineView {
  label: string;
  value: string;
}

/** POST /money/transactions/{id}/receipt: the receipt of one of the owner's own transactions. */
export interface ReceiptView {
  /** 12 characters; the same every time this transaction's receipt is asked for. */
  code: string;
  /** What the receipt prints: `wawu/r/<code>`. */
  link: string;
  /** The page's full address; null until the public host is set (RECEIPT_VERIFY_BASE_URL). */
  url: string | null;
  /** The transaction, as GET /money/transactions/{id} answers it. */
  transaction: TransactionView;
  /** "Tip", "Transfer": the kind, without what it was for. */
  typeLabel: string;
  /** The line above the amount: "Tip from Amaka Nwosu". */
  headline: string;
  /** Who paid; null when the movement names nobody on that side. */
  from: ReceiptPartyView | null;
  /** Who was paid; null when the movement names nobody on that side. */
  to: ReceiptPartyView | null;
  /** The wallet's bank (W41's Bank row; WALLET_BANK_NAME). */
  bankName: string;
  /** Licence wording from config (R-1); null hides it. */
  licenceLine: string | null;
  /** The rows the image and the PDF print under the amount, in order. */
  lines: ReceiptLineView[];
  /** When the code was made. */
  issuedAt: string;
}

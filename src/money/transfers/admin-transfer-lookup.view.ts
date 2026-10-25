/**
 * What the admin lookup of a send answers (R2-MONEY D-03). Our record only: no provider call, no account number. Money is integer kobo.
 */
export interface AdminTransferLookupView {
  id: string;
  /** `wawu_user` (a send to a WAWU user) or `bank_account`. */
  kind: string;
  /** `pending`, `completed`, `failed` or `reversed`, as the send's own record says. */
  status: string;
  /** The stored reference, whole. */
  reference: string;
  /** The `WAW-XXXX-XXXX` form of it a person quotes; null for a reference of another shape. */
  shortReference: string | null;
  amountKobo: number;
  providerFeeKobo: number;
  wawuFeeKobo: number;
  totalKobo: number;
  payerWawuUserId: string | null;
  recipientWawuUserId: string | null;
  payerName: string | null;
  recipientName: string | null;
  /** A send to a bank account: the bank's name. Never the account number. */
  bankName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminTransferLookupResult {
  items: AdminTransferLookupView[];
}

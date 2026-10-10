/**
 * What the event registration routes answer (JOIN-01, R-48). Naira only:
 * `...Kobo` fields are whole kobo; the checkout's `amount` is naira, the unit
 * Flutterwave's checkout takes.
 */

/** GET /waitlist/offers/current: the offer open for registration. */
export interface WaitlistOfferView {
  id: string;
  name: string;
  /** The fee, in whole kobo. */
  priceKobo: number;
  /** The plan the fee turns into once the person signs up in the app. */
  tierName: string;
  /** How many products that plan lets them publish. */
  products: number;
  /** How many days the plan lasts. */
  days: number;
  /** When registration closes (ISO 8601, UTC); null when the offer has no closing date. */
  closesAt: string | null;
}

/** The Flutterwave checkout settings the page opens the payment with. */
export interface WaitlistCheckoutView {
  publicKey: string;
  /** The registration's reference: Flutterwave's tx_ref. */
  txRef: string;
  /** The fee in naira (kobo divided by 100). */
  amount: number;
  currency: 'NGN';
  customerName: string;
  customerEmail: string;
  /** E.164. */
  customerPhone: string;
}

/** POST /waitlist/registrations: the reference and what to pay with. */
export interface WaitlistRegistrationStartView {
  /** Keep this: the status and verify routes take it. */
  reference: string;
  offerId: string;
  /** The fee for this registration, in whole kobo. */
  amountKobo: number;
  flutterwaveConfig: WaitlistCheckoutView;
}

export type WaitlistRegistrationStatus = 'pending' | 'paid' | 'failed';

/**
 * GET /waitlist/registrations/{reference} and POST /waitlist/registrations/verify:
 * where the registration stands. The first name only: never a phone or email.
 */
export interface WaitlistRegistrationStatusView {
  reference: string;
  status: WaitlistRegistrationStatus;
  firstName: string;
}

/** One row of the team's list (admin). */
export interface AdminWaitlistRegistrationView {
  id: string;
  offerId: string;
  fullName: string;
  /** E.164. */
  phone: string;
  email: string;
  state: string | null;
  makes: string | null;
  status: WaitlistRegistrationStatus;
  /** The fee asked for, in whole kobo. */
  amountKobo: number;
  /** What Flutterwave confirmed was paid, in whole kobo; null until paid. */
  paidKobo: number | null;
  paidAt: string | null;
  reference: string;
  flutterwaveTransactionId: string | null;
  /** The WAWU ID account that claimed the payment in the app; null until claimed. */
  claimedByWawuId: string | null;
  claimedAt: string | null;
  createdAt: string;
}

/** The CSV file the team downloads. */
export interface AdminWaitlistExportView {
  fileName: string;
  /** `text/csv; charset=utf-8`. */
  contentType: string;
  /** How many registrations the file lists (its lines, less the header). */
  rowCount: number;
  /** The file itself: a byte-order mark, a header line, one line per registration, lines ending CRLF. */
  content: string;
  /** When the server wrote the file (ISO 8601, UTC). */
  generatedAt: string;
}

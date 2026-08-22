import type { PaymentWebhookReceiptModel } from '../../../generated/prisma/models';

/**
 * The wire shapes for the admin payment-reconciliation surface.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
 * `PaymentWebhookReceipt` shipped with a writer and no reader. The README's
 * deploy checklist calls rows in `unmatched` / `rejected` / `failed` "the
 * reconciliation queue" (§ Deploy checklist, item 6), and
 * `src/payment-webhook/` writes them faithfully — but the only read anywhere
 * in the tree was one `findUnique` inside the settle path's own duplicate
 * claim. Nothing returned a receipt to anybody, so the operator's queue was a
 * table you could only reach with `psql`, and the dashboard's `/payments`
 * screen had nothing to render.
 *
 * ── WHY THESE ARE ADMIN-ONLY VIEWS, NOT THE PRISMA MODEL ─────────────────
 * Protected-surface hazard H-1: nearly every wire type in this codebase is a
 * bare re-export of its Prisma model returned by spread, so a new column on an
 * existing table silently widens a live app response. `PaymentWebhookReceipt`
 * has no app-facing type today, and it is not getting one here — these
 * interfaces are declared field by field so that a future column on the table
 * appears on this surface only when somebody decides it should.
 *
 * `payload` is the one field with a real disclosure decision attached, so it
 * appears on the DETAIL shape only and never on a list row — see
 * `AdminPaymentReceiptDetailView.payload`.
 */

/** Every status `PaymentWebhookReceipt.status` is ever written with. */
export const RECEIPT_STATUSES = [
  'received',
  'settled',
  'rejected',
  'unmatched',
  'ignored',
  'failed',
] as const;

export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * The README's reconciliation queue, by name: a real charge that this backend
 * did not turn into anything the customer can use.
 *
 *  - `unmatched` — the delivery arrived and no money flow owned its tx_ref.
 *    Usually the webhook beating its own `PendingCharge` insert into the
 *    database, which is exactly the case a re-verify fixes.
 *  - `rejected` — a settle path refused it (amount below `expectedAmount`,
 *    wrong currency, Flutterwave reported `failed`).
 *  - `failed` — a retryable fault (Flutterwave unreachable, database blip).
 *    Flutterwave was answered non-2xx and may or may not have redelivered.
 */
export const UNRESOLVED_RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  'unmatched',
  'rejected',
  'failed',
];

/**
 * Statuses an operator may re-run verification for.
 *
 * `settled` is absent and that is the single most important line in this
 * file: a settled receipt is one where a grant already happened, and the
 * endpoint refuses rather than re-running it. `received` is absent too — a
 * delivery is mid-flight, and re-entering it would be racing the webhook.
 */
export const REVERIFIABLE_RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  'unmatched',
  'rejected',
  'failed',
  'ignored',
];

/** One row of the reconciliation queue. */
export interface AdminPaymentReceiptListItemView {
  id: string;
  /** `${event}:${txRef}` — the unique key the delivery claim is made against. */
  deliveryKey: string;
  event: string;
  txRef: string;
  transactionId: string | null;
  status: ReceiptStatus;
  /** Which money flow owned the tx_ref at settlement time. Null when nothing did. */
  flow: string | null;
  /** Why it ended where it did, as recorded by the settle path. */
  detail: string | null;
  receivedAt: Date;
  settledAt: Date | null;
  /** Whole hours since delivery — how a reconciliation backlog is triaged. */
  waitingHours: number;
  /**
   * Whether POST :id/reverify would be accepted for this row.
   *
   * Present so the dashboard can disable the control instead of offering a
   * button that 409s. A control that exists but cannot be used is worse than
   * an absent one.
   */
  reverifiable: boolean;
}

/**
 * The reconciliation fields an operator needs to find the same transaction in
 * the Flutterwave dashboard, lifted out of the stored payload.
 *
 * Every one of these is read for DISPLAY only. `PaymentWebhookService` reads
 * the payload's `amount` / `status` / `currency` for logging and refuses to
 * treat any of it as evidence, and neither does this surface: the re-verify
 * action re-asks Flutterwave rather than believing what is on the row.
 */
export interface AdminPaymentChargeView {
  /** Flutterwave's own reference (`data.flw_ref`) — what their dashboard searches on. */
  flwRef: string | null;
  /** Naira, as the payload reported it. NOT what settlement compares against. */
  amount: number | null;
  chargedAmount: number | null;
  currency: string | null;
  /** Flutterwave's own word for the charge (`successful`, `failed`). */
  chargeStatus: string | null;
  paymentType: string | null;
  /** `data.customer.email` — the string an operator matches a support ticket against. */
  customerEmail: string | null;
  /** Flutterwave's timestamp for the charge, verbatim. */
  chargeCreatedAt: string | null;
}

/**
 * Why this receipt is where it is — computed FRESH at read time, not stored.
 *
 * The stored `detail` says what was true when the delivery landed. That is
 * usually not the question an operator has: "it says unmatched — is it still
 * unmatched?" A webhook that beat its own `PendingCharge` insert is
 * permanently marked `unmatched` even though the charge appeared a second
 * later, and nothing on the row will ever say so.
 *
 * `currentlyOwnedBy` answers it by re-running `PaymentWebhookService.resolve`
 * — the SAME resolution the settle path uses, not a second copy of it.
 */
export interface AdminPaymentDiagnosisView {
  /** Verbatim `detail` from the row: what the settle path said at the time. */
  recordedReason: string | null;
  /**
   * Which money flow owns this tx_ref RIGHT NOW, resolved live. Null means
   * nothing in this backend has a record of the charge — either it belongs to
   * a different WAWU service on the same Flutterwave account, or the row that
   * would own it has since been consumed by a successful settlement.
   */
  currentlyOwnedBy: string | null;
  /** True when a flow owns the tx_ref now but the receipt never settled. */
  looksSettleableNow: boolean;
  /** Whether POST :id/reverify would be accepted. */
  reverifiable: boolean;
  /** Why not, in words the dashboard can print. Null when it is reverifiable. */
  reverifyBlockedReason: string | null;
}

/** One receipt in full. */
export interface AdminPaymentReceiptDetailView extends AdminPaymentReceiptListItemView {
  charge: AdminPaymentChargeView;
  diagnosis: AdminPaymentDiagnosisView;
  /**
   * The raw delivery as Flutterwave sent it.
   *
   * Included deliberately and only here: reconciling a disputed charge means
   * comparing what the provider said against what this backend did, and a
   * summary of the payload is not evidence. It carries a customer email and a
   * card's first-6/last-4 (never a full PAN — Flutterwave does not send one),
   * which is why this endpoint is gated to `superadmin` and `finance` and why
   * the list endpoint omits the field entirely.
   */
  payload: PaymentWebhookReceiptModel['payload'];
}

/** What a re-verify did. */
export interface AdminPaymentReverifyView {
  /**
   * The outcome vocabulary of `PaymentWebhookService.settle` verbatim —
   * `settled` | `rejected` | `unmatched` | `ignored`. Not translated, so an
   * operator and a webhook log say the same word about the same event.
   */
  outcome: string;
  flow: string | null;
  detail: string | null;
  /**
   * True only when THIS call is the one that granted. A re-verify that finds
   * the charge already consumed reports `false` alongside an honest outcome —
   * it never claims a grant it did not make.
   */
  granted: boolean;
  /** The receipt as it now stands. */
  receipt: AdminPaymentReceiptDetailView;
}

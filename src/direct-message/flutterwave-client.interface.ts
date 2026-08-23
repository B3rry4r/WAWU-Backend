/**
 * FlutterwaveClient — injectable boundary around the Flutterwave v3 REST API,
 * scoped to DirectMessage's own directory (task brief: this resource builds
 * its own, following src/purchase's precedent exactly — not a shared global
 * yet).
 *
 * Pattern: client-charge + server-verify (conventions.md § Third-party
 * integrations › Flutterwave), NOT hosted-checkout-redirect. Identical shape
 * to src/purchase/flutterwave-client.interface.ts — see that file's doc
 * comment for the full rationale. Duplicated locally per this build's scope
 * boundary (one resource, one directory, no cross-resource imports).
 */

export interface FlutterwaveChargeInit {
  txRef: string;
  amount: number;
  currency: 'NGN';
  publicKey: string;
}

export interface FlutterwaveVerifyResult {
  status: 'successful' | 'failed';
  amount: number;
  currency: string;
  txRef: string;
  transactionId: string;
}

export interface InitChargeParams {
  amount: number;
  purpose: string;
  wawuUserId: string;
}

export interface VerifyChargeParams {
  transactionId: string;
  txRef: string;
}

export interface RefundChargeParams {
  /** Flutterwave's own numeric transaction id — NOT tx_ref. Their refund
   *  endpoint is keyed by id, which is why DirectMessage now stores it. */
  transactionId: string;
  /** Naira. Flutterwave supports partial refunds; a paid DM is always full. */
  amount: number;
}

/**
 * `submitted` is a real and distinct outcome, not a nicety: Flutterwave
 * accepts a refund and settles it asynchronously, so a 200 from their API
 * means "we have it", not "the payer has their money". Collapsing it into
 * `settled` is how a system ends up telling someone their refund arrived
 * before it has. The webhook, or a later poll, moves it to `settled`.
 */
export interface FlutterwaveRefundResult {
  status: 'settled' | 'submitted' | 'failed';
  /** Flutterwave's refund id, where they returned one. */
  reference: string | null;
  /** Their failure text, kept verbatim for whoever works the finance queue. */
  message: string | null;
  /** True when retrying cannot help — already refunded, or not refundable.
   *  Distinguishes "give up and escalate" from "try again in ten minutes". */
  permanent: boolean;
}

export interface FlutterwaveClient {
  initCharge(params: InitChargeParams): FlutterwaveChargeInit;
  verifyCharge(params: VerifyChargeParams): Promise<FlutterwaveVerifyResult>;
  refundCharge(params: RefundChargeParams): Promise<FlutterwaveRefundResult>;
}

/** DI token — swapped between RealFlutterwaveAdapter and MockFlutterwaveAdapter in DirectMessageModule. */
export const FLUTTERWAVE_CLIENT = Symbol('FLUTTERWAVE_CLIENT');

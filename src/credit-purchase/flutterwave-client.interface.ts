/**
 * FlutterwaveClient — injectable boundary around the Flutterwave v3 REST API.
 * This is a directory-local copy of the pattern established by Purchase
 * (src/purchase/flutterwave-client.interface.ts, wave 0) — that token is
 * scoped to Purchase's own module and not a shared export yet (per its own
 * doc comment), and this build's scope rules forbid editing any directory
 * but `src/credit-purchase/`, so CreditPurchase gets its own copy of the
 * same shapes/pattern rather than inventing a different one.
 *
 * Pattern: client-charge + server-verify (conventions.md § Third-party
 * integrations › Flutterwave), NOT hosted-checkout-redirect.
 * - `initCharge`: server generates a `tx_ref` and returns the config the
 *   client's inline Flutterwave JS SDK needs to charge directly. `amount` is
 *   ALWAYS looked up server-side from the pack->amount table before this is
 *   called — never accepted from the client as the charged amount.
 * - `verifyCharge`: after the client reports a charge attempt, the server
 *   calls Flutterwave's `GET /v3/transactions/:id/verify` (real adapter) to
 *   authoritatively confirm the charge before trusting it. Never trust a
 *   client-echoed success.
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

export interface FlutterwaveClient {
  initCharge(params: InitChargeParams): FlutterwaveChargeInit;
  verifyCharge(params: VerifyChargeParams): Promise<FlutterwaveVerifyResult>;
}

/** DI token — swapped between RealFlutterwaveAdapter and MockFlutterwaveAdapter in CreditPurchaseModule. */
export const FLUTTERWAVE_CLIENT = Symbol('CREDIT_PURCHASE_FLUTTERWAVE_CLIENT');

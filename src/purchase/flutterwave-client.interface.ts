/**
 * FlutterwaveClient — injectable boundary around the Flutterwave v3 REST API,
 * scoped to Purchase's own directory (task brief: DirectMessage /
 * CreatorSubscription / CreditPurchase are later waves and build their own,
 * or reuse this pattern; this is not a shared global yet).
 *
 * Pattern: client-charge + server-verify (conventions.md § Third-party
 * integrations › Flutterwave), NOT hosted-checkout-redirect.
 * - `initCharge`: server generates a `tx_ref` and returns the config the
 *   client's inline Flutterwave JS SDK needs to charge directly. `amount` is
 *   ALWAYS looked up/validated server-side before this is called — never
 *   accepted from the client as the charged amount. This step makes no
 *   network call to Flutterwave in either adapter; Flutterwave's own
 *   inline-checkout flow is what actually moves money, entirely client-side.
 * - `verifyCharge`: after the client reports a charge attempt, the server
 *   calls Flutterwave's `GET /v3/transactions/:id/verify` (real adapter) to
 *   authoritatively confirm the charge before trusting it. Never trust a
 *   client-echoed success (conventions.md, repeated deliberately).
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

/** DI token — swapped between RealFlutterwaveAdapter and MockFlutterwaveAdapter in PurchaseModule. */
export const FLUTTERWAVE_CLIENT = Symbol('FLUTTERWAVE_CLIENT');

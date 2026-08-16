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

export interface FlutterwaveClient {
  initCharge(params: InitChargeParams): FlutterwaveChargeInit;
  verifyCharge(params: VerifyChargeParams): Promise<FlutterwaveVerifyResult>;
}

/** DI token — swapped between RealFlutterwaveAdapter and MockFlutterwaveAdapter in DirectMessageModule. */
export const FLUTTERWAVE_CLIENT = Symbol('FLUTTERWAVE_CLIENT');

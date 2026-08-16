/**
 * FlutterwaveClient — injectable boundary around the Flutterwave v3 REST
 * API, scoped to ContentPiece's own directory. Mirrors src/purchase's
 * interface of the same shape verbatim (task brief: "reuse the SAME
 * approach for ContentPiece's own unlock/verify flow rather than inventing
 * a new one") — kept as ContentPiece's own local copy rather than importing
 * Purchase's file directly, since build agents may only create/edit files
 * inside their own resource directory (task brief § SCOPE) and Purchase's
 * directory is read-only reference material, not a shared module.
 *
 * Pattern: client-charge + server-verify (conventions.md § Third-party
 * integrations › Flutterwave), NOT hosted-checkout-redirect.
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

/** DI token — swapped between RealFlutterwaveAdapter and MockFlutterwaveAdapter in ContentPieceModule. */
export const FLUTTERWAVE_CLIENT = Symbol('CONTENT_PIECE_FLUTTERWAVE_CLIENT');

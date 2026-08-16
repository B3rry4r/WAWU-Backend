import { Injectable } from '@nestjs/common';
import type {
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwaveVerifiedTransaction,
} from './flutterwave-client.interface';

/** transaction_id magic value a contract test can send to deterministically exercise the failed-verification path. */
export const MOCK_FLUTTERWAVE_FAIL_TXN_ID = 'MOCK_TXN_FAIL';

/**
 * Deterministic in-memory stand-in for FlutterwaveClient, used whenever real
 * Flutterwave test-mode keys aren't configured (service-application.module.ts
 * env-gate) — this is the case in every local/CI run of this sandbox
 * (conventions.md § Local test environment). Simulates a successful charge
 * by default; a test can force a simulated failed verification by sending
 * `transaction_id: MOCK_FLUTTERWAVE_FAIL_TXN_ID`.
 */
@Injectable()
export class MockFlutterwaveAdapter implements FlutterwaveClient {
  private readonly pending = new Map<string, { amount: number; currency: string }>();

  initCharge(params: { txRef: string; amount: number; currency: string }): Promise<FlutterwaveChargeInit> {
    this.pending.set(params.txRef, { amount: params.amount, currency: params.currency });
    return Promise.resolve({
      txRef: params.txRef,
      amount: params.amount,
      currency: params.currency,
      publicKey: 'FLWPUBK_TEST-mock-not-real',
    });
  }

  verifyCharge(params: { transactionId: string; txRef: string }): Promise<FlutterwaveVerifiedTransaction> {
    const charge = this.pending.get(params.txRef);
    if (!charge) {
      return Promise.resolve({ status: 'failed', amount: 0, currency: 'NGN', txRef: params.txRef });
    }
    if (params.transactionId === MOCK_FLUTTERWAVE_FAIL_TXN_ID) {
      return Promise.resolve({ status: 'failed', amount: charge.amount, currency: charge.currency, txRef: params.txRef });
    }
    return Promise.resolve({
      status: 'successful',
      amount: charge.amount,
      currency: charge.currency,
      txRef: params.txRef,
    });
  }
}

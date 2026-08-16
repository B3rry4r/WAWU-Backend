import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type {
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwaveVerifyResult,
  InitChargeParams,
  VerifyChargeParams,
} from './flutterwave-client.interface';

/**
 * Deterministic Flutterwave test double (conventions.md § Local test
 * environment — no real Flutterwave test-mode credentials available in this
 * sandbox). Mirrors src/purchase/mock-flutterwave.adapter.ts's precedent
 * exactly. Used by contract tests via DirectMessageModule's DI-token swap.
 *
 * Determinism contract for callers/tests:
 * - `initCharge` mints a `tx_ref` and remembers the amount it was opened
 *   for, exactly like Flutterwave remembers a transaction server-side.
 * - `verifyCharge` returns a successful result IFF `txRef` matches a
 *   previously-initialized charge AND `transactionId` is not the reserved
 *   failure sentinel (`MOCK_FAILURE_TRANSACTION_ID`) — lets tests exercise
 *   both the happy path and an authoritative Flutterwave-side failure
 *   without any network call.
 */
export const MOCK_FAILURE_TRANSACTION_ID = 'mock-flw-tx-fail';

@Injectable()
export class MockFlutterwaveAdapter implements FlutterwaveClient {
  private readonly initializedCharges = new Map<
    string,
    { amount: number; currency: 'NGN' }
  >();

  initCharge(params: InitChargeParams): FlutterwaveChargeInit {
    const txRef = `mock-${randomUUID()}`;
    this.initializedCharges.set(txRef, {
      amount: params.amount,
      currency: 'NGN',
    });
    return {
      txRef,
      amount: params.amount,
      currency: 'NGN',
      publicKey: 'FLWPUBK_TEST-mock0000000000000000000000-X',
    };
  }

  async verifyCharge(
    params: VerifyChargeParams,
  ): Promise<FlutterwaveVerifyResult> {
    const initialized = this.initializedCharges.get(params.txRef);

    if (params.transactionId === MOCK_FAILURE_TRANSACTION_ID || !initialized) {
      return {
        status: 'failed',
        amount: 0,
        currency: 'NGN',
        txRef: params.txRef,
        transactionId: params.transactionId,
      };
    }

    return {
      status: 'successful',
      amount: initialized.amount,
      currency: initialized.currency,
      txRef: params.txRef,
      transactionId: params.transactionId,
    };
  }
}

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
 * sandbox). Used by contract tests via ContentPieceModule's DI-token swap.
 * Mirrors src/purchase/mock-flutterwave.adapter.ts's determinism contract.
 */
export const MOCK_FAILURE_TRANSACTION_ID = 'mock-flw-tx-fail';

@Injectable()
export class MockFlutterwaveAdapter implements FlutterwaveClient {
  private readonly initializedCharges = new Map<
    string,
    { amount: number; currency: 'NGN' }
  >();

  initCharge(params: InitChargeParams): FlutterwaveChargeInit {
    const txRef = `mock-content-${randomUUID()}`;
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

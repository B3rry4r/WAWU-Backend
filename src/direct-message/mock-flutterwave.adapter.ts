import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type {
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwaveRefundResult,
  FlutterwaveVerifyResult,
  InitChargeParams,
  RefundChargeParams,
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

/** Refund is refused, but retrying might work — a 5xx or a network blip. */
export const MOCK_REFUND_RETRYABLE_TRANSACTION_ID = 'mock-flw-refund-retry';
/** Refund is refused for good — already refunded, or not refundable. */
export const MOCK_REFUND_PERMANENT_TRANSACTION_ID = 'mock-flw-refund-nope';
/** Refund is accepted but not yet settled, which is Flutterwave's norm. */
export const MOCK_REFUND_PENDING_TRANSACTION_ID = 'mock-flw-refund-pending';

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

  /**
   * Refunds succeed by default; three sentinel transaction ids expose the
   * outcomes that actually need testing. `submitted` is one of them because
   * it is Flutterwave's normal answer, not an edge case, and the whole point
   * of this change is that the payer is not told anything until it settles.
   */
  async refundCharge(
    params: RefundChargeParams,
  ): Promise<FlutterwaveRefundResult> {
    if (params.transactionId === MOCK_REFUND_RETRYABLE_TRANSACTION_ID) {
      return {
        status: 'failed',
        reference: null,
        message: 'Flutterwave is temporarily unavailable',
        permanent: false,
      };
    }
    if (params.transactionId === MOCK_REFUND_PERMANENT_TRANSACTION_ID) {
      return {
        status: 'failed',
        reference: null,
        message: 'Transaction has already been refunded',
        permanent: true,
      };
    }
    // A refund id is unique PER REFUND, not per transaction — that is what
    // Flutterwave returns, and the webhook path looks a DM up by it. A mock
    // that reuses one id across refunds lets a webhook settle the wrong
    // payer's message, which is a bug the mock would otherwise hide.
    const reference = `mock-refund-${randomUUID()}`;

    if (params.transactionId === MOCK_REFUND_PENDING_TRANSACTION_ID) {
      return { status: 'submitted', reference, message: null, permanent: false };
    }
    return { status: 'settled', reference, message: null, permanent: false };
  }
}

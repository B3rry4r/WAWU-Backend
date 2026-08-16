import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { CreatorTier } from '../../generated/prisma/enums';
import type {
  ChargeSavedCardParams,
  ChargeSavedCardResult,
  CreateOrReusePlanParams,
  FlutterwaveChargeInit,
  FlutterwaveClient,
  FlutterwavePlan,
  FlutterwaveVerifyResult,
  InitChargeParams,
  VerifyChargeParams,
} from './flutterwave-client.interface';

/**
 * Deterministic Flutterwave test double (conventions.md § Local test
 * environment — no real Flutterwave test-mode credentials available in this
 * sandbox). Mirrors src/purchase/mock-flutterwave.adapter.ts's determinism
 * contract, extended for Payment Plans + saved-card recurring charges.
 *
 * Reserved sentinels for exercising failure paths from contract tests
 * without any network call:
 * - `transactionId === MOCK_FAILURE_TRANSACTION_ID` -> verifyCharge fails.
 * - `flutterwaveCustomerRef === MOCK_RETRY_FAILURE_CUSTOMER_REF` ->
 *   chargeSavedCard fails (simulates a still-declining card on retry).
 */
export const MOCK_FAILURE_TRANSACTION_ID = 'mock-flw-tx-fail';
export const MOCK_RETRY_FAILURE_CUSTOMER_REF = 'mock-flw-customer-retry-fails';
export const MOCK_PUBLIC_KEY = 'FLWPUBK_TEST-mock0000000000000000000000-X';
/** Deterministic fake — every mock-verified card charge "ends in" this. */
const MOCK_CARD_LAST4 = '4242';

@Injectable()
export class MockFlutterwaveAdapter implements FlutterwaveClient {
  private readonly initializedCharges = new Map<
    string,
    { amount: number; currency: 'NGN' }
  >();

  /** Simulates the "cache/reuse the plan id" requirement — one Plan per tier, created at most once per process. */
  private readonly plansByTier = new Map<CreatorTier, string>();

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
      publicKey: MOCK_PUBLIC_KEY,
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
      cardLast4: MOCK_CARD_LAST4,
    };
  }

  async createOrReusePlan(
    params: CreateOrReusePlanParams,
  ): Promise<FlutterwavePlan> {
    const existing = this.plansByTier.get(params.tier);
    if (existing) {
      return { planId: existing };
    }
    // Simulates the one-time "create Plan" Flutterwave call — deterministic
    // id, not a real network call, per the mock-adapter contract.
    const planId = `mock-flw-plan-${params.tier}`;
    this.plansByTier.set(params.tier, planId);
    return { planId };
  }

  async chargeSavedCard(
    params: ChargeSavedCardParams,
  ): Promise<ChargeSavedCardResult> {
    const txRef = `mock-retry-${randomUUID()}`;
    if (params.flutterwaveCustomerRef === MOCK_RETRY_FAILURE_CUSTOMER_REF) {
      return {
        status: 'failed',
        txRef,
        transactionId: `mock-retry-tx-${randomUUID()}`,
        amount: 0,
        currency: 'NGN',
        publicKey: MOCK_PUBLIC_KEY,
      };
    }
    return {
      status: 'successful',
      txRef,
      transactionId: `mock-retry-tx-${randomUUID()}`,
      amount: params.amount,
      currency: 'NGN',
      publicKey: MOCK_PUBLIC_KEY,
    };
  }
}

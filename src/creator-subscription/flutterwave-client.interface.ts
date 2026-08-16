import type { CreatorTier } from '../../generated/prisma/enums';

/**
 * FlutterwaveClient — injectable boundary around Flutterwave's v3 REST API,
 * scoped to CreatorSubscription's own directory (task brief § SCOPE: every
 * resource builds its own copy of this pattern; not a shared global yet —
 * see src/purchase/flutterwave-client.interface.ts for the precedent this
 * mirrors).
 *
 * This resource extends the base client-charge + server-verify pattern
 * (conventions.md § Third-party integrations › Flutterwave) with two more
 * methods needed by Flutterwave's Payment Plans API (recurring billing):
 *
 * - `createOrReusePlan`: Flutterwave's Payment Plans API
 *   (`POST /v3/payment-plans`) creates a Plan (amount + interval) that a
 *   customer is then subscribed to via a normal charge referencing
 *   `payment_plan`. There is nowhere in the frozen CreatorSubscription
 *   model to persist a single canonical "the Basic plan id" / "the Pro plan
 *   id" outside of a specific creator's own row (no dedicated Plan table —
 *   schema is frozen), so this client caches the two tier plan ids
 *   in-memory for the adapter's process lifetime and only calls Flutterwave
 *   to create one the first time a given tier is needed. This satisfies the
 *   task brief's "cache/reuse the plan id rather than creating a new Plan
 *   every call" for the lifetime of a running server process; a durable
 *   cross-restart cache would need a schema column, which is out of scope
 *   here (frozen schema).
 * - `chargeSavedCard`: used only by POST /creator-subscription/retry-payment.
 *   Unlike subscribe/upgrade (client enters/confirms a card via the inline
 *   SDK, then the server verifies), a *retry* reuses the card already on
 *   file (`CreatorSubscription.cardLast4` / `flutterwaveCustomerRef`) — the
 *   whole point of retrying is that the creator does NOT have to re-enter
 *   card details. This is modeled as a synchronous server-initiated charge
 *   (conceptually Flutterwave's tokenized-charge API,
 *   `POST /v3/tokenized-charges/{token}`), resolving success/failure in the
 *   same request rather than requiring a follow-up /verify call.
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
  /**
   * Present on a successful charge — Flutterwave's real
   * `GET /v3/transactions/:id/verify` response includes `data.card.last_4digits`
   * for card charges. Optional because the mock adapter's failure path (and,
   * in principle, non-card payment methods) has none.
   */
  cardLast4?: string;
}

export interface InitChargeParams {
  amount: number;
  purpose: string;
  wawuUserId: string;
  /** The Payment Plan this charge subscribes the customer to (Payment Plans API). */
  planId?: string;
}

export interface VerifyChargeParams {
  transactionId: string;
  txRef: string;
}

export interface CreateOrReusePlanParams {
  tier: CreatorTier;
  /** Annual price for this tier, naira — used only the first time the plan is created. */
  amount: number;
}

export interface FlutterwavePlan {
  planId: string;
}

export interface ChargeSavedCardParams {
  /** The customer reference Flutterwave assigned when the card was first saved. */
  flutterwaveCustomerRef: string | null;
  amount: number;
  purpose: string;
}

export interface ChargeSavedCardResult {
  status: 'successful' | 'failed';
  txRef: string;
  transactionId: string;
  amount: number;
  currency: string;
  publicKey: string;
}

export interface FlutterwaveClient {
  initCharge(params: InitChargeParams): FlutterwaveChargeInit;
  verifyCharge(params: VerifyChargeParams): Promise<FlutterwaveVerifyResult>;
  createOrReusePlan(params: CreateOrReusePlanParams): Promise<FlutterwavePlan>;
  chargeSavedCard(
    params: ChargeSavedCardParams,
  ): Promise<ChargeSavedCardResult>;
}

/** DI token — swapped between RealFlutterwaveAdapter and MockFlutterwaveAdapter in CreatorSubscriptionModule. */
export const FLUTTERWAVE_CLIENT = Symbol('FLUTTERWAVE_CLIENT');

import type {
  VerificationKindValue,
  VerificationState,
} from '../common/verification/verification-state';

/**
 * The wire shapes for the paid two-tick surface.
 *
 * DECLARED, never a bare re-export of a Prisma model, for the same reason
 * `event-view.type.ts` gives: a column added to `VerificationPurchase`
 * tomorrow reaches the wire only if somebody adds it here on purpose. That
 * matters more here than most places, because these rows carry payment
 * references.
 */

/** What both ticks cost. Naira, whole numbers, by the year. */
export interface VerificationPricingView {
  creator: number;
  professional: number;
  currency: 'NGN';
  termMonths: 12;
}

/**
 * Whether this account may buy a given tick, and if not, why not.
 *
 * `reason` is written for a person to read, because the app shows it. It is
 * null when `allowed` is true.
 */
export interface TickPurchaseEligibility {
  kind: VerificationKindValue;
  allowed: boolean;
  priceNgn: number;
  reason: string | null;
}

/** GET /verification/me - the caller's own ticks and what they may buy. */
export interface MyVerificationView {
  verification: VerificationState;
  pricing: VerificationPricingView;
  eligibility: TickPurchaseEligibility[];
}

/**
 * What the app hands the Flutterwave inline SDK. Same four fields every other
 * paid action in this backend returns, so the client's checkout code is one
 * function rather than one per product.
 */
export interface VerificationCheckoutView {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
  /** Echoed so the confirm screen can quote the price without a second call. */
  kind: VerificationKindValue;
  priceNgn: number;
}

/** What a settled purchase returns: the tick, live, as everyone else will see it. */
export interface VerificationGrantView {
  kind: VerificationKindValue;
  verification: VerificationState;
}

/**
 * WHY SOMEBODY WAS REFUSED, IN A SHAPE THE APP CAN ACT ON.
 *
 * A bare 403 tells a person they cannot do something and nothing else, so the
 * screen has to guess the remedy and usually guesses a dead end. This says
 * what is missing and what would fix it, which is what turns a refusal into a
 * path rather than a wall.
 *
 * `code` is for the client to branch on; `message` and `steps` are read by a
 * person, so neither may contain an em-dash.
 */
export interface IneligibilityReason {
  code:
    | 'verification_required'
    | 'account_type_required'
    | 'already_verified'
    | 'professional_profile_required';
  /** One sentence, for a person. */
  message: string;
  /** What they would have to do, in order. Rendered as a list. */
  steps: string[];
  /** What they could buy to become eligible, with today's prices. */
  purchasable: Array<{
    kind: VerificationKindValue;
    priceNgn: number;
    currency: 'NGN';
    termMonths: 12;
  }>;
}

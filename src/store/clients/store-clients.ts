import type { StorePlatform } from '../../../generated/prisma/enums';

/** The Nest tokens the two store clients are provided under. */
export const GOOGLE_PLAY_CLIENT = 'GOOGLE_PLAY_CLIENT';
export const APP_STORE_CLIENT = 'APP_STORE_CLIENT';

/**
 * One purchase as a store's own server vouches for it (task IAP-01, R-86).
 * Both stores are reduced to this one shape so the grant, the take-back and the
 * tests do not care which store spoke. A client builds it only from an answer
 * it has checked: Google over HTTPS as the Hub's service account, Apple only
 * from a signed answer whose certificate chain ends in Apple's root.
 */
export interface VerifiedStorePurchase {
  platform: StorePlatform;
  environment: 'production' | 'sandbox';
  /** The id the store sold it under. */
  storeProductId: string;
  /**
   * The store's id for THIS transaction: Apple's transactionId; Google's
   * orderId (a renewal has its own). A one-time Google purchase with no order
   * id is keyed by its purchase token.
   */
  storeTransactionId: string;
  /** Ties a subscription's renewals together (Apple's originalTransactionId; Google's purchase token). Null for a one-time product. */
  subscriptionKey: string | null;
  purchasedAt: Date;
  /** When the paid period ends; null for a one-time product. */
  expiresAt: Date | null;
  /** In the buyer's own currency, as the store charged it (display only). */
  currency: string | null;
  priceMicros: bigint | null;
  /**
   * `purchased`: paid and in force. `pending`: not paid yet. `cancelled`: the
   * store says it was cancelled before it was paid. `refunded`: paid back or
   * revoked by the store.
   */
  state: 'purchased' | 'pending' | 'cancelled' | 'refunded';
  /** True when the store still wants the purchase acknowledged or consumed. */
  needsAcknowledge: boolean;
}

export interface GooglePlayClient {
  /** A one-time product (points, credits): Google's `purchases.products.get`. */
  verifyOneTime(
    storeProductId: string,
    purchaseToken: string,
  ): Promise<VerifiedStorePurchase>;
  /** A subscription (tier, pass): Google's `purchases.subscriptionsv2.get`. */
  verifySubscription(purchaseToken: string): Promise<VerifiedStorePurchase>;
  /** Consumes a one-time product so it can be bought again (this acknowledges it too). */
  consume(storeProductId: string, purchaseToken: string): Promise<void>;
  /** Acknowledges a subscription (Google refunds an unacknowledged purchase after three days). */
  acknowledgeSubscription(
    storeProductId: string,
    purchaseToken: string,
  ): Promise<void>;
  /**
   * Checks the bearer token Pub/Sub puts on a push: Google signed it, for this
   * endpoint's audience, as the subscription's service account. Throws
   * `GooglePushRefused` when it is not.
   */
  verifyPushToken(authorization: string | undefined): Promise<void>;
}

/** A Pub/Sub push whose token is missing or wrong. */
export class GooglePushRefused extends Error {
  constructor(
    message = 'The push token is not one Google signed for this endpoint.',
  ) {
    super(message);
    this.name = 'GooglePushRefused';
  }
}

/** A store answer that says the purchase is not known or not for this app. */
export class StorePurchaseNotFound extends Error {
  constructor(message = 'The store does not know that purchase.') {
    super(message);
    this.name = 'StorePurchaseNotFound';
  }
}

/** The store could not be reached or answered something unusable. */
export class StoreUnreachable extends Error {
  constructor(message = 'The store could not be reached.') {
    super(message);
    this.name = 'StoreUnreachable';
  }
}

/** What an App Store Server Notification V2 says, once its signatures are checked. */
export interface AppStoreNotification {
  /** Apple's notificationUUID: unique per notification. */
  notificationId: string;
  /** SUBSCRIBED, DID_RENEW, EXPIRED, REFUND, REVOKE, and so on. */
  type: string;
  subtype: string | null;
  environment: 'production' | 'sandbox';
  /** The transaction the notification is about; null for a notification with none (TEST). */
  transaction: VerifiedStorePurchase | null;
}

export interface AppStoreClient {
  /** One transaction by id: Apple's `getTransactionInfo`, its signed answer checked. */
  verifyTransaction(transactionId: string): Promise<VerifiedStorePurchase>;
  /** Checks a V2 notification's signed payload and the signed transaction inside it. */
  decodeNotification(signedPayload: string): Promise<AppStoreNotification>;
}

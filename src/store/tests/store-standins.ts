import type {
  AppStoreClient,
  AppStoreNotification,
  GooglePlayClient,
  VerifiedStorePurchase,
} from '../clients/store-clients';
import {
  GooglePushRefused,
  StorePurchaseNotFound,
  StoreUnreachable,
} from '../clients/store-clients';

/**
 * Stand-ins for the two stores' servers (task IAP-01): in-memory, answering from
 * what a test put in them. They stand where Google's API and Apple's API and
 * signature check stand; the real adapters are tested against a local HTTP
 * stand-in (google-play.client.spec.ts) and Apple's library.
 */
export class StandInGooglePlay implements GooglePlayClient {
  /** purchase token -> what Google would say of a one-time product. */
  oneTime = new Map<string, VerifiedStorePurchase>();
  /** purchase token -> what Google would say of a subscription. */
  subscriptions = new Map<string, VerifiedStorePurchase>();
  consumed: string[] = [];
  acknowledged: string[] = [];
  /** The bearer token the stand-in's Pub/Sub accepts. */
  pushToken = 'stand-in-pubsub-token';
  unreachable = false;
  failAcknowledge = false;

  verifyOneTime(
    storeProductId: string,
    purchaseToken: string,
  ): Promise<VerifiedStorePurchase> {
    if (this.unreachable) return Promise.reject(new StoreUnreachable());
    const p = this.oneTime.get(purchaseToken);
    if (!p || p.storeProductId !== storeProductId)
      return Promise.reject(new StorePurchaseNotFound());
    return Promise.resolve(p);
  }

  verifySubscription(purchaseToken: string): Promise<VerifiedStorePurchase> {
    if (this.unreachable) return Promise.reject(new StoreUnreachable());
    const p = this.subscriptions.get(purchaseToken);
    if (!p) return Promise.reject(new StorePurchaseNotFound());
    return Promise.resolve(p);
  }

  consume(_storeProductId: string, purchaseToken: string): Promise<void> {
    if (this.failAcknowledge) return Promise.reject(new StoreUnreachable());
    this.consumed.push(purchaseToken);
    return Promise.resolve();
  }

  acknowledgeSubscription(
    _storeProductId: string,
    purchaseToken: string,
  ): Promise<void> {
    if (this.failAcknowledge) return Promise.reject(new StoreUnreachable());
    this.acknowledged.push(purchaseToken);
    return Promise.resolve();
  }

  verifyPushToken(authorization: string | undefined): Promise<void> {
    return authorization === `Bearer ${this.pushToken}`
      ? Promise.resolve()
      : Promise.reject(new GooglePushRefused());
  }
}

export class StandInAppStore implements AppStoreClient {
  /** transactionId -> what Apple would say of it. */
  transactions = new Map<string, VerifiedStorePurchase>();
  /** signedPayload -> the notification Apple's check would decode. */
  notifications = new Map<string, AppStoreNotification>();
  unreachable = false;

  verifyTransaction(transactionId: string): Promise<VerifiedStorePurchase> {
    if (this.unreachable) return Promise.reject(new StoreUnreachable());
    const t = this.transactions.get(transactionId);
    return t ? Promise.resolve(t) : Promise.reject(new StorePurchaseNotFound());
  }

  decodeNotification(signedPayload: string): Promise<AppStoreNotification> {
    if (this.unreachable) return Promise.reject(new StoreUnreachable());
    const n = this.notifications.get(signedPayload);
    // A payload Apple's check would refuse (wrong chain, bundle or environment).
    return n
      ? Promise.resolve(n)
      : Promise.reject(new Error('not signed by Apple'));
  }
}

const DAY = 86_400_000;

/** A verified Google/Apple purchase with sensible defaults. */
export function verified(
  over: Partial<VerifiedStorePurchase> &
    Pick<
      VerifiedStorePurchase,
      'platform' | 'storeProductId' | 'storeTransactionId'
    >,
): VerifiedStorePurchase {
  return {
    environment: 'production',
    subscriptionKey: null,
    purchasedAt: new Date(),
    expiresAt: null,
    currency: 'USD',
    priceMicros: 4_990_000n,
    state: 'purchased',
    needsAcknowledge: false,
    ...over,
  };
}

export const inDays = (n: number): Date => new Date(Date.now() + n * DAY);

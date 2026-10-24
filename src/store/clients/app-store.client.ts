import { Injectable } from '@nestjs/common';
import {
  APIException,
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import type { AppStoreConfig } from '../store-config';
import {
  StorePurchaseNotFound,
  StoreUnreachable,
  type AppStoreClient,
  type AppStoreNotification,
  type VerifiedStorePurchase,
} from './store-clients';

/** A transaction Apple signed, once the library has verified and decoded it. */
type AppleTransaction = Awaited<
  ReturnType<SignedDataVerifier['verifyAndDecodeTransaction']>
>;

/** The environments the Hub reads, in the order it tries them. */
function environmentsOf(config: AppStoreConfig): Environment[] {
  // Apple's advice: a server in Production also accepts a Sandbox transaction
  // (App Review buys in the sandbox against the production build).
  return config.environment === 'Production'
    ? [Environment.PRODUCTION, Environment.SANDBOX]
    : [Environment.SANDBOX];
}

/**
 * The App Store Server API and Apple's signed answers (task IAP-01, R-86), on
 * Apple's own `@apple/app-store-server-library`.
 *
 * Nothing Apple signs is trusted until `SignedDataVerifier` has checked it: the
 * JWS's certificate chain must end in one of the root certificates the Hub was
 * given (`APPLE_ROOT_CERTIFICATES`), the bundle id and the environment must be
 * ours, and the leaf certificate's online revocation status is checked. A
 * transaction is read from Apple by id (never taken from the app's word), and
 * a notification's own signed transaction is verified the same way.
 *
 * The library is the only place Apple's formats are read.
 */
@Injectable()
export class RealAppStoreClient implements AppStoreClient {
  constructor(private readonly config: AppStoreConfig) {}

  private verifier(env: Environment): SignedDataVerifier {
    return new SignedDataVerifier(
      this.config.rootCertificates,
      true,
      env,
      this.config.bundleId,
      this.config.appAppleId ?? undefined,
    );
  }

  private api(env: Environment): AppStoreServerAPIClient {
    return new AppStoreServerAPIClient(
      this.config.privateKey,
      this.config.keyId,
      this.config.issuerId,
      this.config.bundleId,
      env,
    );
  }

  async verifyTransaction(
    transactionId: string,
  ): Promise<VerifiedStorePurchase> {
    let notFound = false;
    let unreachable = false;
    for (const env of environmentsOf(this.config)) {
      try {
        const answer = await this.api(env).getTransactionInfo(transactionId);
        if (!answer.signedTransactionInfo) {
          notFound = true;
          continue;
        }
        const decoded = await this.verifier(env).verifyAndDecodeTransaction(
          answer.signedTransactionInfo,
        );
        return purchaseOf(decoded, env);
      } catch (e) {
        if (e instanceof APIException) {
          // 404: Apple has no such transaction in this environment.
          if (e.httpStatusCode === 404) {
            notFound = true;
            continue;
          }
          unreachable = true;
          continue;
        }
        if (e instanceof VerificationException) {
          // Signed for another bundle, another environment, or by a chain we do
          // not trust: this is not a purchase of ours.
          if (e.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
            unreachable = true;
            continue;
          }
          notFound = true;
          continue;
        }
        unreachable = true;
      }
    }
    if (notFound && !unreachable) throw new StorePurchaseNotFound();
    throw new StoreUnreachable();
  }

  async decodeNotification(
    signedPayload: string,
  ): Promise<AppStoreNotification> {
    let refused: unknown = null;
    for (const env of environmentsOf(this.config)) {
      const verifier = this.verifier(env);
      let decoded;
      try {
        decoded = await verifier.verifyAndDecodeNotification(signedPayload);
      } catch (e) {
        if (
          e instanceof VerificationException &&
          e.status === VerificationStatus.INVALID_ENVIRONMENT
        ) {
          refused = e;
          continue;
        }
        if (
          e instanceof VerificationException &&
          e.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE
        )
          throw new StoreUnreachable();
        throw e;
      }
      let transaction: VerifiedStorePurchase | null = null;
      const signedTx = decoded.data?.signedTransactionInfo;
      if (signedTx) {
        transaction = purchaseOf(
          await verifier.verifyAndDecodeTransaction(signedTx),
          env,
        );
      }
      return {
        notificationId: decoded.notificationUUID ?? '',
        type: String(decoded.notificationType ?? ''),
        subtype: decoded.subtype ? String(decoded.subtype) : null,
        environment: env === Environment.PRODUCTION ? 'production' : 'sandbox',
        transaction,
      };
    }
    throw refused instanceof Error ? refused : new StoreUnreachable();
  }
}

/** A verified transaction as the Hub reads it. */
export function purchaseOf(
  t: AppleTransaction,
  env: Environment,
): VerifiedStorePurchase {
  if (!t.transactionId || !t.productId)
    throw new StorePurchaseNotFound('The transaction names no product.');
  const subscription =
    t.type === 'Auto-Renewable Subscription' ||
    t.type === 'Non-Renewing Subscription';
  const expiresAt =
    typeof t.expiresDate === 'number' ? new Date(t.expiresDate) : null;
  const revoked = typeof t.revocationDate === 'number';
  return {
    platform: 'ios',
    environment: env === Environment.PRODUCTION ? 'production' : 'sandbox',
    storeProductId: t.productId,
    storeTransactionId: t.transactionId,
    subscriptionKey: subscription ? (t.originalTransactionId ?? null) : null,
    purchasedAt: new Date(t.purchaseDate ?? Date.now()),
    expiresAt,
    currency: typeof t.currency === 'string' ? t.currency : null,
    // Apple's `price` is in milliunits of the currency: 1000 is one unit.
    priceMicros:
      typeof t.price === 'number' ? BigInt(Math.trunc(t.price)) * 1000n : null,
    state: revoked
      ? 'refunded'
      : expiresAt !== null && expiresAt.getTime() <= Date.now()
        ? 'cancelled'
        : 'purchased',
    needsAcknowledge: false,
  };
}

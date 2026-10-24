import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  StorePlatform,
  StorePurchase,
  StoreSubscription,
} from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import {
  APP_STORE_CLIENT,
  GOOGLE_PLAY_CLIENT,
  GooglePushRefused,
  StorePurchaseNotFound,
  StoreUnreachable,
  type AppStoreClient,
  type GooglePlayClient,
  type VerifiedStorePurchase,
} from './clients/store-clients';
import { StoreAccountService } from './store-account.service';
import { StoreCatalogService } from './store-catalog.service';
import { STORE_CONFIG, type StoreConfig } from './store-config';
import {
  GRANT_FAILED_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  StoreError,
  UNREACHABLE_MESSAGE,
} from './store-error';
import { StoreGrantService } from './store-grant.service';
import { StorePurchaseService, hashOf } from './store-purchase.service';
import type { StoreWebhookAck } from './store-view.type';

type Outcome =
  'granted' | 'taken_back' | 'lapsed' | 'ignored' | 'duplicate' | 'unknown';

/** Google's subscription notification types that matter here (Real-time developer notifications). */
const GOOGLE_SUB = {
  recovered: 1,
  renewed: 2,
  canceled: 3,
  purchased: 4,
  onHold: 5,
  inGrace: 6,
  restarted: 7,
  paused: 10,
  revoked: 12,
  expired: 13,
} as const;

interface GoogleEnvelope {
  message?: { data?: string; messageId?: string };
}

interface GoogleNotification {
  packageName?: string;
  testNotification?: object;
  subscriptionNotification?: {
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
  voidedPurchaseNotification?: {
    purchaseToken?: string;
    orderId?: string;
    productType?: number;
    refundType?: number;
  };
  oneTimeProductNotification?: object;
}

/**
 * What the stores tell the Hub on their own (task IAP-01, R-86): Google's
 * real-time developer notifications over a Pub/Sub push, Apple's App Store
 * Server Notifications V2. Renewals extend, refunds and revocations take back
 * what was granted, lapses end the subscription's standing.
 *
 * Nothing in a notification is believed on its own word. A Google push is
 * accepted only with a token Google signed for this endpoint, and what it says
 * is then asked of Google's API (the notification carries ids, not facts). An
 * Apple notification is accepted only when its signed payload, and the signed
 * transaction inside it, verify against Apple's root certificates.
 *
 * Refunds and revocations are applied even when a store is switched off or the
 * product has since been taken off sale: the money went back either way.
 * A notification already seen (Google's message id, Apple's notificationUUID)
 * is answered and not acted on twice, and every grant and take-back is
 * idempotent besides. A store that is down or unreachable is a 503 so the
 * store resends; anything the Hub cannot match to a purchase is `unknown` and
 * answered 200 (the app's own purchase call grants it when it arrives).
 */
@Injectable()
export class StoreNotificationService {
  private readonly logger = new Logger(StoreNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StoreCatalogService,
    private readonly accounts: StoreAccountService,
    private readonly purchases: StorePurchaseService,
    private readonly grants: StoreGrantService,
    @Inject(STORE_CONFIG) private readonly config: StoreConfig,
    @Optional()
    @Inject(GOOGLE_PLAY_CLIENT)
    private readonly google: GooglePlayClient | null,
    @Optional()
    @Inject(APP_STORE_CLIENT)
    private readonly apple: AppStoreClient | null,
  ) {}

  // -------------------------------------------------------------------------
  // Google Play
  // -------------------------------------------------------------------------

  async handleGoogle(
    authorization: string | undefined,
    body: unknown,
  ): Promise<StoreWebhookAck> {
    if (this.google === null || this.config.google === null)
      throw new StoreError('store_not_configured', NOT_CONFIGURED_MESSAGE);
    try {
      await this.google.verifyPushToken(authorization);
    } catch (e) {
      if (e instanceof GooglePushRefused) throw new UnauthorizedException();
      throw e;
    }
    const envelope = body as GoogleEnvelope | null;
    const messageId = envelope?.message?.messageId;
    const data = envelope?.message?.data;
    if (
      typeof messageId !== 'string' ||
      messageId === '' ||
      typeof data !== 'string'
    )
      throw new BadRequestException('Not a Pub/Sub push.');
    let note: GoogleNotification;
    try {
      note = JSON.parse(
        Buffer.from(data, 'base64').toString('utf8'),
      ) as GoogleNotification;
    } catch {
      throw new BadRequestException('Not a store notification.');
    }
    if (await this.seen('android', messageId)) return ack('duplicate');
    const kind = googleKind(note);
    let outcome: Outcome;
    if (note.packageName !== this.config.google.packageName)
      outcome = 'ignored';
    else outcome = await this.guarded(() => this.googleOutcome(note));
    await this.remember('android', messageId, kind, outcome);
    return ack(outcome);
  }

  private async googleOutcome(note: GoogleNotification): Promise<Outcome> {
    const sub = note.subscriptionNotification;
    if (sub?.purchaseToken) {
      const key = sub.purchaseToken;
      switch (sub.notificationType) {
        case GOOGLE_SUB.purchased:
        case GOOGLE_SUB.renewed:
        case GOOGLE_SUB.recovered:
        case GOOGLE_SUB.restarted:
        case GOOGLE_SUB.inGrace:
          return this.renewGoogle(key);
        case GOOGLE_SUB.revoked:
          return this.revokeLatest(
            'android',
            key,
            'revoked',
            'revoked_by_store',
          );
        case GOOGLE_SUB.expired:
        case GOOGLE_SUB.onHold:
        case GOOGLE_SUB.paused:
          return this.lapse('android', key);
        default:
          return 'ignored';
      }
    }
    const voided = note.voidedPurchaseNotification;
    if (voided && (voided.orderId || voided.purchaseToken)) {
      const found = await this.prisma.storePurchase.findFirst({
        where: {
          platform: 'android',
          OR: [
            ...(voided.orderId ? [{ storeTransactionId: voided.orderId }] : []),
            ...(voided.purchaseToken
              ? [{ storeTransactionId: voided.purchaseToken }]
              : []),
          ],
        },
      });
      if (found === null) return 'unknown';
      // refundType 1 is a full refund; anything else (a quantity-based or a chargeback) is a revocation.
      const status = voided.refundType === 1 ? 'refunded' : 'revoked';
      return (await this.takeBackPurchase(found, status, 'voided_by_store'))
        ? 'taken_back'
        : 'duplicate';
    }
    return 'ignored';
  }

  /** A subscription period renewed (or came back): ask Google, then grant the new period to the person who holds the subscription. */
  private async renewGoogle(token: string): Promise<Outcome> {
    const holder = await this.holderOf('android', token);
    if (holder === null) return 'unknown';
    if (this.google === null)
      throw new StoreError('store_not_configured', NOT_CONFIGURED_MESSAGE);
    let verified: VerifiedStorePurchase;
    try {
      verified = await this.google.verifySubscription(token);
    } catch (e) {
      if (e instanceof StorePurchaseNotFound) return 'unknown';
      throw e;
    }
    return this.grantRenewal(holder, verified);
  }

  // -------------------------------------------------------------------------
  // App Store
  // -------------------------------------------------------------------------

  async handleApple(body: unknown): Promise<StoreWebhookAck> {
    if (this.apple === null || this.config.apple === null)
      throw new StoreError('store_not_configured', NOT_CONFIGURED_MESSAGE);
    const signed = (body as { signedPayload?: unknown } | null)?.signedPayload;
    if (typeof signed !== 'string' || signed === '')
      throw new BadRequestException('Not an App Store notification.');
    let note;
    try {
      note = await this.apple.decodeNotification(signed);
    } catch (e) {
      if (e instanceof StoreUnreachable)
        throw new StoreError('store_unreachable', UNREACHABLE_MESSAGE);
      // A signature, a chain, a bundle id or an environment that is not ours.
      throw new UnauthorizedException();
    }
    if (
      note.notificationId !== '' &&
      (await this.seen('ios', note.notificationId))
    )
      return ack('duplicate');
    const outcome = await this.guarded(async (): Promise<Outcome> => {
      const t = note.transaction;
      if (t === null) return 'ignored';
      switch (note.type) {
        case 'SUBSCRIBED':
        case 'DID_RENEW':
        case 'OFFER_REDEEMED': {
          if (t.subscriptionKey === null) return 'ignored';
          const holder = await this.holderOf('ios', t.subscriptionKey);
          return holder === null ? 'unknown' : this.grantRenewal(holder, t);
        }
        case 'REFUND':
        case 'REVOKE': {
          const found = await this.prisma.storePurchase.findUnique({
            where: {
              platform_storeTransactionId: {
                platform: 'ios',
                storeTransactionId: t.storeTransactionId,
              },
            },
          });
          if (found === null) return 'unknown';
          return (await this.takeBackPurchase(
            found,
            note.type === 'REFUND' ? 'refunded' : 'revoked',
            note.type === 'REFUND' ? 'refunded_by_store' : 'revoked_by_store',
          ))
            ? 'taken_back'
            : 'duplicate';
        }
        case 'EXPIRED':
        case 'GRACE_PERIOD_EXPIRED':
          return t.subscriptionKey === null
            ? 'ignored'
            : this.lapse('ios', t.subscriptionKey);
        default:
          return 'ignored';
      }
    });
    if (note.notificationId !== '')
      await this.remember('ios', note.notificationId, note.type, outcome);
    return ack(outcome);
  }

  // -------------------------------------------------------------------------
  // Shared steps
  // -------------------------------------------------------------------------

  /**
   * Who holds a subscription: the person who first bought it, never the newest
   * purchase's buyer (IAP-01 fix round 1). A notice about a subscription goes to
   * its holder or to nobody.
   */
  private holderOf(
    platform: StorePlatform,
    subscriptionKey: string,
  ): Promise<StoreSubscription | null> {
    return this.prisma.storeSubscription.findUnique({
      where: { platform_subscriptionKey: { platform, subscriptionKey } },
    });
  }

  /** A new period of a subscription its holder has: granted to them, once per store transaction. */
  private async grantRenewal(
    holder: StoreSubscription,
    verified: VerifiedStorePurchase,
  ): Promise<Outcome> {
    if (verified.state !== 'purchased') return 'ignored';
    // The store says the period was bought for somebody else's account: not the holder's.
    if (!(await this.accounts.agrees(holder.wawuUserId, verified)))
      return 'ignored';
    const product = await this.catalog.productBy(
      holder.platform,
      verified.storeProductId,
    );
    if (product === null) return 'unknown';
    const settled = await this.purchases.settle({
      userId: holder.wawuUserId,
      product,
      verified,
      communityId: holder.communityId,
    });
    if (settled.alreadyGranted) return 'duplicate';
    // A resubscribe after a lapse puts the subscription back in force.
    if (holder.lapsedAt !== null)
      await this.prisma.storeSubscription.updateMany({
        where: { id: holder.id },
        data: { lapsedAt: null },
      });
    return 'granted';
  }

  /** Takes back the newest granted purchase of a subscription (the store withdrew it). */
  private async revokeLatest(
    platform: StorePlatform,
    key: string,
    status: 'refunded' | 'revoked',
    reason: string,
  ): Promise<Outcome> {
    const latest = await this.prisma.storePurchase.findFirst({
      where: { platform, subscriptionKey: key, status: 'granted' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (latest === null) return 'unknown';
    const done = await this.takeBackPurchase(latest, status, reason);
    // A revoked subscription is over: nothing more is coming from it.
    await this.prisma.storeSubscription.updateMany({
      where: { platform, subscriptionKey: key, lapsedAt: null },
      data: { lapsedAt: new Date() },
    });
    return done ? 'taken_back' : 'duplicate';
  }

  /**
   * Takes back one purchase, once: under the same lock a grant takes, the row
   * is read again and only a `granted` one is taken back, so a refund notice
   * twice, or racing the grant, takes back once.
   */
  async takeBackPurchase(
    purchase: StorePurchase,
    status: 'refunded' | 'revoked',
    reason: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-purchase:${purchase.platform}:${purchase.storeTransactionId}`}, 0))`;
      const row = await tx.storePurchase.findUnique({
        where: { id: purchase.id },
      });
      if (row === null || row.status !== 'granted') return false;
      const now = new Date();
      const taken = await this.grants.takeBack(tx, row, now);
      await tx.storePurchase.update({
        where: { id: row.id },
        data: {
          status,
          endedAt: now,
          endReason: reason,
          takenBack: taken as never,
        },
      });
      return true;
    });
  }

  /** A subscription ended (expired, on hold, paused): it will not renew, so its purchases are marked ended. What was granted runs to its own end. */
  private async lapse(platform: StorePlatform, key: string): Promise<Outcome> {
    const now = new Date();
    const { count } = await this.prisma.storePurchase.updateMany({
      where: {
        platform,
        subscriptionKey: key,
        status: 'granted',
        endedAt: null,
      },
      data: { endedAt: now, endReason: 'lapsed' },
    });
    const held = await this.prisma.storeSubscription.updateMany({
      where: { platform, subscriptionKey: key, lapsedAt: null },
      data: { lapsedAt: now },
    });
    return count > 0 || held.count > 0 ? 'lapsed' : 'unknown';
  }

  /** Runs a step; a store that cannot be reached is a 503 so the store sends the notification again. */
  private async guarded(run: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof StoreUnreachable)
        throw new StoreError('store_unreachable', UNREACHABLE_MESSAGE);
      if (e instanceof HttpException) throw e;
      // A fault on our side: named, logged by kind, and answered 500 so the
      // store sends the notice again (nothing is recorded as seen).
      this.logger.error(
        `store notification: it could not be applied (${e instanceof Error ? e.name : 'error'}); the store sends it again`,
      );
      throw new StoreError('store_grant_failed', GRANT_FAILED_MESSAGE);
    }
  }

  private async seen(
    platform: StorePlatform,
    externalId: string,
  ): Promise<boolean> {
    const row = await this.prisma.storeNotification.findUnique({
      where: { platform_externalId: { platform, externalId } },
      select: { id: true },
    });
    return row !== null;
  }

  private async remember(
    platform: StorePlatform,
    externalId: string,
    kind: string,
    outcome: Outcome,
  ): Promise<void> {
    try {
      await this.prisma.storeNotification.create({
        data: { platform, externalId, kind, outcome },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    this.logger.log(
      `store notification ${platform} ${hashOf(externalId)}: ${kind} -> ${outcome}`,
    );
  }
}

function ack(outcome: Outcome): StoreWebhookAck {
  return { received: true, outcome };
}

function googleKind(note: GoogleNotification): string {
  if (note.subscriptionNotification)
    return `subscription:${note.subscriptionNotification.notificationType ?? 'unknown'}`;
  if (note.voidedPurchaseNotification) return 'voided';
  if (note.oneTimeProductNotification) return 'one_time';
  if (note.testNotification) return 'test';
  return 'unknown';
}

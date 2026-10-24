import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { STORE_CONFIG, type StoreConfig } from './store-config';
import { StoreError } from './store-error';
import type { VerifiedStorePurchase } from './clients/store-clients';
import { isSubscriptionKind } from './store-grants';
import type { StoreProductKind } from '../../generated/prisma/enums';

/**
 * Binds a store purchase to the person who made it (task IAP-01, fix round 1).
 *
 * A Google purchase token or an Apple transaction id is not a secret: the app
 * shows it to the store's billing library, it passes through logs and receipts.
 * So the Hub never takes it as proof that a purchase is the caller's. Each
 * person has one stable random UUID, the `accountToken` `GET /store/products`
 * answers them (never their user id). The app hands it to the store when it
 * starts a purchase (Google `obfuscatedAccountIdAndroid`, Apple
 * `appAccountToken`); the store returns it on every answer about that
 * purchase; and the Hub refuses a purchase that carries another person's.
 *
 * A purchase that carries none is refused too, from the dated cutover
 * (`STORE_ACCOUNT_TOKEN_REQUIRED_FROM`): always for a subscription, and for a
 * pack bought on or after the date. A pack bought before it may carry none; its
 * only guard is then the once-only key on its transaction id.
 */
@Injectable()
export class StoreAccountService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORE_CONFIG) private readonly config: StoreConfig,
  ) {}

  /** The person's account token, made the first time it is asked for. */
  async tokenFor(wawuUserId: string): Promise<string> {
    const found = await this.prisma.storeAccountToken.findUnique({
      where: { wawuUserId },
    });
    if (found !== null) return found.token;
    try {
      const made = await this.prisma.storeAccountToken.create({
        data: { wawuUserId, token: randomUUID() },
      });
      return made.token;
    } catch (e) {
      // Two first asks at once: the other one made it.
      if (!isUniqueViolation(e)) throw e;
      const again = await this.prisma.storeAccountToken.findUniqueOrThrow({
        where: { wawuUserId },
      });
      return again.token;
    }
  }

  /**
   * Refuses a verified purchase that is not this person's: it carries another
   * account's token (`store_purchase_taken`), or none when one is required
   * (`store_account_token_missing`).
   */
  async assertBound(
    wawuUserId: string,
    kind: StoreProductKind,
    verified: VerifiedStorePurchase,
  ): Promise<void> {
    const mine = await this.tokenFor(wawuUserId);
    if (verified.accountToken !== null) {
      if (verified.accountToken.toLowerCase() !== mine.toLowerCase())
        throw new StoreError(
          'store_purchase_taken',
          'That purchase was made for another account.',
        );
      return;
    }
    const required =
      isSubscriptionKind(kind) ||
      verified.purchasedAt.getTime() >=
        this.config.accountTokenRequiredFrom.getTime();
    if (required)
      throw new StoreError(
        'store_account_token_missing',
        'This purchase was not tied to your account. Update the app and buy again, or contact support.',
      );
  }

  /** True when a purchase's token is the person's own, or the purchase carries none. */
  async agrees(
    wawuUserId: string,
    verified: VerifiedStorePurchase,
  ): Promise<boolean> {
    if (verified.accountToken === null) return true;
    const mine = await this.tokenFor(wawuUserId);
    return verified.accountToken.toLowerCase() === mine.toLowerCase();
  }
}

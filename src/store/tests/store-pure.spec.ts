// Pure checks for task IAP-01: the arithmetic of the store's share, the product
// map's rules, and the App Store adapter's reading of a transaction. No database.

import { Environment } from '@apple/app-store-server-library';
import { purchaseOf, RealAppStoreClient } from '../clients/app-store.client';
import { creatorShareOf, netOf } from '../store-grant.service';
import {
  checkProduct,
  isSubscriptionKind,
  resolveGrants,
} from '../store-grants';
import { StoreError } from '../store-error';
import { loadPlansConfig } from '../../plans/plans-config';

describe("IAP-01: WAWU's net after the store's share, and the creator's 85%", () => {
  it('the store takes its cut rounded up, so the net is never more than WAWU receives', () => {
    expect(netOf(100_000, 1500)).toBe(85_000);
    expect(netOf(100_000, 3000)).toBe(70_000);
    expect(netOf(100_001, 1500)).toBe(85_000); // cut 15000.15 -> 15001
    expect(netOf(1, 1500)).toBe(0);
    expect(netOf(100_000, 0)).toBe(100_000);
    expect(netOf(100_000, 10_000)).toBe(0);
  });

  it("the creator's share is 85% of the net, rounded down", () => {
    expect(creatorShareOf(170_000)).toBe(144_500);
    expect(creatorShareOf(0)).toBe(0);
    expect(creatorShareOf(1)).toBe(0);
    expect(creatorShareOf(7)).toBe(5);
    // 85/15 across the net: the two parts never add up to more than the net.
    for (const net of [1, 3, 99, 85_000, 170_001])
      expect(creatorShareOf(net)).toBeLessThanOrEqual(net);
  });
});

describe('IAP-01: the product map checks a grant against its kind and the plan', () => {
  const plans = loadPlansConfig();
  const none = { packId: null, pack: null, tierId: null, days: null };

  it('points need a pack of the plan and carry no reference', () => {
    const ok = checkProduct(
      'points',
      { ...none, packId: plans.packs[0].id },
      999,
      plans,
    );
    expect(ok).toEqual({
      grants: { ...none, packId: plans.packs[0].id },
      referenceKobo: null,
    });
    expect(() =>
      checkProduct('points', { ...none, packId: 'nope' }, null, plans),
    ).toThrow(StoreError);
    expect(() =>
      checkProduct(
        'points',
        { ...none, packId: plans.packs[0].id, days: 3 },
        null,
        plans,
      ),
    ).toThrow(/takes only "packId"/);
  });

  it('credits take a pack and default the reference to the wallet price', () => {
    expect(
      checkProduct('credits', { ...none, pack: 'starter' }, null, plans),
    ).toEqual({
      grants: { ...none, pack: 'starter' },
      referenceKobo: 50_000,
    });
    expect(
      checkProduct('credits', { ...none, pack: 'pro' }, 123_456, plans)
        .referenceKobo,
    ).toBe(123_456);
    expect(() => checkProduct('credits', none, null, plans)).toThrow(
      StoreError,
    );
  });

  it('a tier is the only subscription; a pass, like a pack, is bought once', () => {
    expect(isSubscriptionKind('tier')).toBe(true);
    for (const kind of ['points', 'credits', 'extra_products', 'pass'] as const)
      expect(isSubscriptionKind(kind)).toBe(false);
  });

  it('a tier needs a tier of the plan; a pass needs days and a reference', () => {
    expect(
      checkProduct('tier', { ...none, tierId: plans.tiers[0].id }, null, plans)
        .grants.tierId,
    ).toBe(plans.tiers[0].id);
    expect(() =>
      checkProduct('tier', { ...none, tierId: 'nope' }, null, plans),
    ).toThrow(StoreError);
    expect(checkProduct('pass', { ...none, days: 30 }, 5000, plans)).toEqual({
      grants: { ...none, days: 30 },
      referenceKobo: 5000,
    });
    expect(() =>
      checkProduct('pass', { ...none, days: 30 }, null, plans),
    ).toThrow(/worth/);
    expect(() =>
      checkProduct('pass', { ...none, days: 0 }, 5000, plans),
    ).toThrow(StoreError);
    expect(() =>
      checkProduct('pass', { ...none, days: 400 }, 5000, plans),
    ).toThrow(StoreError);
  });

  it('a product whose plan entry is gone resolves to nothing, so it is not shown', () => {
    expect(resolveGrants('points', { ...none, packId: 'gone' }, plans)).toEqual(
      { points: null, credits: null, tierId: null, days: null },
    );
    expect(
      resolveGrants('tier', { ...none, tierId: plans.tiers[0].id }, plans),
    ).toMatchObject({ tierId: plans.tiers[0].id, days: plans.tiers[0].days });
  });

  it('the messages a person may read carry no em-dash', () => {
    const messages: string[] = [];
    for (const f of [
      () => checkProduct('points', { ...none, packId: 'nope' }, null, plans),
      () => checkProduct('tier', { ...none, tierId: 'nope' }, null, plans),
      () => checkProduct('pass', { ...none, days: 0 }, 5, plans),
      () => checkProduct('credits', none, null, plans),
    ]) {
      try {
        f();
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(4);
    for (const m of messages) expect(m).not.toContain('—');
  });
});

describe('IAP-01: the App Store adapter reads a verified transaction', () => {
  const base = {
    transactionId: '2000000123',
    originalTransactionId: '2000000001',
    productId: 'wawu.tier.x',
    purchaseDate: Date.parse('2026-10-01T00:00:00Z'),
    currency: 'NGN',
    price: 4_500_500,
  };

  it('a subscription is keyed by its original transaction and has its expiry', () => {
    const expiry = Date.now() + 5 * 86_400_000;
    const p = purchaseOf(
      { ...base, type: 'Auto-Renewable Subscription', expiresDate: expiry },
      Environment.PRODUCTION,
    );
    expect(p).toMatchObject({
      platform: 'ios',
      environment: 'production',
      storeProductId: 'wawu.tier.x',
      storeTransactionId: '2000000123',
      subscriptionKey: '2000000001',
      state: 'purchased',
      currency: 'NGN',
      priceMicros: 4_500_500_000n,
    });
    expect(p.expiresAt?.getTime()).toBe(expiry);
  });

  it('a non-renewing subscription (a community pass, bought once) has no subscription key and no expiry of its own, whatever date Apple puts on it', () => {
    const p = purchaseOf(
      {
        ...base,
        productId: 'wawu.pass.30.a',
        type: 'Non-Renewing Subscription',
        // A past date must not read as "lapsed": its 30 days are the Hub's.
        expiresDate: Date.now() - 86_400_000,
      },
      Environment.PRODUCTION,
    );
    expect(p).toMatchObject({
      subscriptionKey: null,
      expiresAt: null,
      state: 'purchased',
      storeTransactionId: '2000000123',
    });
    expect(
      purchaseOf(
        {
          ...base,
          type: 'Non-Renewing Subscription',
          revocationDate: Date.now(),
        },
        Environment.PRODUCTION,
      ).state,
    ).toBe('refunded');
  });

  it('carries the appAccountToken the app bound the purchase to, or null', () => {
    expect(
      purchaseOf(
        {
          ...base,
          type: 'Consumable',
          appAccountToken: '7D1E5C0A-0000-4000-8000-00000000AAAA',
        },
        Environment.PRODUCTION,
      ).accountToken,
    ).toBe('7D1E5C0A-0000-4000-8000-00000000AAAA');
    expect(
      purchaseOf({ ...base, type: 'Consumable' }, Environment.PRODUCTION)
        .accountToken,
    ).toBeNull();
  });

  it('a consumable has no subscription key; a revoked or lapsed transaction is not in force; the sandbox is named', () => {
    const c = purchaseOf({ ...base, type: 'Consumable' }, Environment.SANDBOX);
    expect(c).toMatchObject({
      subscriptionKey: null,
      expiresAt: null,
      state: 'purchased',
      environment: 'sandbox',
    });
    expect(
      purchaseOf(
        { ...base, type: 'Consumable', revocationDate: Date.now() },
        Environment.PRODUCTION,
      ).state,
    ).toBe('refunded');
    expect(
      purchaseOf(
        {
          ...base,
          type: 'Auto-Renewable Subscription',
          expiresDate: Date.now() - 1000,
        },
        Environment.PRODUCTION,
      ).state,
    ).toBe('cancelled');
    expect(() =>
      purchaseOf({ type: 'Consumable' }, Environment.PRODUCTION),
    ).toThrow();
  });

  it('a payload that is not signed by Apple is refused, never decoded', async () => {
    const client = new RealAppStoreClient({
      bundleId: 'africa.wawu.test',
      issuerId: 'i',
      keyId: 'k',
      privateKey: 'p',
      environment: 'Sandbox',
      rootCertificates: [],
      appAppleId: null,
    });
    await expect(client.decodeNotification('not-a-jws')).rejects.toBeDefined();
  });
});

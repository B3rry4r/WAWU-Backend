import type {
  CreditPack,
  StorePlatform,
  StoreProductKind,
  StorePurchaseStatus,
} from '../../generated/prisma/enums';

/**
 * What the store routes answer (task IAP-01, R-86). Prices are never here: the
 * app shows the store's own price in the person's own currency (R-86). Credits
 * and points are counts, never naira (R-5).
 */

/** What one purchase of a product gives, as the app may draw it. */
export interface StoreGrantsView {
  /** Points a points pack adds (before any tier bonus); null for the other kinds. */
  points: number | null;
  /** WAWU Credits a credits pack adds; null for the other kinds. */
  credits: number | null;
  /** The maker tier a tier product gives; null for the other kinds. */
  tierId: string | null;
  /** Days a tier or a pass runs for each period; null for points and credits. */
  days: number | null;
}

/** One product on sale in a store. */
export interface StoreProductView {
  id: string;
  platform: StorePlatform;
  /** The id the store sells it under: what the app asks the store for and sends back. */
  storeProductId: string;
  kind: StoreProductKind;
  title: string;
  /** True for a tier or a pass, which the store renews; false for a points or credits pack. */
  subscription: boolean;
  grants: StoreGrantsView;
}

/** Why a store is not on sale. */
export type StoreUnavailableReason = 'store_not_configured' | 'store_disabled';

/** `GET /store/products`. */
export interface StoreProductListView {
  platform: StorePlatform;
  /** False when nothing can be bought in this store right now (`reason` says why); then `products` is empty. */
  available: boolean;
  reason: StoreUnavailableReason | null;
  products: StoreProductView[];
}

/** What a purchase gave, as it was written. */
export interface StoreGrantedView {
  /** Points added, with the tier's bonus on a pack. */
  points: number | null;
  credits: number | null;
  tierId: string | null;
  /** When the tier or pass now ends (ISO 8601). */
  until: string | null;
  communityId: string | null;
}

/** `POST /store/purchases`. */
export interface StorePurchaseView {
  id: string;
  platform: StorePlatform;
  storeProductId: string;
  kind: StoreProductKind;
  status: StorePurchaseStatus;
  /** True when this store transaction had already been granted (a replay, a restore): nothing more was given. */
  alreadyGranted: boolean;
  grant: StoreGrantedView;
  purchasedAt: string;
  /** When the subscription period ends as the store said; null for a points or credits pack. */
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** What an admin writes under `grants`; which field is used depends on the kind. */
export interface StoreProductGrantsConfig {
  /** points: a pack of the live plan (`plans.config.json`), by id. */
  packId: string | null;
  /** credits: starter, popular or pro. */
  pack: CreditPack | null;
  /** tier: a tier of the live plan, by id. */
  tierId: string | null;
  /** pass: the days one period runs. */
  days: number | null;
}

export interface AdminStoreProductView {
  id: string;
  platform: StorePlatform;
  storeProductId: string;
  kind: StoreProductKind;
  title: string;
  grants: StoreProductGrantsConfig;
  /** What the grant gives right now, resolved from the plan (display). */
  resolved: StoreGrantsView;
  /** Kobo one purchase is worth before the store's share; null for points and tiers. */
  referenceKobo: number | null;
  active: boolean;
  sortOrder: number;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AdminStoreProductListView {
  items: AdminStoreProductView[];
}

export interface AdminStorePlatformView {
  platform: StorePlatform;
  /** The admin switch. */
  enabled: boolean;
  /** True when the Hub has the store's credentials (nothing is asked of a store without them). */
  configured: boolean;
  /** The cut a new purchase records, in basis points. */
  storeFeeBps: number;
  /** True when the cut is the admin's own, false when it is the config's. */
  storeFeeOverridden: boolean;
  updatedAt: string | null;
}

export interface AdminStorePlatformListView {
  items: AdminStorePlatformView[];
}

export interface AdminStorePurchaseView {
  id: string;
  wawuUserId: string;
  platform: StorePlatform;
  storeProductId: string;
  kind: StoreProductKind;
  status: StorePurchaseStatus;
  environment: string;
  storeTransactionId: string;
  communityId: string | null;
  /** What the store charged, in the buyer's own currency, as the store said. */
  currency: string | null;
  priceMicros: string | null;
  referenceKobo: number | null;
  storeFeeBps: number;
  /** The reference less the store's cut: the base of the 85/15 split. */
  netKobo: number | null;
  /** The room's host and their 85% of the net (a pass). Recorded; paying it is a gap. */
  creatorWawuUserId: string | null;
  creatorShareKobo: number | null;
  purchasedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  /** What the take-back took (a spent point or credit is not taken back). */
  takenBack: Record<string, unknown> | null;
}

export interface AdminStorePurchasePageView {
  items: AdminStorePurchaseView[];
  nextCursor: string | null;
}

/** What a store webhook answers: the delivery was read, and what the Hub did with it. */
export interface StoreWebhookAck {
  received: true;
  /** `granted`, `taken_back`, `lapsed`, `ignored`, `duplicate` or `unknown`. */
  outcome: string;
}

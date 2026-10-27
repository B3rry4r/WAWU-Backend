import type {
  CreditPack,
  StoreIntentKind,
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
  /** Days a tier runs for each period, or a pass gives for each purchase; null for points and credits. */
  days: number | null;
  /**
   * Products an upload pack adds to the person's tier (IAP-03, "Add 5 more
   * products"). Present, and a number, only on an `extra_products` product;
   * absent on the other kinds.
   */
  extraProducts?: number | null;
}

/** One product on sale in a store. */
export interface StoreProductView {
  id: string;
  platform: StorePlatform;
  /** The id the store sells it under: what the app asks the store for and sends back. */
  storeProductId: string;
  kind: StoreProductKind;
  title: string;
  /** True for a tier, which the store renews; false for a points, credits, upload pack or pass (a pass is bought once). */
  subscription: boolean;
  grants: StoreGrantsView;
  /** A `buy` (ladder) product: the list price it sells, in kobo. Null on every other kind. */
  listPriceKobo?: number | null;
  /** A `buy` product: what the store charges in Nigeria, in kobo (the app shows the store's own price in the person's currency). Null on every other kind. */
  storePriceKobo?: number | null;
}

/** Why a store is not on sale. */
export type StoreUnavailableReason = 'store_not_configured' | 'store_disabled';

/** `GET /store/products`. */
export interface StoreProductListView {
  platform: StorePlatform;
  /**
   * The signed-in person's account token: a stable random UUID for them, never
   * their user id. The app MUST hand it to the store when it starts a purchase,
   * as Google `obfuscatedAccountIdAndroid` and as Apple `appAccountToken`. The
   * Hub refuses a purchase that carries another person's token, or none.
   */
  accountToken: string;
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
  /** Products an upload pack added (IAP-03); null for the other kinds. */
  extraProducts: number | null;
  /** When the tier or pass now ends (ISO 8601). */
  until: string | null;
  communityId: string | null;
  /** A ladder purchase of a piece: the piece unlocked (STORE-BUY-HUB). Absent on the other kinds. */
  contentId?: string | null;
  /** A ladder tip: the creator tipped. Absent on the other kinds. */
  creatorWawuId?: string | null;
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
  /** When the subscription period ends as the store said; null for anything bought once (points, credits, an upload pack, a pass). */
  expiresAt: string | null;
  /** `member_removed` when the purchase was recorded but the pass was not given because the host removed the person; `pack_not_allowed` when the upload pack was recorded and nothing was added because the person's tier may not buy it or they hold the most packs (R-100); `target_unavailable` when a ladder purchase was recorded and nothing was given because the piece, creator or room can no longer be bought (STORE-BUY-HUB); `earning_review` when a store refund of an already-paid earning needs a person. Null otherwise. */
  flag: string | null;
  /** A ladder purchase: what it was for (`content`, `tip` or `pass`). Absent on the other kinds. */
  buyKind?: StoreIntentKind | null;
  /** A ladder purchase: the intent it was made against. Absent on the other kinds. */
  intentId?: string | null;
  /** A ladder purchase: the piece, creator or room. Absent on the other kinds. */
  targetId?: string | null;
}

/** `POST /store/intents`: what to hand the store when the sheet opens. */
export interface StoreIntentView {
  /** Send it back on `POST /store/purchases` as `intentId`. */
  intentId: string;
  /** The store product to buy: `wawu.buy.<naira>`. */
  productId: string;
  /** The person's account token: hand it to the store as `obfuscatedAccountIdAndroid` / `appAccountToken`, as for every store purchase. */
  accountToken: string;
  /** When the intent stops being open (ISO 8601): 60 minutes after it was made. A sale made before then still counts however late it is posted. */
  expiresAt: string;
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
  /** pass: the days one purchase gives the room. */
  days: number | null;
  /** extra_products (IAP-03): the products one purchase adds. Absent on the other kinds. */
  extraProducts?: number | null;
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
  /** Kobo one purchase is worth before the store's share; null for points, tiers and upload packs. For a `buy` product, the list price. */
  referenceKobo: number | null;
  /** A `buy` product: what the store charges in Nigeria, in kobo. Null on every other kind. */
  storePriceKobo?: number | null;
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
  /** A ladder purchase: what it was for, the intent, and the piece, creator or room. */
  buyKind?: StoreIntentKind | null;
  intentId?: string | null;
  targetId?: string | null;
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
  /**
   * A pass: the end of the 30 days this purchase granted (the pass row's end, which a take-back moves to that moment). `expiresAt` is the
   * store's own period end and is null for a pass bought once. Null for any other kind. Optional: an older client never reads it.
   */
  passEndsAt?: string | null;
  endedAt: string | null;
  endReason: string | null;
  /** What the take-back took (a spent point or credit is not taken back). */
  takenBack: Record<string, unknown> | null;
  /** `member_removed` when a pass was paid for by a member the host removed in that moment and nothing was given; an admin looks. Null otherwise. */
  flag: string | null;
  flaggedAt: string | null;
}

export interface AdminStorePurchasePageView {
  items: AdminStorePurchaseView[];
  nextCursor: string | null;
}

/** What a store webhook answers: the delivery was read, and what the Hub did with it. */
export interface StoreWebhookAck {
  received: true;
  /** `granted`, `taken_back`, `restored`, `lapsed`, `ignored`, `duplicate` or `unknown`. */
  outcome: string;
}

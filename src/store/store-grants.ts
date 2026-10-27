import type {
  CreditPack,
  StoreProductKind,
} from '../../generated/prisma/enums';
import { KOBO_PER_NAIRA, PACK_TABLE } from '../credit-purchase/credit-packs';
import {
  INT4_MAX,
  countIn,
  tierById,
  type PlansConfig,
} from '../plans/plans-config';
import { packById } from '../plans/purchases/points-pack-rules';
import { StoreError } from './store-error';
import type {
  StoreGrantsView,
  StoreProductGrantsConfig,
} from './store-view.type';

/** The longest pass period an admin may set, in days. */
export const MAX_PASS_DAYS = 366;

/**
 * A tier is an auto-renewing subscription in the store. Points, credits, an
 * upload pack and a community pass are bought once: a pass is a ONE-TIME
 * 30-day purchase for one room (Google Play: a consumable in-app product; the
 * App Store: a non-renewing subscription), because Google and Apple let an
 * account hold a given subscription product only once, so one subscription per
 * price point could not cover two rooms (IAP-03 round 2, Default (lead), owner
 * may override). Renewing a pass is buying it again.
 */
export function isSubscriptionKind(kind: StoreProductKind): boolean {
  return kind === 'tier';
}

/**
 * The grants every kind but `extra_products` uses. `extraProducts` is left out
 * on purpose: it is only there on an `extra_products` product, so the stored
 * and answered shapes of the older kinds do not change (IAP-03, additive).
 */
const EMPTY: StoreProductGrantsConfig = {
  packId: null,
  pack: null,
  tierId: null,
  days: null,
};

/** What an admin sent under `grants`, as the stored shape (nulls for what the kind does not use). */
export function grantsConfigOf(raw: unknown): StoreProductGrantsConfig {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY };
  const o = raw as Record<string, unknown>;
  return {
    packId: typeof o.packId === 'string' ? o.packId : null,
    pack: typeof o.pack === 'string' ? (o.pack as CreditPack) : null,
    tierId: typeof o.tierId === 'string' ? o.tierId : null,
    days: typeof o.days === 'number' ? o.days : null,
    ...(typeof o.extraProducts === 'number'
      ? { extraProducts: o.extraProducts }
      : {}),
  };
}

const bad = (message: string) =>
  new StoreError('store_product_invalid', message);

/**
 * Checks that a product's grant fits its kind and names things the live plan
 * has, and returns the stored shape (only the field its kind uses is kept) and
 * the reference kobo to store. Throws `store_product_invalid` with a plain
 * sentence.
 *
 *  - points: `packId` of a pack of the plan. No reference (no creator is paid).
 *  - credits: `pack` (starter, popular or pro). The reference defaults to the
 *    pack's wallet price (Default (lead), owner may override).
 *  - tier: `tierId` of a tier of the plan. No reference.
 *  - pass: `days`, what ONE purchase gives the room named in it (30). The
 *    reference is required: the room's price is the host's, but a store sells
 *    fixed price points, so the admin states what this product is worth. One
 *    product per price point (`wawu.pass.30.a`, `wawu.pass.30.b`, and so on).
 *  - buy (STORE-BUY-HUB, R-101): the price ladder, `wawu.buy.<naira>`. It
 *    grants nothing by itself: what it buys is named by the person's intent.
 *    The reference is the list price it sells, in whole naira (the catalog also
 *    checks it is on the price list).
 *  - extra_products (IAP-03): `extraProducts`, a whole number of products the
 *    pack adds to the tier. It defaults to the plan's count (R-65, 5) when the
 *    admin sends none, and is stored as a number so a later change to the
 *    plan's setting never changes what a store listing already sells. No
 *    reference (WAWU's own sale, no creator is paid).
 */
export function checkProduct(
  kind: StoreProductKind,
  grants: StoreProductGrantsConfig,
  referenceKobo: number | null,
  plans: PlansConfig,
): { grants: StoreProductGrantsConfig; referenceKobo: number | null } {
  const only = (used: keyof StoreProductGrantsConfig) => {
    for (const k of Object.keys(EMPTY) as (keyof StoreProductGrantsConfig)[])
      if (k !== used && grants[k] !== null)
        throw bad(`A ${kind} product takes only "${used}" under grants.`);
    if (used !== 'extraProducts' && (grants.extraProducts ?? null) !== null)
      throw bad(`A ${kind} product takes only "${used}" under grants.`);
  };
  switch (kind) {
    case 'points': {
      only('packId');
      if (grants.packId === null || packById(plans, grants.packId) === null)
        throw bad('That points pack is not in the plan.');
      return {
        grants: { ...EMPTY, packId: grants.packId },
        referenceKobo: null,
      };
    }
    case 'credits': {
      only('pack');
      if (grants.pack === null || !(grants.pack in PACK_TABLE))
        throw bad('A credits product names starter, popular or pro.');
      return {
        grants: { ...EMPTY, pack: grants.pack },
        referenceKobo:
          referenceKobo ?? PACK_TABLE[grants.pack].amount * KOBO_PER_NAIRA,
      };
    }
    case 'tier': {
      only('tierId');
      if (grants.tierId === null || tierById(plans, grants.tierId) === null)
        throw bad('That tier is not in the plan.');
      return {
        grants: { ...EMPTY, tierId: grants.tierId },
        referenceKobo: null,
      };
    }
    case 'pass': {
      only('days');
      if (
        grants.days === null ||
        !Number.isInteger(grants.days) ||
        grants.days < 1 ||
        grants.days > MAX_PASS_DAYS
      )
        throw bad(`A pass period is 1 to ${MAX_PASS_DAYS} days.`);
      if (referenceKobo === null)
        throw bad('A pass product needs the kobo one period is worth.');
      return { grants: { ...EMPTY, days: grants.days }, referenceKobo };
    }
    case 'buy': {
      only('days');
      if (grants.days !== null)
        throw bad('A ladder product gives nothing under grants.');
      if (
        referenceKobo === null ||
        !Number.isInteger(referenceKobo) ||
        referenceKobo < 100 ||
        referenceKobo % 100 !== 0
      )
        throw bad(
          'A ladder product needs the list price it sells, in whole naira, as referenceKobo.',
        );
      return { grants: { ...EMPTY }, referenceKobo };
    }
    case 'extra_products': {
      only('extraProducts');
      const count = grants.extraProducts ?? plans.extraProducts.count;
      if (!Number.isInteger(count) || count < 1 || count > INT4_MAX)
        throw bad('An upload pack adds a whole number of products, 1 or more.');
      return {
        grants: { ...EMPTY, extraProducts: count },
        referenceKobo: null,
      };
    }
  }
}

/** What a product gives right now, resolved against the live plan. A product whose plan entry is gone resolves to nulls. */
export function resolveGrants(
  kind: StoreProductKind,
  grants: StoreProductGrantsConfig,
  plans: PlansConfig,
): StoreGrantsView {
  const none: StoreGrantsView = {
    points: null,
    credits: null,
    tierId: null,
    days: null,
  };
  switch (kind) {
    case 'points': {
      const pack =
        grants.packId === null ? null : packById(plans, grants.packId);
      return {
        ...none,
        points: pack === null ? null : countIn(pack.points, 'NGN'),
      };
    }
    case 'credits':
      return {
        ...none,
        credits:
          grants.pack !== null && grants.pack in PACK_TABLE
            ? PACK_TABLE[grants.pack].credits
            : null,
      };
    case 'tier': {
      const tier =
        grants.tierId === null ? null : tierById(plans, grants.tierId);
      return { ...none, tierId: tier?.id ?? null, days: tier?.days ?? null };
    }
    case 'pass':
      return { ...none, days: grants.days };
    case 'buy':
      return none;
    case 'extra_products':
      return { ...none, extraProducts: grants.extraProducts ?? null };
  }
}

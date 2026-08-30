/**
 * WAWU Commerce wire types.
 *
 * EXPLICIT SHAPES, NOT PRISMA RE-EXPORTS. Most of the older types in this
 * folder are `export type X = XModel`, and that is the registry's standing
 * hazard: a column added to an existing table silently appears in a shipped
 * app response. These tables carry things that must never ship —
 * `ShopOrder.refundError` is an internal note for a human, and a product's
 * cost or supplier would be next — so every field below is listed by hand and
 * a mapper does the narrowing.
 *
 * Declaring a return type is NOT enough on its own: TypeScript accepts a wider
 * object where a narrower one is declared, and `prisma.findMany` resolves the
 * whole row. The `toWire*` functions are what actually drop the fields.
 */

import type { Decimal } from '../../../generated/prisma/internal/prismaNamespace';
import type {
  ProductCategory,
  ProductStatus,
  ShopFulfilment,
  ShopOrderStatus,
} from '../../../generated/prisma/enums';

/** One product as a shopper sees it. */
export interface ProductView {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  description: string;
  category: ProductCategory;
  subcategory: string;
  priceNaira: number;
  /** The "was" price, or null when the item is not on offer. */
  compareAtNaira: number | null;
  /** Whether anything is left. The exact count is NOT public. */
  inStock: boolean;
  /**
   * Surfaced only when it is low, as a nudge. A precise stock figure on every
   * product tells a competitor exactly what WAWU is holding.
   */
  lowStock: boolean;
  images: string[];
  wawuVerified: boolean;
  wawuPick: boolean;
  /**
   * Null until a review system exists, and deliberately not seeded. The brief
   * shows a star rating on the card; inventing one is fabricated social proof
   * on something people spend real money against.
   */
  ratingAvg: number | null;
  ratingCount: number;
}

/** The exact-stock view, for the dashboard only. Never returned to the app. */
export interface AdminProductView extends ProductView {
  stock: number;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** One line in the cart, with the product it points at. */
export interface CartItemView {
  id: string;
  quantity: number;
  product: ProductView;
  /** priceNaira * quantity, computed server-side so the client cannot drift. */
  lineTotalNaira: number;
}

export interface CartView {
  items: CartItemView[];
  /** The count of ITEMS, not lines — the number on the cart badge. */
  itemCount: number;
  subtotalNaira: number;
  /**
   * Delivery is arranged by hand and off-platform, so nothing is added here.
   * The field exists so the client never has to decide that for itself.
   */
  deliveryNaira: number;
  totalNaira: number;
}

export interface ShopOrderItemView {
  id: string;
  productId: string;
  /** What it was called and cost AT PURCHASE, not what it is called now. */
  name: string;
  priceNaira: number;
  quantity: number;
  /** For the order screen. May be empty if the product was since deleted. */
  imageUrl: string | null;
}

export interface ShopOrderView {
  id: string;
  status: ShopOrderStatus;
  subtotalNaira: number;
  deliveryNaira: number;
  totalNaira: number;

  deliveryName: string;
  deliveryPhone: string;
  deliveryAddress: string;
  deliveryCity: string;
  deliveryState: string;
  deliveryNote: string | null;

  fulfilment: ShopFulfilment;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  /** What a human typed: courier and waybill. Not a tracking integration. */
  trackingNote: string | null;

  items: ShopOrderItemView[];
  createdAt: Date;
  paidAt: Date | null;
  // refundError is ABSENT on purpose. It is an instruction to a WAWU operator,
  // written for them, and it does not belong in a customer's order history.
}

/** What the storefront needs to open a Flutterwave charge. */
export interface ShopCheckoutView {
  orderId: string;
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
}

/* ------------------------------------------------------------------ *
 * mappers — the things that actually narrow
 * ------------------------------------------------------------------ */

/** How few units left before the storefront starts saying so. */
export const LOW_STOCK_AT = 5;

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  description: string;
  category: ProductCategory;
  subcategory: string;
  priceNaira: number;
  compareAtNaira: number | null;
  stock: number;
  images: string[];
  wawuVerified: boolean;
  wawuPick: boolean;
  ratingAvg: Decimal | null;
  ratingCount: number;
}

export function toWireProduct(row: ProductRow): ProductView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: row.brand,
    description: row.description,
    category: row.category,
    subcategory: row.subcategory,
    priceNaira: row.priceNaira,
    compareAtNaira: row.compareAtNaira,
    // The boolean, not the count. See ProductView.lowStock.
    inStock: row.stock > 0,
    lowStock: row.stock > 0 && row.stock <= LOW_STOCK_AT,
    images: row.images,
    wawuVerified: row.wawuVerified,
    wawuPick: row.wawuPick,
    ratingAvg: row.ratingAvg === null ? null : Number(row.ratingAvg),
    ratingCount: row.ratingCount,
  };
}

export function toAdminProduct(
  row: ProductRow & {
    status: ProductStatus;
    createdAt: Date;
    updatedAt: Date;
  },
): AdminProductView {
  return {
    ...toWireProduct(row),
    stock: row.stock,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

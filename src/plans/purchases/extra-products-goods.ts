import type { PayableTerms } from '../../money/payments/payable-terms';
import { termsFromJson } from '../../money/payments/payable-terms';
import type { ExtraProductsPlan } from './extra-products-rules';

/**
 * What an extra products purchase gives, as the quote showed it: how many
 * products. It is the payment's `terms`: the quote token is bound to it, so a
 * count changed after the quote makes the quote stale (`409 quote_changed`),
 * and the payment keeps it from the claim, so the grant adds what was quoted
 * even when the setting changes while the payment confirms or a bank-transfer
 * purchase waits (the price is bound the same way, as the payment's price).
 */
export interface ExtraProductsGoods {
  products: number;
}

/** Version of the stored shape. */
const TERMS_VERSION = 1;

export function extraGoodsOf(
  plan: Pick<ExtraProductsPlan, 'products'>,
): ExtraProductsGoods {
  return { products: plan.products };
}

export function extraGoodsToTerms(goods: ExtraProductsGoods): PayableTerms {
  return { v: TERMS_VERSION, products: goods.products };
}

/**
 * The goods a payment was claimed with. Throws for terms that are missing or
 * are not goods: a delivery then fails and goes to review with the money safe,
 * never granting a guess.
 */
export function extraGoodsFromTerms(
  terms: PayableTerms | undefined,
): ExtraProductsGoods {
  if (terms === undefined)
    throw new Error('The payment has no terms, so it names no products.');
  if (terms.v !== TERMS_VERSION)
    throw new Error(
      "The payment's terms are of a version this server cannot read.",
    );
  const products = terms.products;
  if (
    typeof products !== 'number' ||
    !Number.isSafeInteger(products) ||
    products < 1
  )
    throw new Error("The payment's terms have no usable products.");
  return { products };
}

/** The goods in the JSON a payment or an order stored. */
export function extraGoodsFromJson(value: unknown): ExtraProductsGoods {
  return extraGoodsFromTerms(termsFromJson(value) ?? undefined);
}

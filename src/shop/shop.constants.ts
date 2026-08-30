/**
 * WAWU Commerce limits and rules.
 *
 * All of these exist because of a specific way the storefront can go wrong,
 * not as arbitrary round numbers.
 */

/**
 * How many of one product a single order may carry.
 *
 * A storefront selling cameras is not selling five hundred of one camera to
 * one person, and an unbounded quantity is a way to reserve the entire stock
 * of an item in one request and never pay for it. A genuine bulk order is a
 * conversation, not a checkout.
 */
export const MAX_QUANTITY_PER_LINE = 20;

/**
 * How many distinct products a cart may hold. A cart is priced and
 * stock-checked on every read; an unbounded one is a slow query anybody can
 * trigger by clicking "add" repeatedly.
 */
export const MAX_CART_LINES = 40;

/**
 * Delivery is arranged by hand and off-platform (the brief is explicit that
 * logistics is not integrated), so nothing is added to the total. This
 * constant exists so that "there is no delivery fee" is stated in ONE place
 * with its reason, rather than as a bare `0` in the three files that would
 * otherwise each decide it independently.
 */
export const DELIVERY_NAIRA = 0;

/** Nigerian states, for the delivery address. */
export const NIGERIAN_STATES = [
  'Abia',
  'Adamawa',
  'Akwa Ibom',
  'Anambra',
  'Bauchi',
  'Bayelsa',
  'Benue',
  'Borno',
  'Cross River',
  'Delta',
  'Ebonyi',
  'Edo',
  'Ekiti',
  'Enugu',
  'FCT',
  'Gombe',
  'Imo',
  'Jigawa',
  'Kaduna',
  'Kano',
  'Katsina',
  'Kebbi',
  'Kogi',
  'Kwara',
  'Lagos',
  'Nasarawa',
  'Niger',
  'Ogun',
  'Ondo',
  'Osun',
  'Oyo',
  'Plateau',
  'Rivers',
  'Sokoto',
  'Taraba',
  'Yobe',
  'Zamfara',
] as const;

/**
 * A URL-safe slug from a product name, with a short random tail.
 *
 * The tail is not decoration: two products genuinely can be called "Rode
 * NT-USB", and a bare name-slug would collide on the second one and fail the
 * unique constraint in the middle of an admin saving a form.
 */
export function slugify(name: string, tail: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'product'}-${tail}`;
}

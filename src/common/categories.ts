/**
 * The WAWU category taxonomy — the server-side mirror of the web app's
 * src/lib/categories.ts. Keep the two lists identical.
 *
 * `category` used to be an unvalidated free string, so a typo or a stale
 * client could file content under a category no browse surface lists, making
 * it effectively unreachable. Content now has to land in one of these 25.
 */
export const CATEGORY_IDS = [
  'agriculture_food',
  'trade_commerce',
  'business_entrepreneurship',
  'finance',
  'technology',
  'education',
  'healthcare',
  'employment',
  'entertainment_creative',
  'beauty',
  'family_lifestyle',
  'culture_heritage',
  'religion_faith',
  'travel_tourism',
  'real_estate',
  'transport_logistics',
  'manufacturing',
  'energy_utilities',
  'media_communications',
  'professional_services',
  'legal_services',
  'insurance_pensions',
  'sports_fitness',
  'government_public',
  'social_impact',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

const SET = new Set<string>(CATEGORY_IDS);

export function isCategoryId(value: string): value is CategoryId {
  return SET.has(value);
}

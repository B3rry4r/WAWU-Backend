/**
 * Which categories need a licence, and which need judgment.
 *
 * This list is the difference between a review a person can actually perform
 * and one they cannot. In a regulated category there is a body that issues
 * the credential and can be asked to confirm it, so "confirm the licence" is
 * a real instruction. Everywhere else there is no register to check, and
 * demanding a licence would leave a reviewer with two bad options: reject
 * every applicant in technology for lacking a document that does not exist,
 * or approve anyone who says they are a lawyer.
 *
 * It is also the liability line. A wrongly-approved beautician is a bad
 * listing; a wrongly-approved solicitor or pharmacist is a claim against WAWU
 * brought by whoever relied on the badge.
 *
 * Ids are the app's explore categories (src/lib/categories.ts in WAWU-Web).
 */
export const REGULATED_CATEGORIES = [
  'legal_services',
  'healthcare',
  'finance',
  'insurance_pensions',
] as const;

export type RegulatedCategory = (typeof REGULATED_CATEGORIES)[number];

export function isRegulatedCategory(category: string): boolean {
  return (REGULATED_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The full taxonomy, mirrored from the app so an application cannot be filed
 * against a category that does not exist. Kept as a plain list rather than an
 * enum: the taxonomy is app-defined and should not need a migration to change.
 */
export const PROFESSIONAL_CATEGORIES = [
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

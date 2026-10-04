/**
 * The creator taxonomy Explore filters by (EXPLORE-03).
 *
 * PROVISIONAL(EXPLORE-TAXONOMY, owner=YOU, why=no ruling names the creator categories; the only creator taxonomy drawn is the twelve interest chips of A12, so those are used)
 *
 * Default (agent), owner may override: the twelve chips on A12, in the order
 * drawn. A kept list rather than a table, so a new chip is a code change that
 * the app's chips and this list change together. `id` is the stable key the
 * app sends; `label` is what the chip says.
 *
 * A creator is "in" a category when one of their profile interests equals the
 * id or the label exactly (ignoring case), because profiles hold both
 * spellings today (see ListCreatorsQueryDto). Nothing is inferred beyond that.
 */
export interface ExploreCategory {
  id: string;
  label: string;
}

export const EXPLORE_CATEGORIES: readonly ExploreCategory[] = [
  { id: 'music_audio', label: 'Music & Audio' },
  { id: 'film_video', label: 'Film & Video' },
  { id: 'photography', label: 'Photography' },
  { id: 'fashion_beauty', label: 'Fashion & Beauty' },
  { id: 'business_finance', label: 'Business & Finance' },
  { id: 'technology', label: 'Technology' },
  { id: 'food_lifestyle', label: 'Food & Lifestyle' },
  { id: 'faith_spirituality', label: 'Faith & Spirituality' },
  { id: 'art_design', label: 'Art & Design' },
  { id: 'writing_publishing', label: 'Writing & Publishing' },
  { id: 'sports_fitness', label: 'Sports & Fitness' },
  { id: 'gaming_esports', label: 'Gaming & Esports' },
];

export const EXPLORE_CATEGORY_IDS: string[] = EXPLORE_CATEGORIES.map(
  (c) => c.id,
);

/** Every spelling of a category a profile may hold: id and label, any case. */
export function interestSpellings(id: string): string[] {
  const c = EXPLORE_CATEGORIES.find((x) => x.id === id);
  if (!c) return [];
  const out = new Set<string>();
  for (const base of [c.id, c.label]) {
    out.add(base);
    out.add(base.toLowerCase());
    out.add(base.toUpperCase());
  }
  return [...out];
}

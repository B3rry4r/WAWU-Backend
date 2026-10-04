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
 * id or the label after normaliseInterest (case, spaces and punctuation do not
 * matter), because profiles hold several spellings today (see
 * ListCreatorsQueryDto). Nothing is inferred beyond that.
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

/**
 * The comparison key for a category or an interest: lower case, letters and
 * digits only. "Film & video", "Film_Video" and "film-video" all become
 * `filmvideo`. The same rule runs in SQL (explore.service.ts), so the two
 * must change together.
 */
export function normaliseInterest(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

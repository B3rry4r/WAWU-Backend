/**
 * Feed and explore ranking.
 *
 * Content was ordered by `createdAt DESC` everywhere, which is a publication
 * log rather than a ranking: the newest upload always outranked the piece a
 * hundred people had actually paid for. This scores engagement and then
 * decays it with age, so a strong piece holds its place for a while and a
 * weak one falls away even if it was posted a minute ago.
 *
 *   score = engagement / (ageHours + 2) ^ GRAVITY
 *
 * The weights are ordered by how much intent each signal represents. Somebody
 * spending money is the strongest statement they can make about a piece, so a
 * purchase counts for a hundred views; a comment costs more effort than a
 * like, and a like more than a view.
 *
 * The `+ 2` keeps a brand-new piece from dividing by ~0 and scoring like an
 * outlier for its first minutes. GRAVITY sets how fast things fall: 1.45
 * gives a good piece roughly a day and a half near the top.
 */
export const RANKING = {
  purchase: 10,
  comment: 4,
  like: 3,
  /** Ratings are a percentage, so this converts 0-100 into 0-5 points. */
  ratingDivisor: 20,
  view: 0.1,
  /** Every live piece starts above zero so a brand-new upload is still rankable. */
  base: 1,
  gravity: 1.45,
} as const;

export type ContentSort = 'trending' | 'recent' | 'top';

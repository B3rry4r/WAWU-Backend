import type { PlanBadgeView } from '../plans-view.type';

/**
 * A person's tier badge as other people see it (TIER-07): the pill beside the
 * name on a profile (M5 to M7) and the badge on a card, with the number on
 * Founding Maker's (VF7a: "Founding Maker #128").
 *
 * It is served as `badge` on those views and is null unless the person holds
 * a tier that is running (`active` or `ending`, never `ended`). `id` and
 * `numbered` are the plan's own `PlanBadgeView`.
 */
export interface PersonBadgeView extends PlanBadgeView {
  /** The tier's name in the plan now: "Verify", "Verify Plus", "Founding Maker". */
  name: string;
  /**
   * The number on a numbered badge, given once and kept for life. Null when
   * the badge is not numbered, and null for a Founding Maker numbered before
   * this field existed only if the migration's numbering did not reach them.
   */
  number: number | null;
}

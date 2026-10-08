/**
 * The points settings (task POINTS-01). No price, fee, rate or points amount
 * lives here: how many points a tier, a pack or a referral grants, and how
 * long they last, are TIER-01's one config file, read by the task that grants
 * them. These are only how much `GET /me/points` lists and how the expiry job
 * works through lapsed lots.
 */
export const POINTS_VIEW = {
  /** PT5 and the owner's brief (section 6): the last 20 ledger rows. */
  movements: 20,
  /**
   * The live lots listed, soonest-expiring first; `lotCount` says how many
   * there are in all, and the balance always counts every one.
   * PROVISIONAL(POINTS-LOTS-SHOWN, owner=YOU, why=PT5 lists lots with their expiry dates and no ruling names how many one screen lists)
   */
  lots: 50,
} as const;

export const POINTS_EXPIRY = {
  /**
   * Lapsed lots one pass of the expiry job takes, oldest expiry first; the
   * rest wait for the next pass. A lapsed lot never counts in a balance or a
   * hold whether or not the job has reached it: the job only writes the
   * ledger row that takes its points away.
   * PROVISIONAL(POINTS-EXPIRY-BATCH, owner=YOU, why=no ruling names how many lapsed lots one pass writes off; 500 keeps a pass short)
   */
  batch: 500,
} as const;

/** The longest reference or title a caller may hand the service. */
export const POINTS_LIMITS = {
  /** The migration's CHECK holds the same bound on both tables. */
  referenceLength: 200,
  /** A hold's title is a tool's name ("VoiceOver"), shown after "Spent on". */
  titleLength: 60,
  /** Postgres INTEGER, which every points column is. */
  maxPoints: 2_147_483_647,
} as const;

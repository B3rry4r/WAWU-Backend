/**
 * The one place the ads weight range is written in code (ADS-03).
 *
 * A campaign's weight ranks bookings that overlap on one placement. ADS-04
 * (serving) and ADS-06 (the admin routes and the dashboard's schedule form)
 * read the range from here, never as a literal.
 *
 * The database holds the same range as the CHECK "AdCampaign_weight_check" in
 * migration 20261006090000_ads_data_model, so a row written by hand is refused
 * too. The two must match: ads-data-model.contract.spec.ts reads the CHECK's
 * bounds from pg_constraint and fails if they differ from these constants.
 * Changing the range means a new migration that replaces the CHECK, and a
 * change here, in the same task.
 *
 * PROVISIONAL(ADS-WEIGHT-RANGE, owner=DEV2, why=no ruling names a weight range for an ad campaign; the dashboard's schedule form shows it)
 */
export const AD_WEIGHT_MIN = 1;
export const AD_WEIGHT_MAX = 100;

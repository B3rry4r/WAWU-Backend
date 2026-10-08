/**
 * GET /ads?placement=. Exactly what the sponsored card draws (H33, H36) and
 * what it needs to open its event and to be counted (ADS-05), nothing else:
 * no status, window, weight, creative id or timestamps. The "SPONSORED" label,
 * "Ads keep TGIF free" and "Skip" are the app's own words and are not here.
 */
export interface AdCardView {
  /** The campaign's id. ADS-05 counts views, taps and skips against it. */
  id: string;
  /** The advertiser's name, as typed by the WAWU team. */
  advertiser: string;
  headline: string;
  /** Place, date and price as the team typed them. Null: no second line. */
  subline: string | null;
  /** The button's words ("Get tickets"). */
  ctaLabel: string;
  /** What the button opens. `event` today: ctaDestinationId is an Event id. */
  ctaDestination: 'event';
  ctaDestinationId: string;
  /** http(s) URL of the picture. Null: draw the card without one. */
  artworkUrl: string | null;
}

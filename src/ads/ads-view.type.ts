/**
 * GET /ads?placement=. One card for `tgif_card` and `today_slot`, a list of
 * them for `explore_slider`. Exactly what the sponsored card draws (H33, H36) and
 * what it needs to do what a tap does and to be counted (ADS-05), nothing else:
 * no status, window, weight, creative id or timestamps. The "SPONSORED" label,
 * "Ads keep TGIF free" and "Skip" are the app's own words and are not here.
 *
 * What a tap does is `ctaDestination` (R-92, ADS-LINK): `link` opens `ctaUrl`
 * in the phone's browser and draws a button with `ctaLabel`; `none` draws the
 * card with no button and nothing to tap; `event` (campaigns saved before
 * R-92) opens the event `ctaDestinationId`. Each kind carries only its own
 * fields and leaves the others out, so an `event` card is the eight keys it
 * always was. A build that predates R-92 draws only `event` cards and drops
 * the rest (its `drawable`), so it never meets the new kinds' missing fields.
 */
export interface AdCardView {
  /** The campaign's id. ADS-05 counts views, taps and skips against it. */
  id: string;
  /** The advertiser's name, as typed by the WAWU team. */
  advertiser: string;
  headline: string;
  /** Place, date and price as the team typed them. Null: no second line. */
  subline: string | null;
  /** The button's words ("Get tickets", "Visit us"). Left out for `none`: no button is drawn. */
  ctaLabel?: string;
  /** What a tap does: `link` (open `ctaUrl`), `none` (nothing) or `event` (open the event). */
  ctaDestination: 'event' | 'link' | 'none';
  /** The Event id. Present for `event` only. */
  ctaDestinationId?: string;
  /** The https address, in its normal form. Present for `link` only. */
  ctaUrl?: string;
  /**
   * http(s) URL of the picture. Always present: a campaign without artwork is
   * not served (R-59), so no card is ever drawn without a picture.
   */
  artworkUrl: string;
}

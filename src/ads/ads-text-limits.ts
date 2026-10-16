/**
 * How long the words on a sponsored card may be (ADS-06).
 *
 * The admin routes refuse text longer than this, counted in characters a
 * person sees as one code point each, after trimming. The limits keep the
 * card inside its frame at 390 px wide: H33 sets the card in the TGIF reader
 * and H36 in TGIF's place on Today, each line on one or two lines of the
 * card's type. The database holds no length limit (ADS-03), so these are the
 * only ones.
 *
 * No ruling names a length. The numbers are a few times the longest line the
 * designs draw ("Gospel Night Live", "Abuja · Sat 18 October · from ₦5,000",
 * "Get tickets").
 *
 * PROVISIONAL(ADS-TEXT-LIMITS, owner=DEV2, why=no ruling gives a length for the words on a sponsored card; owner to confirm what the card can show at 390 px)
 */
export const AD_TEXT_LIMITS = {
  /** "SPONSORED · <advertiser>". */
  advertiser: 60,
  headline: 60,
  /** Place, date and price as the team types them. */
  subline: 80,
  /** The button's words. */
  ctaLabel: 24,
} as const;

/**
 * The longest artwork link accepted: the same bound as an Event's external
 * link and a notification campaign's picture. Covered by the marker above.
 */
export const AD_ARTWORK_URL_MAX = 500;

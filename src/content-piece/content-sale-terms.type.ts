/** One quick price the price step offers. */
export interface ContentSalePreset {
  /** The price in kobo. */
  priceKobo: number;
}

/**
 * GET /content/sale-terms (FIX-110, M24 and M25): the terms of selling a
 * piece, worked out by the Hub. Money is whole kobo (R-21).
 */
export interface ContentSaleTerms {
  /** The share of each sale the creator keeps, in whole percent (R-5: 85). */
  creatorSharePct: number;
  /** What it costs to list a piece, in kobo. 0: listing is free. */
  listingFeeKobo: number;
  /** The quick prices the price step offers, in the order drawn (a list of objects, never an array in a Kobo field: CONVENTIONS section 1). */
  presets: ContentSalePreset[];
  /** Hours a review of a new piece usually takes (an admin setting). */
  reviewHours: number;
  /** The price asked about, in kobo, as sent; null when none was sent. */
  priceKobo: number | null;
  /** What the creator keeps of one sale at `priceKobo`, rounded down to the kobo; null when no price was sent. */
  earnPerSaleKobo: number | null;
}

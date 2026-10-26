import type { Prisma } from '../../generated/prisma/client';
import type { AdPlacementName } from './dto/ads.dto';

/**
 * The two shapes of an ad (ADS-LINK round 2, R-92, owner, 26 Oct 2026). Written
 * once, so serving, counting, the admin list, the report and the views all read
 * the same rule.
 *
 *   LANDSCAPE  16:9, 1920 x 1080. Shown in the Explore slider AND on the Today strip.
 *   PORTRAIT   1080 x 2340, a phone screen. Shown in the TGIF full screen.
 *
 * One booking takes one picture per shape, each optional, at least one required.
 * Where an ad shows follows from the pictures it has: landscape only = Explore
 * and Today, never TGIF; portrait only = TGIF only; both = all three.
 *
 * A booking saved BEFORE the two shapes has one picture (`artworkUrl`) and one
 * `placement`, and is served exactly as it always was, in that one place: an
 * explore_slider or today_slot booking counts as landscape for its own place
 * only, a tgif_card booking as portrait. A CHECK in the database keeps the two
 * kinds apart (a card holds `artworkUrl` or the two-shape pictures, never both).
 */
export type AdShape = 'landscape' | 'portrait';

/** The shape each place draws. */
export const AD_SHAPE_OF: Record<AdPlacementName, AdShape> = {
  explore_slider: 'landscape',
  today_slot: 'landscape',
  tgif_card: 'portrait',
};

/** The places each shape shows in, in the order the dashboard lists them. */
export const AD_PLACES_OF: Record<AdShape, readonly AdPlacementName[]> = {
  landscape: ['explore_slider', 'today_slot'],
  portrait: ['tgif_card'],
};

/** What this module reads of a booking: its stored place and the card's picture columns. */
export interface AdPictureRow {
  placement: AdPlacementName;
  creative: {
    artworkUrl: string | null;
    artworkLandscapeUrl: string | null;
    artworkPortraitUrl: string | null;
  } | null;
}

/** A booking saved with the two shapes: it holds a landscape or a portrait picture. */
export function holdsShapes(row: AdPictureRow): boolean {
  return (
    row.creative !== null &&
    (row.creative.artworkLandscapeUrl !== null ||
      row.creative.artworkPortraitUrl !== null)
  );
}

/** The picture this place draws, or null when the booking does not show there. */
export function pictureFor(
  row: AdPictureRow,
  place: AdPlacementName,
): string | null {
  const c = row.creative;
  if (!c) return null;
  if (holdsShapes(row)) {
    return AD_SHAPE_OF[place] === 'landscape'
      ? c.artworkLandscapeUrl
      : c.artworkPortraitUrl;
  }
  // The single old picture, in its own place only.
  return row.placement === place ? c.artworkUrl : null;
}

/** The landscape and portrait picture a booking holds. An old booking's one picture is the shape of its own place. */
export function picturesOf(row: AdPictureRow): {
  landscape: string | null;
  portrait: string | null;
} {
  const c = row.creative;
  if (!c) return { landscape: null, portrait: null };
  if (holdsShapes(row)) {
    return { landscape: c.artworkLandscapeUrl, portrait: c.artworkPortraitUrl };
  }
  const shape = AD_SHAPE_OF[row.placement];
  return {
    landscape: shape === 'landscape' ? c.artworkUrl : null,
    portrait: shape === 'portrait' ? c.artworkUrl : null,
  };
}

/** The places the booking shows in, in the dashboard's order. Empty for a booking with no picture. */
export function showsIn(row: AdPictureRow): AdPlacementName[] {
  const { landscape, portrait } = picturesOf(row);
  // An old booking shows in its own place only, even though its picture has a shape.
  if (!holdsShapes(row)) {
    return landscape || portrait ? [row.placement] : [];
  }
  return [
    ...(landscape ? AD_PLACES_OF.landscape : []),
    ...(portrait ? AD_PLACES_OF.portrait : []),
  ];
}

/** Whether the booking holds any picture at all (the old one or either new one). */
export function hasAnyPicture(row: AdPictureRow): boolean {
  const c = row.creative;
  return (
    c !== null &&
    (c.artworkUrl !== null ||
      c.artworkLandscapeUrl !== null ||
      c.artworkPortraitUrl !== null)
  );
}

/** A picture to draw when no place is asked for (counting a view): the landscape, else the portrait, else the old one. */
export function anyPicture(row: AdPictureRow): string | null {
  const c = row.creative;
  return c
    ? (c.artworkLandscapeUrl ?? c.artworkPortraitUrl ?? c.artworkUrl)
    : null;
}

/** The card holds a landscape or portrait picture. */
const HOLDS_SHAPES: Prisma.AdCreativeWhereInput = {
  OR: [
    { artworkLandscapeUrl: { not: null } },
    { artworkPortraitUrl: { not: null } },
  ],
};

/**
 * The bookings that show in `place`, as a database filter: a booking with the
 * shape's picture, or an old booking whose own place it is. `requirePicture`
 * is for serving (the old booking must have its picture); the admin list and
 * report leave it off so a booking saved without one is still found in its
 * place, as before.
 */
export function showsInWhere(
  place: AdPlacementName,
  opts: { requirePicture: boolean },
): Prisma.AdCampaignWhereInput {
  const shaped: Prisma.AdCampaignWhereInput =
    AD_SHAPE_OF[place] === 'landscape'
      ? { creative: { is: { artworkLandscapeUrl: { not: null } } } }
      : { creative: { is: { artworkPortraitUrl: { not: null } } } };
  const old: Prisma.AdCampaignWhereInput = opts.requirePicture
    ? { placement: place, creative: { is: { artworkUrl: { not: null } } } }
    : { placement: place, NOT: { creative: { is: HOLDS_SHAPES } } };
  return { OR: [shaped, old] };
}

/** The bookings that could be served in at least one place (counting a view needs no place). */
export function servableAnywhereWhere(): Prisma.AdCampaignWhereInput {
  return {
    creative: {
      is: {
        OR: [
          { artworkUrl: { not: null } },
          { artworkLandscapeUrl: { not: null } },
          { artworkPortraitUrl: { not: null } },
        ],
      },
    },
  };
}

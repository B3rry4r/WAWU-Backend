import type { AdPlacement } from '../../../generated/prisma/enums';
import { AD_SHAPE_OF } from '../../ads/ads-pictures';

/**
 * What a booking's pictures and stored place will be once a request is applied
 * (ADS-LINK round 2, R-92: two shapes, not three places). One place for create
 * and edit, so they say the same thing, as ad-destination.ts does for the tap.
 *
 *   landscapeUrl  16:9, 1920 x 1080. Shows in Explore and on the Today strip.
 *   portraitUrl   1080 x 2340, a phone screen. Shows in the TGIF full screen.
 *   artworkUrl    the single picture of a booking saved before the two shapes,
 *                 with its `placement`. Still accepted for such a booking (the
 *                 body the dashboard sent until now keeps working).
 *
 * A booking holds the old single picture OR the two-shape pictures, never
 * both. Sending `landscapeUrl` or `portraitUrl` for an old booking moves it to
 * the two shapes: its own picture is carried into the shape of its own place
 * unless the request names that shape. The `placement` column of a two-shape
 * booking is only derived (explore_slider when it has a landscape picture, else
 * tgif_card) and decides nothing; where it shows follows from its pictures.
 */
export interface PictureColumns {
  placement: AdPlacement;
  artworkUrl: string | null;
  artworkLandscapeUrl: string | null;
  artworkPortraitUrl: string | null;
}

/** What a request may carry. `undefined` is "not sent"; `null` removes a picture. */
export interface PictureInput {
  placement?: AdPlacement;
  artworkUrl?: string | null;
  landscapeUrl?: string | null;
  portraitUrl?: string | null;
}

export type PictureResult =
  | { ok: true; value: PictureColumns }
  | {
      ok: false;
      /** `artwork_required` is a 422 (R-59); every other refusal is a 400. */
      code: 'artwork_required' | 'bad_artwork' | 'bad_placement';
      message: string;
    };

const refuse = (
  code: 'bad_artwork' | 'bad_placement',
  message: string,
): PictureResult => ({ ok: false, code, message });

const NO_PICTURE: PictureResult = {
  ok: false,
  code: 'artwork_required',
  message: 'Add artwork before you save this campaign',
};

/** The place a booking with the two shapes is stored under: derived, never chosen. */
export function derivedPlacement(landscape: string | null): AdPlacement {
  return landscape ? 'explore_slider' : 'tgif_card';
}

export function resolvePictures(
  prev: PictureColumns | null,
  sent: PictureInput,
): PictureResult {
  const sentShapes =
    sent.landscapeUrl !== undefined || sent.portraitUrl !== undefined;
  const sentOld = sent.artworkUrl !== undefined;
  const prevShapes =
    prev !== null &&
    (prev.artworkLandscapeUrl !== null || prev.artworkPortraitUrl !== null);

  if (sentShapes && sentOld) {
    return refuse(
      'bad_artwork',
      'Send landscapeUrl and portraitUrl, or artworkUrl, not both. artworkUrl is only for a booking saved before the two shapes.',
    );
  }

  if (sentShapes) {
    if (sent.placement !== undefined) {
      return refuse(
        'bad_placement',
        'A booking with a landscape or portrait picture takes no placement: where an ad shows follows from its pictures.',
      );
    }
    let landscape = prev?.artworkLandscapeUrl ?? null;
    let portrait = prev?.artworkPortraitUrl ?? null;
    // An old booking's single picture keeps showing where it showed: it moves
    // into the shape of its own place unless this request names that shape.
    if (prev && !prevShapes && prev.artworkUrl !== null) {
      if (AD_SHAPE_OF[prev.placement] === 'landscape')
        landscape = prev.artworkUrl;
      else portrait = prev.artworkUrl;
    }
    if (sent.landscapeUrl !== undefined) landscape = sent.landscapeUrl;
    if (sent.portraitUrl !== undefined) portrait = sent.portraitUrl;
    if (landscape === null && portrait === null) return NO_PICTURE;
    return {
      ok: true,
      value: {
        placement: derivedPlacement(landscape),
        artworkUrl: null,
        artworkLandscapeUrl: landscape,
        artworkPortraitUrl: portrait,
      },
    };
  }

  if (prevShapes) {
    if (sentOld) {
      return refuse(
        'bad_artwork',
        'This booking holds a landscape and a portrait picture. Change landscapeUrl or portraitUrl instead of artworkUrl.',
      );
    }
    if (sent.placement !== undefined) {
      return refuse(
        'bad_placement',
        'A booking with a landscape or portrait picture takes no placement: where an ad shows follows from its pictures.',
      );
    }
    return { ok: true, value: { ...prev } };
  }

  // An old booking, or a new one that sent no shape: the single picture and its place.
  const artworkUrl = sentOld
    ? (sent.artworkUrl ?? null)
    : (prev?.artworkUrl ?? null);
  if (artworkUrl === null) return NO_PICTURE;
  const placement = sent.placement ?? prev?.placement;
  if (!placement) {
    return refuse(
      'bad_placement',
      'placement is required with artworkUrl. Send landscapeUrl or portraitUrl instead and the places follow from the pictures.',
    );
  }
  return {
    ok: true,
    value: {
      placement,
      artworkUrl,
      artworkLandscapeUrl: null,
      artworkPortraitUrl: null,
    },
  };
}

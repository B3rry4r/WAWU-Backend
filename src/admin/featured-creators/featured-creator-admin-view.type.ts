/**
 * Why a featured creator is not in Explore's rail right now. The rail shows a
 * creator only while they have something live and have not turned off being
 * shown in member lists (the same two checks `PUT /admin/featured-creators/:id`
 * makes when someone is picked); either can change after the pick.
 */
export type FeaturedHiddenReason =
  'no_live_content' | 'hidden_from_member_lists' | 'not_a_creator';

/** One row of `GET /admin/featured-creators`. */
export interface FeaturedCreatorAdminView {
  wawuId: string;
  /** The creator's name from WAWU ID, else their handle, else empty. */
  name: string;
  handle: string | null;
  /** Rail order, lowest first. */
  position: number;
  /** When they were picked. */
  featuredAt: string;
  /** Live pieces they have, the number Explore's card shows. */
  pieceCount: number;
  /** False when a check above fails today; the reason says which. */
  shownInExplore: boolean;
  hiddenReason: FeaturedHiddenReason | null;
}

/** The answer of `POST /admin/featured-creators/order`: the rail as saved. */
export interface FeaturedOrderView {
  items: FeaturedCreatorAdminView[];
}

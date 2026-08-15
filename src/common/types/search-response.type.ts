import type { ContentPieceResponse } from './content-piece.type';
import type { CreatorProfile } from './user-profile.type';
import type { CommunityResponse } from './community.type';

/**
 * SearchResponse has NO Prisma model (registry: fields: []) — pure computed
 * aggregate over ContentPiece / UserProfile / Community, no storage of its
 * own.
 */

/** GET /search response.shape: "SearchResults {content,creators,communities}". */
export interface SearchResults {
  content: ContentPieceResponse[];
  creators: CreatorProfile[];
  communities: CommunityResponse[];
}

/** GET /search/suggestions response.shape. */
export interface SearchSuggestions {
  recentSearches: string[];
  popularSearches: string[];
  suggestedCreators: CreatorProfile[];
}

/** GET /search/closest response.shape (fuzzy no-results fallback). */
export interface ClosestSearchResult {
  items: ContentPieceResponse[];
}

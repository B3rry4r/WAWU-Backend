/**
 * EXPLORE-05. The numbers behind "Recent" and "People are searching". None of
 * them comes from a design figure: the artboards draw four recent searches and
 * five popular ones as examples only.
 *
 * PROVISIONAL(SEARCH-RECENT-KEPT, owner=YOU, why=no ruling says how many recent searches a person keeps; twenty is a working figure and the oldest go first)
 * PROVISIONAL(SEARCH-RECENT-SHOWN, owner=YOU, why=X5 draws four recent chips as an example; ten is what the answer carries and the app shows what fits)
 * PROVISIONAL(SEARCH-POPULAR-MIN-PEOPLE, owner=YOU, why=a search is shown to everybody only when this many different people searched it, so one person's private text never reaches the list)
 * PROVISIONAL(SEARCH-POPULAR-DAYS, owner=YOU, why=no ruling gives the window for popular; thirty days keeps the list current)
 * PROVISIONAL(SEARCH-POPULAR-SHOWN, owner=YOU, why=X5 draws five popular chips as an example; eight is the most the answer carries)
 */
export const RECENT_SEARCHES_KEPT = 20;
export const RECENT_SEARCHES_SHOWN = 10;
export const POPULAR_MIN_PEOPLE = 3;
export const POPULAR_WINDOW_DAYS = 30;
export const POPULAR_SEARCHES_SHOWN = 8;

/**
 * GET /search/popular is public, and its ranking reads every public name, so
 * the answer is kept in the process for this long (lead ruling, 16 Oct 2026).
 * A search made by an account that has just asked for its deletion can show in
 * the list for up to this long.
 */
export const POPULAR_CACHE_SECONDS = 60;

/**
 * EXPLORE-06, R-57 (owner, 16 Oct 2026): a community is named in "People are
 * searching" only once it has this many members, the number its row shows
 * (`memberCount`: people other than the host whose membership is `joined`).
 * Content titles, creator handles and categories are not held to it.
 *
 * It is the admin setting `popular_community_min_members` (launch value 10, in
 * src/plan-settings/plan-settings.defaults.json), a whole number of 1 or more
 * (0 would list every community). HOME-17: SearchHistoryService reads it from
 * the registry every time the answer is built, so an admin's edit changes the
 * list with no restart (and the kept answer is dropped the moment the figure
 * differs from the one it was built with). The environment variable
 * `POPULAR_COMMUNITY_MIN_MEMBERS` that EXPLORE-06 read is retired: nothing
 * reads it.
 *
 * `POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT` is the launch value for a spec that
 * wants to name it; a spec checks it equals the registry's, and no production
 * code reads it.
 */
export const POPULAR_COMMUNITY_MIN_MEMBERS_KEY =
  'popular_community_min_members';
export const POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT = 10;

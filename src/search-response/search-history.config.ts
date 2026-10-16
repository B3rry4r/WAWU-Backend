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

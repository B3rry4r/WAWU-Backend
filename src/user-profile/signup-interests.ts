import { EXPLORE_CATEGORY_IDS } from '../explore/explore-categories';

/**
 * The most interests A12 takes: every chip it draws. The chips are Explore's
 * categories (EXPLORE-03), so one list serves the sign-up pick, Explore and the
 * people suggested at the end of sign-up.
 */
export const MAX_SIGNUP_INTERESTS = EXPLORE_CATEGORY_IDS.length;

/**
 * How many interests A12 asks for before it lets a person on ("Pick three or
 * more"). The app reads it from `GET /users/me/interests`; it is never typed on
 * a screen.
 *
 * PROVISIONAL(SIGNUP-MIN-INTERESTS, owner=YOU, why=the canvas says "Pick three or more" and no ruling sets the number; three is what A12 draws and the feed needs a few to tune itself)
 */
export const MIN_SIGNUP_INTERESTS = 3;

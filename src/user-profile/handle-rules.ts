/**
 * The rules for a username, which is the profile's handle shown as @handle (SIGNUP-NAMES, R-82).
 *
 * The characters and the length are the ones `PATCH /users/me` already checks
 * (`UpdateUserProfileDto.handle`: letters, numbers, underscores and dots, at most 30), so a name that
 * sign-up takes is a name Edit profile takes. Three things are new and apply only on the two routes built for
 * it, `PUT /users/me/identity` (sign-up) and `PUT /users/me/handle` (Edit profile): a name is unique ignoring
 * case ("Ada" and "ada" are one name), a short list of words that would pass for WAWU itself is kept back, and
 * a name needs at least one letter or number. `PATCH /users/me` is a route the web calls and keeps its old
 * rules until the web follows after launch (BACKEND_GAPS G-SIGNUP-NAMES-1).
 */
export const HANDLE_MAX = 30;
export const HANDLE_PATTERN = /^[a-zA-Z0-9_.]+$/;
/** A name made only of dots and underscores (".", "..", "_") has nothing to read, so one letter or digit is required. */
export const HANDLE_NEEDS = /[a-zA-Z0-9]/;

/** PROVISIONAL(SIGNUP-RESERVED-HANDLES, owner=YOU, why=no ruling lists the words kept back; these would read as the company or an official account). Words nobody may take as a username, compared ignoring case. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'help',
  'login',
  'logout',
  'me',
  'moderator',
  'official',
  'root',
  'settings',
  'signup',
  'staff',
  'support',
  'system',
  'wawu',
  'wawuafrica',
  'whomadethis',
  'whomadethisapp',
  'www',
]);

export const HANDLE_MESSAGES = {
  empty: 'Choose a username.',
  characters: 'Use letters, numbers, dots and underscores.',
  needsLetter: 'A username needs at least one letter or number.',
  tooLong: `A username can be at most ${HANDLE_MAX} characters.`,
  reserved: 'That username is not available. Try another.',
  taken: 'That username is taken. Try another.',
  alreadySet: 'You already have a username. Change it in Edit profile.',
} as const;

export type HandleShape =
  { ok: true; handle: string } | { ok: false; message: string };

/** The typed value without a leading "@" or spaces around it, then checked for shape. */
export function checkHandleShape(
  typed: string | null | undefined,
): HandleShape {
  const handle = (typed ?? '').trim().replace(/^@+/, '');
  if (handle === '') return { ok: false, message: HANDLE_MESSAGES.empty };
  if (handle.length > HANDLE_MAX) {
    return { ok: false, message: HANDLE_MESSAGES.tooLong };
  }
  if (!HANDLE_PATTERN.test(handle)) {
    return { ok: false, message: HANDLE_MESSAGES.characters };
  }
  if (!HANDLE_NEEDS.test(handle)) {
    return { ok: false, message: HANDLE_MESSAGES.needsLetter };
  }
  if (RESERVED_HANDLES.has(handle.toLowerCase())) {
    return { ok: false, message: HANDLE_MESSAGES.reserved };
  }
  return { ok: true, handle };
}

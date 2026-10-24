/**
 * The rules for a username, which is the profile's handle shown as @handle (SIGNUP-NAMES, R-82).
 *
 * The characters and the length are the ones `PATCH /users/me` already checks
 * (`UpdateUserProfileDto.handle`: letters, numbers, underscores and dots, at most 30), so a name that
 * sign-up takes is a name Edit profile takes. Two things are new and apply only where a username is
 * chosen at sign-up: a name is unique ignoring case ("Ada" and "ada" are one name), and a short list of
 * words that would pass for WAWU itself is kept back.
 */
export const HANDLE_MAX = 30;
export const HANDLE_PATTERN = /^[a-zA-Z0-9_.]+$/;

/** PROVISIONAL(SIGNUP-RESERVED-HANDLES, owner=YOU, why=no ruling lists the words kept back; these would read as the company or an official account). Words nobody may take as a username, compared ignoring case. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'help',
  'moderator',
  'official',
  'staff',
  'support',
  'system',
  'wawu',
  'wawuafrica',
  'whomadethis',
  'whomadethisapp',
]);

export const HANDLE_MESSAGES = {
  empty: 'Choose a username.',
  characters: 'Use letters, numbers, dots and underscores.',
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
  if (RESERVED_HANDLES.has(handle.toLowerCase())) {
    return { ok: false, message: HANDLE_MESSAGES.reserved };
  }
  return { ok: true, handle };
}

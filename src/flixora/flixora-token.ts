import { createHmac, randomUUID } from 'node:crypto';
import type { PartnerPerson } from '../movie-partner/movie-partner.interface';
import type { FlixoraSettings } from './flixora-settings';

/**
 * The sign-in link (FLIX-02, R-75; docs/flixora/PARTNER-API.md "Sign users
 * in"). The token is an HS256 JWT signed with the environment's sign-in
 * secret; the link carries it after `#`, so it never reaches a server log.
 * Both are made for one tap and returned to the caller, never stored and
 * never logged here.
 */

/** "exp 60 s is plenty" (the docs). */
export const SIGN_IN_TOKEN_SECONDS = 60;

/** The only audience Flixora accepts. */
export const FLIXORA_AUDIENCE = 'flixora';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Signs the token for one person. Only the claims the docs list, and only
 * what the seam was given: the permanent id (`sub`), email, first and last
 * name and whether WAWU verified the email (R-75). A blank name is left out
 * rather than sent empty. `jti` is new on every call (each token works once).
 */
export function signInToken(
  settings: Pick<FlixoraSettings, 'partnerSlug' | 'ssoSecret'>,
  person: PartnerPerson,
  now: Date,
  jti: string = randomUUID(),
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SIGN_IN_TOKEN_SECONDS;
  const firstName = person.firstName.trim();
  const lastName = person.lastName.trim();
  const claims: Record<string, string | number | boolean> = {
    iss: settings.partnerSlug,
    aud: FLIXORA_AUDIENCE,
    sub: person.sub,
    email: person.email,
    ...(firstName !== '' ? { given_name: firstName } : {}),
    ...(lastName !== '' ? { family_name: lastName } : {}),
    email_verified: person.emailVerified === true,
    jti,
    iat,
    exp,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const signature = createHmac('sha256', settings.ssoSecret)
    .update(signingInput)
    .digest('base64url');
  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(exp * 1000),
  };
}

/**
 * A `redirect` the docs allow: it starts with `/`. Anything else (a full web
 * address, `//host`, a backslash, a control character) is dropped, and the
 * person lands on Flixora's catalog instead.
 */
export function safeRedirect(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}

/** `/` stays as it is (the docs' own example); everything that could end the fragment value is escaped. */
function fragmentValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

/**
 * `https://www.flixora.com/partner/<slug>/login#token=<token>&redirect=<path>`.
 * The token is base64url with two dots, so it needs no escaping.
 */
export function signInLink(
  settings: Pick<FlixoraSettings, 'partnerSlug' | 'siteUrl'>,
  token: string,
  redirectPath: string | null | undefined,
): string {
  const redirect = safeRedirect(redirectPath);
  const base = `${settings.siteUrl}/partner/${encodeURIComponent(settings.partnerSlug)}/login`;
  return redirect === null
    ? `${base}#token=${token}`
    : `${base}#token=${token}&redirect=${fragmentValue(redirect)}`;
}

import { bvnCheckTracker } from '../identity/identity-config';

/**
 * Limits on statements (task WALLET-27, round 2). A statement's cost grows
 * with the rows in its period, and the day cap (STATEMENT_MAX_DAYS) bounds
 * days, not rows: the verifier's load run (100,000 rows in a year, 20
 * statements at once from one address) took 39 s and took the server to
 * 1.6 GB. So a statement is both rate-limited and capped in rows.
 */

/**
 * The most movements one statement lists. A period holding more is
 * refused with `400 statement_too_large` after a count, before any row is
 * read or written into a file. Default (agent/lead), owner may override:
 * the lead's ruling of 3 Oct 2026; at about 160 bytes a line that is a file
 * of some 8 MB.
 */
export const STATEMENT_MAX_ROWS = 50_000;

type TokenRequest = { headers?: Record<string, unknown> };

/**
 * The `sub` of the bearer token, read without checking its signature: it
 * only picks a rate-limit bucket. The global ThrottlerGuard runs before
 * WawuAuthGuard, so the checked claims are not there yet; a forged token is
 * refused by WawuAuthGuard right after and reads nothing.
 */
export function bearerSubject(request: Record<string, unknown>): string {
  const auth = (request as TokenRequest).headers?.['authorization'];
  if (typeof auth !== 'string' || !/^Bearer\s+/i.test(auth)) return '';
  const payload = auth.replace(/^Bearer\s+/i, '').split('.')[1];
  if (!payload) return '';
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub.slice(0, 64) : '';
  } catch {
    return '';
  }
}

/**
 * Whose bucket a statement counts against: the person at the caller's
 * address (the address as the BVN check reads it, behind nginx). Keyed on
 * both, so people behind one carrier NAT address do not share a bucket,
 * and a token forged with someone's id can only use up that person's
 * bucket from that same address.
 */
export function statementTracker(request: Record<string, unknown>): string {
  return `${bvnCheckTracker(request)}|${bearerSubject(request)}`;
}

/**
 * PROVISIONAL(STATEMENT-RATE-LIMITS, owner=YOU, why=no ruling names how many statements a person may ask for; the lead set 5 a minute and 30 an hour after the verifier's load run)
 *
 * GET /money/statements on the app's own named throttlers (`short` and
 * `medium`, hub-throttlers.ts): at most 5 a minute and 30 an hour per
 * person per address. Default (agent/lead), owner may override.
 */
export const STATEMENT_THROTTLE = {
  short: { limit: 5, ttl: 60_000, getTracker: statementTracker },
  medium: { limit: 30, ttl: 60 * 60_000, getTracker: statementTracker },
};

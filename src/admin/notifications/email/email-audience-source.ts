import { isValidEmail } from './email-csv';
import type { CsvPerson } from './email-csv';

/** The most people read from a member list for one count or campaign. */
export const SOURCE_PERSON_CAP = 50_000;
const PAGE = 1000;
const MAX_PAGES = 100;
const PAGE_TIMEOUT_MS = 20_000;

export type MemberPeople =
  | {
      available: true;
      /** In the order given, repeats and bad addresses dropped. */
      people: Array<CsvPerson & { id?: string }>;
      /** What the list said it holds. */
      total: number;
      invalid: number;
      duplicates: number;
    }
  | { available: false; reason: string };

/**
 * Reads a paged member list: GET <base><path>?cursor=&limit= with the key in
 * X-Service-Key, answering { data: [{ email, firstName, id? }], nextCursor, total }
 * (the Voices API's audience route, and the shape asked of WAWU ID for accounts).
 * Never throws: a refusal or a network failure is `available: false` with a
 * sentence a person can read.
 */
export async function readMemberList(args: {
  base: string;
  path: string;
  key: string;
  down: string;
  missing?: string;
}): Promise<MemberPeople> {
  const people: Array<CsvPerson & { id?: string }> = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  let total = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${args.base}${args.path}`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', String(PAGE));
    let body: unknown;
    try {
      const res = await fetch(url, {
        headers: { 'X-Service-Key': args.key },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (res.status === 404 && args.missing) {
        return { available: false, reason: args.missing };
      }
      if (!res.ok) return { available: false, reason: args.down };
      body = await res.json();
    } catch {
      return { available: false, reason: args.down };
    }
    const b = body as {
      data?: unknown;
      nextCursor?: unknown;
      total?: unknown;
    } | null;
    if (!b || !Array.isArray(b.data)) {
      return { available: false, reason: args.down };
    }
    if (typeof b.total === 'number') total = b.total;
    for (const row of b.data as Array<Record<string, unknown>>) {
      const email =
        typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '';
      if (!isValidEmail(email)) invalid += 1;
      else if (seen.has(email)) duplicates += 1;
      else {
        seen.add(email);
        const first =
          typeof row.firstName === 'string' && row.firstName.trim()
            ? row.firstName.trim().slice(0, 80)
            : null;
        people.push({
          email,
          firstName: first,
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
        });
      }
    }
    cursor =
      typeof b.nextCursor === 'string' && b.nextCursor ? b.nextCursor : null;
    if (!cursor || people.length >= SOURCE_PERSON_CAP) break;
  }
  return {
    available: true,
    people,
    total: Math.max(total, people.length),
    invalid,
    duplicates,
  };
}

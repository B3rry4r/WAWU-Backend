import type { CsvPerson } from './email-csv';

export interface AudiencePlan {
  /** In the order given, up to the limit: these get the email. */
  eligible: CsvPerson[];
  /** On the suppression list: kept as skipped rows, never emailed. */
  suppressed: CsvPerson[];
}

/**
 * Walks the people in order. Anyone on the suppression list is set aside as
 * skipped; everyone else is eligible until `limit` of them are in. People
 * after the limit are not touched.
 */
export function planAudience(
  people: CsvPerson[],
  suppressed: ReadonlySet<string>,
  limit?: number,
): AudiencePlan {
  const eligible: CsvPerson[] = [];
  const skipped: CsvPerson[] = [];
  for (const p of people) {
    if (limit !== undefined && eligible.length >= limit) break;
    if (suppressed.has(p.email)) skipped.push(p);
    else eligible.push(p);
  }
  return { eligible, suppressed: skipped };
}

/** First word of a full name, for {{first_name}}. */
export function firstNameOf(
  fullName: string | null | undefined,
): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? first.slice(0, 80) : null;
}

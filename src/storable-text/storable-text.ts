import { isCleanText } from '../admin/legal-documents/policy-input';

/**
 * FIX-17. Text Postgres can take: the one rule for a query or path value.
 *
 * Postgres refuses a NUL in a text parameter (error 22021), so a `%00` in a
 * query or path value that reached a query used to answer 500. A lone UTF-16
 * surrogate is the other half of the same rule: the driver would send U+FFFD
 * in its place, so the query would run for text nobody sent. Over HTTP only
 * the NUL arrives (Express turns a percent-encoded surrogate into U+FFFD), so
 * the surrogate check guards every other way in.
 *
 * The rule is `isCleanText` (SETTINGS-02, used by SCHOOLS-04 and FIX-07) less
 * its blank half: an empty or blank value is not this rule's business (many
 * routes take `?q=` and answer 200). For any value that is not blank,
 * `isCleanText` is false exactly when it holds a NUL or a lone surrogate
 * (trimming never removes either).
 */
export function isStorableText(value: string): boolean {
  return value.trim() === '' || isCleanText(value);
}

/**
 * The refusal, naming the field. Word for word the sentence `/search` and
 * `/schools` already answer for `q` (FIX-07, SCHOOLS-04), so a client sees
 * one sentence for this fault wherever it sends it.
 */
export function unstorableTextMessage(field: string): string {
  return `${field} must have text in it, with no null characters or broken characters`;
}

/** Deep enough for any query DTO here (a list of strings is one level). */
const MAX_DEPTH = 4;

function holdsUnstorableText(value: unknown, depth: number): boolean {
  if (typeof value === 'string') return !isStorableText(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object')
    return false;
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  return children.some((v) => holdsUnstorableText(v, depth + 1));
}

/**
 * The name of the first field of one handler argument that holds text
 * Postgres cannot take, or null when there is none.
 *
 * `name` is the argument's own name when the handler reads one value
 * (`@Param('id')`, `@Query('page')`); a whole query or params object
 * (`@Query() dto`, `@Param()`) is named by the key that holds the text.
 * Only values are read, never keys: a key the handler does not declare is
 * refused by the ValidationPipe, or never read.
 */
export function firstUnstorableField(
  value: unknown,
  name: string | undefined,
): string | null {
  if (name !== undefined) return holdsUnstorableText(value, 0) ? name : null;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return holdsUnstorableText(value, 0) ? 'value' : null;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (holdsUnstorableText(v, 1)) return key;
  }
  return null;
}

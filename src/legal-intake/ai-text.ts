/**
 * Text that came from the AI provider and that a person will read or that
 * will be stored (LEGAL-01).
 *
 * Two rules, both applied wherever a model's words are kept:
 *  - no em-dash in anything a user reads (product rule): each one becomes a
 *    comma;
 *  - no NUL (U+0000): Postgres rejects it in text and in jsonb, so a model
 *    that emitted one would turn a good turn into a 500.
 */

/** Anything a person reads loses its em-dashes (product rule). */
export function withoutEmDash(text: string): string {
  return text.replace(/\s*—\s*/g, ', ').trim();
}

/** The character Postgres will not store in text. */
export function withoutNul(text: string): string {
  return text.split('\u0000').join('');
}

/** What a model said, made safe to show and to store. */
export function cleanAiText(text: string): string {
  return withoutEmDash(withoutNul(text));
}

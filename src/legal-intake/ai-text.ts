import { allQuestions } from './legal-intake-questions';

/**
 * Text that came from the AI provider and that a person will read or that
 * will be stored (LEGAL-01).
 *
 * Two rules, both applied wherever a model's words are kept:
 *  - no em-dash in anything a user reads (product rule): each one becomes a
 *    comma;
 *  - no NUL (U+0000): Postgres rejects it in text and in jsonb, so a model
 *    that emitted one would turn a good turn into a 500;
 *  - no other control character (R2-LEGAL2, CHECK-3 M-2): a stray U+0008 drew
 *    as an empty box in the brief. Tab and line breaks stay; each of the rest
 *    becomes a space, so two words never run together.
 */

/** Anything a person reads loses its em-dashes (product rule). */
export function withoutEmDash(text: string): string {
  return text.replace(/\s*—\s*/g, ', ').trim();
}

/** The character Postgres will not store in text. */
export function withoutNul(text: string): string {
  return text.split('\u0000').join('');
}

/**
 * Control characters other than tab, line feed and carriage return: the C0
 * block, DEL and the C1 block. Each becomes a space and a run of spaces
 * folds to one.
 */
export function withoutControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  const controls = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  if (!controls.test(text)) return text;
  return text.replace(controls, ' ').replace(/ {2,}/g, ' ');
}

/** What a model said, made safe to show and to store. */
export function cleanAiText(text: string): string {
  return withoutEmDash(withoutControlChars(withoutNul(text)));
}

/**
 * The question bank's own label for each option id that names a place or
 * another proper noun (R2-LEGAL3): `other_african` is "Another African
 * country" and `outside_africa` is "Outside Africa", where the plain reading
 * lost the capital ("Other african", "Outside africa"). Only an id of more
 * than one word whose label has a capital inside it, and that every question
 * using it labels the same way, is here, so a label is never put on an id
 * that means two things; every other id ("yes", "no_rush") keeps the plain
 * reading, because the model may ask its own question with it.
 */
const BANK_LABELS: ReadonlyMap<string, string> = (() => {
  const seen = new Map<string, string | null>();
  for (const q of allQuestions()) {
    for (const o of q.options ?? []) {
      if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(o.value)) continue;
      if (!/\p{Lu}/u.test(o.label.slice(1))) continue;
      const known = seen.get(o.value);
      seen.set(
        o.value,
        known === undefined || known === o.label ? o.label : null,
      );
    }
  }
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null));
})();

/**
 * A tap the assistant offers is always words (R2-LEGAL2, CHECK-3 M-1). A
 * model sometimes answers with the option's id instead of its label
 * ("business_owner", "one_only", "businessOwner"): that becomes "Business
 * owner", "One only", and an id the question bank names ("other_african")
 * becomes the bank's label. A label that is already words ("Yes, there's a
 * clause") is left alone.
 */
export function readableOption(label: string): string {
  const text = label.trim();
  const named = BANK_LABELS.get(text);
  if (named !== undefined) return named;
  let words: string | null = null;
  if (/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(text)) {
    words = text.replace(/[_-]+/g, ' ');
  } else if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(text)) {
    words = text.replace(/([A-Z])/g, ' $1').toLowerCase();
  }
  if (words === null) return text;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

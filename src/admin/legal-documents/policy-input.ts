import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * What the owner may put in a legal document (SETTINGS-02, round 2).
 *
 * PROVISIONAL(POLICY-LIMITS, owner=YOU, Default (agent), owner may override):
 * a document's date is a real calendar date from 2000-01-01 to 2100-12-31,
 * and the title, headings and bodies together are at most 60000 bytes of
 * UTF-8. The size sits well under the 100 kB the body parser allows, so an
 * accepted document can always arrive.
 */
export const POLICY_YEAR_MIN = 2000;
export const POLICY_YEAR_MAX = 2100;
export const POLICY_MAX_BYTES = 60_000;

/** `YYYY-MM-DD` that is a real date and reads back unchanged. */
export function isRealDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const year = Number(value.slice(0, 4));
  if (year < POLICY_YEAR_MIN || year > POLICY_YEAR_MAX) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** An unpaired UTF-16 code unit: Postgres refuses it in jsonb and replaces it in text. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text with something in it after trimming, no NUL and no lone surrogate. */
export function isCleanText(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\u0000') &&
    !LONE_SURROGATE.test(value)
  );
}

function decorate(
  name: string,
  check: (v: unknown) => boolean,
  message: string,
) {
  return (options?: ValidationOptions) =>
    (object: object, propertyName: string) =>
      registerDecorator({
        name,
        target: object.constructor,
        propertyName,
        options: { message, ...options },
        validator: { validate: check },
      });
}

export const IsRealDate = decorate(
  'isRealDate',
  isRealDate,
  `effectiveDate must be a real date (YYYY-MM-DD) from ${POLICY_YEAR_MIN} to ${POLICY_YEAR_MAX}`,
);
export const IsCleanText = decorate(
  'isCleanText',
  isCleanText,
  '$property must have text in it, with no null characters or broken characters',
);

const bytesOf = (v: unknown): number =>
  typeof v === 'string' ? Buffer.byteLength(v) : 0;

export const WithinPolicySize = decorate(
  'withinPolicySize',
  (sections) => {
    if (!Array.isArray(sections)) return false;
    let bytes = 0;
    for (const s of sections as { heading?: unknown; body?: unknown }[]) {
      bytes += bytesOf(s?.heading) + bytesOf(s?.body);
    }
    return bytes <= POLICY_MAX_BYTES;
  },
  `the document is too long: at most ${POLICY_MAX_BYTES} bytes of text`,
);

/** Every section is a plain object `{ heading, body }` of two strings, nothing else. */
export function isPlainSections(sections: unknown): boolean {
  if (!Array.isArray(sections) || sections.length === 0) return false;
  return sections.every((s: unknown) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return false;
    const keys = Object.keys(s).sort();
    const x = s as { heading?: unknown; body?: unknown };
    return (
      keys.length === 2 &&
      keys[0] === 'body' &&
      keys[1] === 'heading' &&
      typeof x.heading === 'string' &&
      typeof x.body === 'string'
    );
  });
}

export const IsPlainSections = decorate(
  'isPlainSections',
  isPlainSections,
  'sections must be a list of objects, each with a heading and a body',
);

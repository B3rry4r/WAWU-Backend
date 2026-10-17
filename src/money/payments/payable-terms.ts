import { createHash } from 'node:crypto';

/**
 * What a payable kind promises beyond its price (TIER-06 round 2): the goods a
 * tier purchase will grant, for one. A flat object of numbers, text and flags,
 * so it is stored as JSON on the payment and read back unchanged.
 *
 * Two things follow from the kind handing it back with its target:
 *  - the payment quote is bound to it (the quote token carries its digest), so
 *    a quote whose terms have changed since it was given answers `409
 *    quote_changed` exactly as a changed price does, before anything moves;
 *  - the payment keeps it from the moment it is claimed and hands it to the
 *    kind with the confirmed payment, so what is delivered is what was quoted,
 *    whatever the kind's own settings say by then.
 */
export type PayableTerms = Readonly<Record<string, string | number | boolean>>;

/** A short, stable digest of the terms (key order does not matter). */
export function termsDigest(terms: PayableTerms): string {
  const entries = Object.keys(terms)
    .sort()
    .map((k) => [k, terms[k]]);
  return createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Reads terms back from the JSON a payment stored: null when there are none or
 * when the stored value is not a flat object of numbers, text and flags.
 */
export function termsFromJson(value: unknown): PayableTerms | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(value)) {
    if (
      typeof v !== 'string' &&
      typeof v !== 'boolean' &&
      !(typeof v === 'number' && Number.isFinite(v))
    )
      return null;
    out[k] = v;
  }
  return out;
}

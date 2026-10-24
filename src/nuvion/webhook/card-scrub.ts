/**
 * A `cards.*` delivery is stored for review (the raw bytes and a parsed copy),
 * and a card's number, CVV and expiry must never sit in a table (WALLET-31
 * round 1, L3): Nuvion's docs show none in these events, but nothing here
 * waits to find out. Every key that could hold one is removed, at any depth,
 * before the row is written. The dedup key (`bodySha256`) is still made from
 * the bytes as they arrived, so a delivery sent again is still the same one.
 */
const SECRET_KEYS = new Set([
  'number',
  'card_number',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  'cvv2',
  'security_code',
  'expiration_month',
  'expiration_year',
  'expiry',
  'expiry_month',
  'expiry_year',
  'exp_month',
  'exp_year',
]);

/** `value` without any key that could hold a card's secret, at any depth. */
export function withoutCardSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCardSecrets);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = withoutCardSecrets(v);
    }
    return out;
  }
  return value;
}

/** True for the events a card's secrets could ride on. */
export function isCardEvent(event: string): boolean {
  return event.startsWith('cards.');
}

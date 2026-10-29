/**
 * BILLS-09 (R-102): the prepaid token and the units of a bill, read from what Flutterwave answers.
 *
 * Where Flutterwave puts them (developer.flutterwave.com, v3 Bills; the same two calls `FlutterwaveBillsClient` makes):
 *   - "Create a bill payment" (`POST /billers/{biller_code}/items/{item_code}/payment`): the answer's `data` carries
 *     `recharge_token` (and `batch_reference`). The page's example shows `recharge_token: null` and says nothing more.
 *   - "Get status of a bill payment" (`GET /bills/{reference}`): the answer's `data` carries `token` and `extra` (the
 *     "Ok" example), and `extra` again in the `verbose` example. Both are `null` in the examples and neither has a
 *     description.
 *   - Units: the pages name NO field for units. The only free-form field either answer has is `extra`, so the units
 *     are read from `units` if a biller sends one, else from the text or object in `extra`. This is a reading of
 *     where the provider puts it, not a documented field: the first real prepaid bill confirms it (gap G-BILLS-TOKEN).
 *
 * Everything read here is cleaned to a short plain string before it is stored or shown, so a provider's odd answer can
 * never put markup, a long sentence or an object in front of a person. A token is never logged.
 */
export interface BillDelivery {
  token: string | null;
  units: string | null;
}

export const NO_DELIVERY: BillDelivery = { token: null, units: null };

/** What one answer has, filled in from a second (the first one's fields win). */
export function mergeDelivery(a: BillDelivery, b: BillDelivery): BillDelivery {
  return { token: a.token ?? b.token, units: a.units ?? b.units };
}

/**
 * A bill that can carry a prepaid token. The row's `category` is what the client sent at `init`: the provider's code ("POWER",
 * "UTILITYBILLS") or its display name ("Utility Bills", "Electricity"). Airtime, data, cable and internet never carry one.
 */
export function isPowerBill(category: string | null | undefined): boolean {
  return (
    typeof category === 'string' && /power|electric|utilit/i.test(category)
  );
}

const TOKEN_KEYS = ['recharge_token', 'token', 'rechargeToken'] as const;
const UNIT_KEYS = ['units', 'unit', 'units_purchased', 'kwh'] as const;

/** A prepaid token is digits in groups (20 on the Nigerian meters); letters are allowed because billers differ. */
const TOKEN_SHAPE = /^[0-9A-Za-z][0-9A-Za-z -]{5,47}$/;
const UNITS_SHAPE = /^\d{1,9}(\.\d{1,4})?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scalarText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function cleanToken(raw: unknown): string | null {
  const text = scalarText(raw);
  if (text === null) return null;
  const cleaned = text
    .replace(/^\s*(?:recharge\s*)?token\s*[:=-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return TOKEN_SHAPE.test(cleaned) ? cleaned : null;
}

function cleanUnits(raw: unknown): string | null {
  const text = scalarText(raw);
  if (text === null) return null;
  const cleaned = text.replace(/kwh/i, '').replace(/,/g, '').trim();
  return UNITS_SHAPE.test(cleaned) ? cleaned : null;
}

function firstClean(
  source: Record<string, unknown>,
  keys: readonly string[],
  clean: (raw: unknown) => string | null,
): string | null {
  for (const key of keys) {
    const found = clean(source[key]);
    if (found !== null) return found;
  }
  return null;
}

/** `extra` is free text or an object, and the docs show neither: read a labelled token or units from either. */
function readExtra(extra: unknown): BillDelivery {
  if (isRecord(extra)) {
    return {
      token: firstClean(extra, TOKEN_KEYS, cleanToken),
      units: firstClean(extra, UNIT_KEYS, cleanUnits),
    };
  }
  if (typeof extra !== 'string') return NO_DELIVERY;
  const token = /token\s*[:=-]?\s*([0-9][0-9 -]{5,47})/i.exec(extra);
  const labelled = /units?\s*[:=-]?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(extra);
  const kwh = /(\d[\d,]*(?:\.\d+)?)\s*kwh/i.exec(extra);
  return {
    token: token ? cleanToken(token[1]) : null,
    units: cleanUnits(labelled?.[1] ?? kwh?.[1] ?? null),
  };
}

/**
 * The token and the units in one provider answer: the purchase answer's `data`, or the bill status answer's `data`
 * (an object, or a one-element array as `readProviderStatus` also allows). Anything not clearly a token or a number of
 * units is null, never a guess.
 */
export function readDelivery(payload: unknown): BillDelivery {
  const data: unknown = Array.isArray(payload)
    ? (payload as unknown[])[0]
    : payload;
  if (!isRecord(data)) return NO_DELIVERY;
  const extra = readExtra(data.extra);
  return {
    token: firstClean(data, TOKEN_KEYS, cleanToken) ?? extra.token,
    units: firstClean(data, UNIT_KEYS, cleanUnits) ?? extra.units,
  };
}

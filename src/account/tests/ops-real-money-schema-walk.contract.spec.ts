import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NOT_MONEY_TABLES,
  REAL_MONEY_TABLES,
  WALLET_PROVIDER_TABLES,
} from '../../../scripts/ops/real-money-rows';

/**
 * OPS-DEL-TEST round 2: the real-money list cannot silently miss a table. Every Prisma model with a money-looking
 * field must be in the refusal list (REAL_MONEY_TABLES), the wallet-provider list or the not-money list (each with a
 * reason). A new money table fails this spec until someone classifies it.
 */
const MONEY_FIELD =
  /kobo|amount|price|fee|txref|tx_ref|flutterwave|payment|provider|balance|paid/i;

/** Model name to its field names, read from the schema file. */
export function schemaModels(schema: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const fields = m[2]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('/') && !l.startsWith('@@'))
      .map((l) => l.split(/\s+/)[0]);
    out.set(m[1], fields);
  }
  return out;
}

export function unclassified(
  models: Map<string, string[]>,
  classified: Set<string>,
): string[] {
  return [...models]
    .filter(
      ([n, f]) => f.some((x) => MONEY_FIELD.test(x)) && !classified.has(n),
    )
    .map(([n]) => n)
    .sort();
}

describe('real-money list covers the schema (OPS-DEL-TEST round 2)', () => {
  const models = schemaModels(
    readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf8'),
  );
  const real = new Set(REAL_MONEY_TABLES.map((t) => t.model));
  const wallet = new Set(Object.keys(WALLET_PROVIDER_TABLES));
  const notMoney = new Set(Object.keys(NOT_MONEY_TABLES));

  it('every model with a money-looking field is classified', () => {
    expect(
      unclassified(models, new Set([...real, ...wallet, ...notMoney])),
    ).toEqual([]);
  });

  it('the walk does fail on a missing table', () => {
    const withoutLegal = new Set([...real, ...wallet, ...notMoney]);
    withoutLegal.delete('LegalRequest');
    withoutLegal.delete('WaitlistRegistration');
    expect(unclassified(models, withoutLegal)).toEqual([
      'LegalRequest',
      'WaitlistRegistration',
    ]);
  });

  it('the Flutterwave tables the first list missed are refusals', () => {
    for (const m of [
      'LegalRequest',
      'WaitlistRegistration',
      'ServiceApplication',
      'StorePurchase',
      'StoreSubscription',
      'FintavaLedgerEntry',
    ]) {
      expect(real.has(m)).toBe(true);
    }
  });

  it('no model is in two lists, every listed model exists, every reason is said', () => {
    const all = [...real, ...wallet, ...notMoney];
    expect(new Set(all).size).toBe(all.length);
    for (const n of all) expect(models.has(n)).toBe(true);
    for (const r of [
      ...Object.values(WALLET_PROVIDER_TABLES),
      ...Object.values(NOT_MONEY_TABLES),
    ])
      expect(r.length).toBeGreaterThan(10);
    for (const t of REAL_MONEY_TABLES) {
      expect(t.why.length).toBeGreaterThan(10);
      for (const c of t.columns) expect(models.get(t.model)).toContain(c);
    }
  });
});

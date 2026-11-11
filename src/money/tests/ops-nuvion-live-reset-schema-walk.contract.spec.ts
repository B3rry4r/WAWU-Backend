import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND_TABLE,
  STEPS,
} from '../../../scripts/ops/nuvion-live-reset-kinds';

/**
 * NUV-LIVE: the reset command cannot silently miss a kind of row. Every Prisma model that holds a Nuvion id, a
 * `provider` column (or one named for a provider's id), an entity id or a BVN claim must be classified in KIND_TABLE,
 * each with a reason. A new such table fails this spec until someone decides what the reset does to it.
 */
export const HOLDS_NUVION =
  /^(provider|walletProvider|paymentProvider|bvnHash|entityId|fromEntityId|toEntityId|ban|customerId|walletId|accountId)$|^nuvion|^provider(?!Fee)[A-Z]|[cC]ounterpartyId$|[pP]aymentDetailId$|^fintava[A-Z]|[tT]ransactionId$|^(merchant|destination|recipient)AccountNumber$/i;

/** The regex round 0 shipped. It missed counterpartyId, paymentDetailId and fintava* columns (SchoolPayee, WalletBill). */
const NARROW =
  /^(provider|walletProvider|paymentProvider|bvnHash|entityId|fromEntityId|toEntityId|ban)$|^nuvion|^provider(?!Fee)[A-Z]/i;

/** Model name to its field names, read from the schema file. */
function schemaModels(schema: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    out.set(
      m[1],
      m[2]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('/') && !l.startsWith('@@'))
        .map((l) => l.split(/\s+/)[0]),
    );
  }
  return out;
}

function flagged(
  models: Map<string, string[]>,
  holds: RegExp = HOLDS_NUVION,
): string[] {
  return [...models]
    .filter(([n, f]) => /^Nuvion/.test(n) || f.some((x) => holds.test(x)))
    .map(([n]) => n)
    .sort();
}

describe('the Nuvion live reset covers the schema (NUV-LIVE)', () => {
  const models = schemaModels(
    readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf8'),
  );
  const classified = new Set(Object.keys(KIND_TABLE));

  it('every model with a Nuvion id or a provider column is classified', () => {
    expect(flagged(models).filter((n) => !classified.has(n))).toEqual([]);
  });

  it('the walk does fail on a missing model', () => {
    const without = new Set(classified);
    without.delete('WalletCard');
    without.delete('NuvionEntity');
    expect(flagged(models).filter((n) => !without.has(n))).toEqual([
      'NuvionEntity',
      'WalletCard',
    ]);
  });

  it('SchoolPayee and WalletBill are flagged, and classified', () => {
    for (const n of ['SchoolPayee', 'WalletBill', 'SchoolSettlement']) {
      expect(flagged(models)).toContain(n);
      expect(classified.has(n)).toBe(true);
    }
  });

  it('the regex fails a narrower one: a fake model with each kind of provider id column is flagged', () => {
    const fake = (col: string) =>
      schemaModels(`model Fake {\n  id String @id\n  ${col} String?\n}\n`);
    for (const col of [
      'counterpartyId',
      'paymentDetailId',
      'fintavaReference',
      'fintavaTransactionId',
      'providerTransactionId',
      'destinationAccountNumber',
      'merchantAccountNumber',
      'customerId',
      'walletId',
      'nuvionOrderId',
      'provider',
    ]) {
      expect(flagged(fake(col))).toEqual(['Fake']);
    }
    // The round 0 regex missed these, which is how SchoolPayee got through: a narrower regex fails here.
    for (const col of [
      'counterpartyId',
      'paymentDetailId',
      'fintavaReference',
    ]) {
      expect(flagged(fake(col), NARROW)).toEqual([]);
    }
    // And a column with no provider id in it is not flagged.
    expect(flagged(fake('title'))).toEqual([]);
    // Run over the real schema, the narrow regex leaves models unclassified that the wide one finds.
    const missed = flagged(models).filter(
      (n) => !flagged(models, NARROW).includes(n),
    );
    expect(missed).toEqual(
      expect.arrayContaining(['SchoolPayee', 'WalletBill']),
    );
  });

  it('every classified model exists, has a reason, and every step names a classified model', () => {
    for (const [n, k] of Object.entries(KIND_TABLE)) {
      expect(models.has(n)).toBe(true);
      expect(k.why.length).toBeGreaterThan(20);
      expect(k.why).not.toContain('—');
    }
    for (const s of STEPS) expect(classified.has(s.model)).toBe(true);
  });

  it('every model a step deletes or updates is not marked untouched, and every untouched one has no step', () => {
    const stepModels = new Set(STEPS.map((s) => s.model));
    for (const [n, k] of Object.entries(KIND_TABLE)) {
      if (k.action === 'untouched') expect(stepModels.has(n)).toBe(false);
    }
    // Every acting kind is done by a step, apart from the three with their own code or a cascade.
    const own = new Set(['PointConversion', 'WalletPaymentFx']);
    for (const [n, k] of Object.entries(KIND_TABLE)) {
      if (k.action !== 'untouched' && k.action !== 'follows' && !own.has(n))
        expect(stepModels.has(n)).toBe(true);
    }
  });
});

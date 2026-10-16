import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * TIER-01: "A person's billing currency, once set, never changes through any
 * route." The behaviour is proved over HTTP in plans.contract.spec.ts; this
 * proves there is no other way in: in all of `src/`, the only code that
 * writes PersonBilling is BillingCurrencyService.fixAtFirstPurchase, and it
 * only inserts, skipping a row that exists. No update, upsert or raw SQL
 * anywhere. The account purge removes the row by its generic walk of the
 * purge map, which deletes the person, never switches their currency.
 */

const SRC = join(__dirname, '..', '..');
const ALLOWED = 'plans/billing-currency.service.ts';

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

const WRITE =
  /personBilling\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/g;
const RAW = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?PersonBilling"?/gi;

describe('who can write a billing currency (TIER-01)', () => {
  const writes: string[] = [];
  const raw: string[] = [];
  beforeAll(() => {
    for (const path of files(SRC)) {
      const text = readFileSync(path, 'utf8');
      const where = relative(SRC, path).split(sep).join('/');
      for (const m of text.matchAll(WRITE)) writes.push(`${where} ${m[1]}`);
      for (const m of text.matchAll(RAW)) raw.push(`${where} ${m[0]}`);
    }
  });

  it('only the first-purchase fix writes it, and only by inserting', () => {
    expect(writes).toEqual([`${ALLOWED} createMany`]);
  });

  it('the insert skips a person who already has one', () => {
    const text = readFileSync(join(SRC, ALLOWED), 'utf8');
    expect(text).toMatch(
      /createMany\(\{[\s\S]*?skipDuplicates: true[\s\S]*?\}\)/,
    );
  });

  it('no raw SQL inserts, updates or deletes it', () => {
    expect(raw).toEqual([]);
  });
});

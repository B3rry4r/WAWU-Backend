import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_DATA_MAP,
  NOT_A_USER_REFERENCE,
  rowsToDelete,
} from '../account-data-map';

/**
 * THE DRIFT GUARD.
 *
 * A purge is only as complete as its list of places to look, and that list
 * rots the moment somebody adds a table without updating it - silently, and
 * in the one operation where leaving personal data behind is least
 * acceptable.
 *
 * So this reads prisma/schema.prisma, finds every column that names a WAWU
 * user, and fails if any of them is missing from ACCOUNT_DATA_MAP. The fix
 * when it fails is never to widen the regex: it is to open
 * account-data-map.ts and say what happens to the new table.
 */
function schemaColumns(): Array<{ model: string; column: string }> {
  const schema = readFileSync(
    join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const found: Array<{ model: string; column: string }> = [];
  for (const m of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
    const [, model, body] = m;
    for (const c of body.matchAll(/^\s+(\w*[Ww]awu\w*)\s+\S/gm)) {
      found.push({ model, column: c[1] });
    }
  }
  return found;
}

describe('account data map', () => {
  const key = (r: { model: string; column: string }) => `${r.model}.${r.column}`;

  it('classifies every WAWU user column in the schema', () => {
    const classified = new Set([
      ...ACCOUNT_DATA_MAP.map(key),
      ...NOT_A_USER_REFERENCE.map(key),
    ]);
    const unclassified = schemaColumns()
      .map(key)
      .filter((k) => !classified.has(k));

    // Read the failure as: "a table now carries a user id and nobody has
    // said what deleting that user does to it."
    expect(unclassified).toEqual([]);
  });

  it('does not name a model or column the schema no longer has', () => {
    const real = new Set(schemaColumns().map(key));
    const stale = [...ACCOUNT_DATA_MAP, ...NOT_A_USER_REFERENCE]
      .map(key)
      .filter((k) => !real.has(k));

    // A stale entry is worse than a missing one: it reads as coverage.
    expect(stale).toEqual([]);
  });

  it('deletes the account profile last, after everything that references it', () => {
    const order = rowsToDelete().map((r) => r.model);
    expect(order.at(-1)).toBe('UserProfile');
    expect(order.at(-2)).toBe('CreatorState');
  });

  it('never deletes an audit record or a row belonging to someone else', () => {
    const deleted = new Set(rowsToDelete().map(key));
    for (const r of ACCOUNT_DATA_MAP) {
      if (r.disposition === 'AUDIT' || r.disposition === 'COUNTERPARTY') {
        expect(deleted.has(key(r))).toBe(false);
      }
    }
  });
});

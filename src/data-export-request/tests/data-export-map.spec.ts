import { ACCOUNT_DATA_MAP } from '../../account-purge/account-data-map';
import { EXPORT_EXCLUDED, EXPORT_SECTIONS } from '../data-export-sections';

/**
 * THE EXPORT'S DRIFT GUARD (SETTINGS-04).
 *
 * The purge map (account-data-map.ts) says where an account's own data lives.
 * Every one of those models must be either in the export or on the list of
 * things the export leaves out on purpose, so a new table cannot be added to
 * the deletion and silently forgotten by the export. The fix when this fails
 * is to open data-export-sections.ts and decide, never to loosen this test.
 */
describe('data export map', () => {
  const own = [
    ...new Set(
      ACCOUNT_DATA_MAP.filter(
        (r) => r.disposition === 'OWNED' || r.disposition === 'AUTHORED',
      ).map((r) => r.model),
    ),
  ];
  const exported = new Set(EXPORT_SECTIONS.flatMap((s) => s.models));
  const excluded = new Set(EXPORT_EXCLUDED.map((e) => e.model));

  it('decides every model the account owns: exported or excluded with a reason', () => {
    const undecided = own.filter((m) => !exported.has(m) && !excluded.has(m));
    expect(undecided).toEqual([]);
  });

  it('never both exports and excludes the same model', () => {
    expect([...exported].filter((m) => excluded.has(m))).toEqual([]);
  });

  it('names no model the purge map does not know', () => {
    const known = new Set(ACCOUNT_DATA_MAP.map((r) => r.model));
    // ProfileExperience and the like are in the map; anything else is stale.
    expect([...exported, ...excluded].filter((m) => !known.has(m))).toEqual([]);
  });

  it('gives every exclusion a reason a reader can act on', () => {
    for (const e of EXPORT_EXCLUDED) expect(e.reason.length).toBeGreaterThan(8);
  });

  it('uses each section key once', () => {
    const keys = EXPORT_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

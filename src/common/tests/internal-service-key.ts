import * as fs from 'fs';
import * as path from 'path';

/**
 * The internal service key the mock WAWU ID is running with.
 *
 * There is ONE key and three things that have to agree on it: the mock, which
 * guards `/internal/*`; the Hub API's WawuIdClient, which sends it; and a
 * handful of contract tests that call `/internal/*` directly to set a fixture
 * up. When they disagree the failure is silent and misleading — the lookup
 * 401s, every creator name quietly falls back to its handle, and it reads as
 * a name-resolution bug rather than a key mismatch. That cost eight failing
 * tests across four unrelated suites.
 *
 * So all three resolve it the same way, in the same order:
 *   1. an explicit override, for pointing at a mock started by hand
 *   2. the repo's own .env, which is what the Hub API actually sends
 *   3. the mock's built-in dev default
 *
 * mock-wawu-id/server.js implements exactly this, and says on boot which one
 * it landed on.
 */
export function resolveInternalServiceKey(): string {
  const override =
    process.env.MOCK_WAWU_ID_INTERNAL_SERVICE_KEY ??
    process.env.WAWU_ID_INTERNAL_SERVICE_KEY;
  if (override) return override;

  try {
    // __dirname is src/common/tests at run time under ts-jest.
    const envFile = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '.env'),
      'utf8',
    );
    const line = envFile
      .split('\n')
      .find((l) => l.trim().startsWith('WAWU_ID_INTERNAL_SERVICE_KEY='));
    if (line) {
      const value = line
        .slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  } catch {
    // No .env in this checkout — fall through to the dev default.
  }

  return 'dev-internal-service-key-not-secret';
}

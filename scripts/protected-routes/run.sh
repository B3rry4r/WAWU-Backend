#!/usr/bin/env bash
# The protected route suite (MONEY-01), run against any branch: V3.
#
#   scripts/protected-routes/run.sh                 # this checkout, as it is
#   scripts/protected-routes/run.sh <ref>           # the code at <ref>, checked
#                                                   # against the lock at origin/main
#   scripts/protected-routes/run.sh --fresh <ref>   # same, on a freshly created,
#                                                   # migrated and seeded database
#
# With a <ref>, the CODE comes from <ref> and the SUITE and the LOCK
# (src/protected-routes, test/protected-routes, .pipeline/protected-registry.json)
# come from $PROTECTED_LOCK_REF (default origin/main), so an edit to a branch's
# own copy of the lock is not what it is checked against. Nothing is checked out: <ref> is
# exported with `git archive` into a temporary directory, so the working tree,
# its branch and its uncommitted changes are never touched.
#
# Needs: DATABASE_URL pointing at a disposable test database (the suite refuses
# a name without "test" or "protected" in it), Postgres reachable, and either a
# mock WAWU ID at $WAWU_ID_BASE_URL or a free port there (the suite starts one).
# Exit code is the suite's: 0 green, non-zero red.
set -euo pipefail

FRESH=0
if [ "${1:-}" = "--fresh" ]; then FRESH=1; shift; fi
REF="${1:-}"
LOCK_REF="${PROTECTED_LOCK_REF:-origin/main}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

: "${DATABASE_URL:?Set DATABASE_URL to a disposable test database}"
# Refuse a database that is not local and disposable BEFORE anything touches
# it: both branches below migrate, and --fresh drops it. Same rule as the suite
# (test/protected-routes/db-snapshot.ts), checked here first because the suite
# itself only runs after the migrate.
node -e '
  const u = new URL(process.env.DATABASE_URL);
  const host = u.hostname;
  const name = u.pathname.slice(1);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    console.error(`refusing: DATABASE_URL host "${host}" is not this machine`);
    process.exit(1);
  }
  if (!/test|protected/i.test(name)) {
    console.error(`refusing: database "${name}" does not look like a test database (needs "test" or "protected" in its name)`);
    process.exit(1);
  }
'

export WAWU_ID_BASE_URL="${WAWU_ID_BASE_URL:-http://localhost:4001}"
export WAWU_ID_JWKS_URL="${WAWU_ID_JWKS_URL:-$WAWU_ID_BASE_URL/.well-known/jwks.json}"

if [ -z "$REF" ]; then
  WORK="$REPO"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/protected-routes.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  echo "code:  $REF ($(git -C "$REPO" rev-parse --short "$REF"))"
  echo "lock:  $LOCK_REF ($(git -C "$REPO" rev-parse --short "$LOCK_REF"))"
  git -C "$REPO" archive "$REF" | tar -x -C "$WORK"
  rm -rf "$WORK/src/protected-routes" "$WORK/test/protected-routes"
  if ! git -C "$REPO" cat-file -e "$LOCK_REF:src/protected-routes" 2>/dev/null; then
    echo "refusing: $LOCK_REF has no protected route suite (set PROTECTED_LOCK_REF to a ref that has one)" >&2
    exit 1
  fi
  git -C "$REPO" archive "$LOCK_REF" src/protected-routes test/protected-routes .pipeline/protected-registry.json \
    | tar -x -C "$WORK"
  if cmp -s "$REPO/package-lock.json" "$WORK/package-lock.json" && [ -d "$REPO/node_modules" ]; then
    ln -s "$REPO/node_modules" "$WORK/node_modules"
  else
    (cd "$WORK" && npm ci --no-audit --no-fund >/dev/null)
  fi
  if [ -d "$REPO/mock-wawu-id/node_modules" ] && [ ! -e "$WORK/mock-wawu-id/node_modules" ]; then
    ln -s "$REPO/mock-wawu-id/node_modules" "$WORK/mock-wawu-id/node_modules"
  fi
fi

cd "$WORK"
npx prisma generate >/dev/null

if [ "$FRESH" = 1 ]; then
  node -e '
    const { Client } = require("pg");
    const url = new URL(process.env.DATABASE_URL);
    const name = url.pathname.slice(1);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test|protected/i.test(name)) {
      console.error(`refusing to recreate ${url.hostname}/${name}`);
      process.exit(1);
    }
    url.pathname = "/postgres";
    const c = new Client({ connectionString: url.toString() });
    (async () => {
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${name}"`);
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  '
  npx prisma migrate deploy >/dev/null
  npm run --silent db:seed >/dev/null
else
  # The code under test may carry new (additive) migrations.
  npx prisma migrate deploy >/dev/null
fi

# Jest runs with a config written HERE, not the one in the code under test's
# package.json, and the result is checked here too: a branch must not be able
# to make the suite pass by excluding it (testPathIgnorePatterns,
# passWithNoTests, a narrowed testRegex). Every locked entry must have run and
# passed, plus the two whole-registry tests.
OUT="$(mktemp -d "${TMPDIR:-/tmp}/protected-routes-run.XXXXXX")"
cat > "$OUT/jest.json" <<JSON
{
  "rootDir": "$WORK/src",
  "moduleFileExtensions": ["js", "json", "ts"],
  "testRegex": "protected-routes/.*\\\\.spec\\\\.ts\$",
  "transform": {
    "^.+\\\\.(t|j)s\$": ["ts-jest", { "tsconfig": { "module": "commonjs", "moduleResolution": "node", "resolvePackageJsonExports": false } }]
  },
  "transformIgnorePatterns": ["node_modules/(?!(jose)/)"],
  "moduleNameMapper": { "^(\\\\.{1,2}/.*)\\\\.js\$": "\$1" },
  "testEnvironment": "node"
}
JSON
set +e
npx jest --config "$OUT/jest.json" --runInBand --forceExit \
  --json --outputFile="$OUT/result.json"
JEST_STATUS=$?
set -e
node -e '
  const fs = require("fs");
  const [resultFile, registryFile] = process.argv.slice(1);
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const entries = JSON.parse(fs.readFileSync(registryFile, "utf8")).protectedRoutes.routes.length;
  const suite = result.testResults.find((t) => t.name.endsWith("protected-routes.regression.spec.ts"));
  const passed = suite ? suite.assertionResults.filter((a) => a.status === "passed").length : 0;
  const ran = suite ? suite.assertionResults.length : 0;
  const want = entries + 2;
  if (ran !== want || passed !== want || result.numFailedTests !== 0 || result.numPendingTests !== 0) {
    console.error(`protected route suite: ${passed} of ${want} required tests passed (${ran} ran, ${result.numFailedTests} failed, ${result.numPendingTests} skipped)`);
    process.exit(1);
  }
  console.log(`protected route suite: all ${want} required tests passed`);
' "$OUT/result.json" "$WORK/.pipeline/protected-registry.json" || JEST_STATUS=1
rm -rf "$OUT"
exit "$JEST_STATUS"

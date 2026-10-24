#!/usr/bin/env node
/**
 * Builds src/geo/data/regions.json (GEO-02 round 2, lead ruling): the ISO 3166-2
 * subdivisions the Hub serves at GET /geo/countries/{code}/regions and checks a
 * saved region against.
 *
 *   node scripts/geo/build-regions.mjs          write the file
 *   node scripts/geo/build-regions.mjs --check  exit 1 if the committed file is not what this builds
 *
 * Source of truth for every code and name: `iso-3166` 4.4.0 (MIT, wooorm), a
 * devDependency pinned to the exact version. It is ESM-only and big, so it is read
 * here, at build time, and the result is committed as plain JSON: the Hub reads the
 * JSON at run time and imports neither package. The type of a region ("State",
 * "Province", "County" ...) comes from `@koshmoney/countries` 1.0.1 where it lists
 * the same code, else TYPE_FIXES below, else "Region".
 *
 * Region codes are stored on profiles, so a code must be ISO's for every country.
 * The only changes made to what iso-3166 says are in the tables below, each with
 * the reason. There are no others, and `tests/geo-iso-lists.spec.ts` checks the
 * JSON against this script and against hand-written ISO lists for seven countries.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iso31661, iso31662 } from 'iso-3166';
import { subdivision } from '@koshmoney/countries';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/geo/data/regions.json',
);

/**
 * Left out. iso-3166 is not wrong about these; they are not places a person lives.
 */
const EXCLUDED = {
  'GB-EAW': 'ISO groups England and Wales; it is not a place a person lives',
  'GB-GBN': 'ISO groups Great Britain; it is not a place a person lives',
  'GB-UKM': 'ISO groups the United Kingdom; offering it as a region of itself helps nobody',
  // iso-3166 4.4.0 still lists Ghana's old Brong-Ahafo beside the three regions that
  // replaced it in 2019 (Ahafo, Bono, Bono East), so Ghana would have 17, not ISO's 16.
  'GH-BA': 'retired in 2019: split into GH-AF, GH-BO and GH-BE; ISO 3166-2:GH has 16 regions',
};

/**
 * Renamed. iso-3166 spells these differently from ISO's own list.
 */
const RENAMED = {
  'ZA-KZN': 'KwaZulu-Natal', // iso-3166: "Kwazulu-Natal"
  'ZA-NW': 'North West', // iso-3166: "North-West"
};

/**
 * Typed here because the code is a newer one and @koshmoney/countries still carries
 * the old, so it has no entry to take the type from.
 */
const TYPE_FIXES = {
  'ZA-GP': 'Province', // koshmoney has the retired ZA-GT
  'ZA-KZN': 'Province', // koshmoney has the retired ZA-NL
  'GB-ABC': 'District council area',
  'GB-AND': 'District council area',
  'GB-ANN': 'District council area',
  'GB-CCG': 'District council area',
  'GB-DRS': 'District council area',
  'GB-FMO': 'District council area',
  'GB-LBC': 'District council area',
  'GB-MEA': 'District council area',
  'GB-MUL': 'District council area',
  'GB-NMD': 'District council area',
  'GB-BCP': 'Unitary authority',
  'GB-NNH': 'Unitary authority',
  'GB-WNH': 'Unitary authority',
};

const countries = new Set(iso31661.map((c) => c.alpha2));
const typeOf = new Map(subdivision.all().map((s) => [s.code.toUpperCase(), s.type]));

const regions = {};
for (const s of iso31662) {
  if (s.code in EXCLUDED) continue;
  const country = s.code.split('-')[0];
  if (!countries.has(country)) {
    throw new Error(`${s.code} belongs to ${country}, which is not an ISO 3166-1 country`);
  }
  (regions[country] ??= []).push({
    code: s.code,
    name: RENAMED[s.code] ?? s.name,
    type: TYPE_FIXES[s.code] ?? typeOf.get(s.code) ?? 'Region',
  });
}
for (const code of [...Object.keys(EXCLUDED), ...Object.keys(RENAMED), ...Object.keys(TYPE_FIXES)]) {
  if (!iso31662.some((s) => s.code === code)) {
    throw new Error(`${code} is in a correction table but iso-3166 does not list it: remove the entry`);
  }
}
for (const [code, name] of Object.entries(RENAMED)) {
  if (iso31662.find((s) => s.code === code).name === name) {
    throw new Error(`${code} already reads "${name}" in iso-3166: remove the rename`);
  }
}

const sorted = Object.fromEntries(
  Object.keys(regions)
    .sort()
    .map((country) => [
      country,
      regions[country].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    ]),
);
const text = `${JSON.stringify(
  {
    source: 'iso-3166@4.4.0',
    types: '@koshmoney/countries@1.0.1 where the code matches, else the table in scripts/geo/build-regions.mjs, else Region',
    excluded: EXCLUDED,
    renamed: RENAMED,
    regions: sorted,
  },
  null,
  1,
)}\n`;

if (process.argv.includes('--check')) {
  const have = readFileSync(OUT, 'utf8');
  if (have !== text) {
    console.error('src/geo/data/regions.json is not what scripts/geo/build-regions.mjs builds: run it and commit the result.');
    process.exit(1);
  }
  console.log('regions.json is current');
} else {
  writeFileSync(OUT, text);
  const n = Object.values(sorted).reduce((sum, list) => sum + list.length, 0);
  console.log(`wrote ${OUT}: ${Object.keys(sorted).length} countries, ${n} regions`);
}

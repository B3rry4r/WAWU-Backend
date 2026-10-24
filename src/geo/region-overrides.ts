import type { GeoRegionView } from './geo.types';

/**
 * The reviewed corrections to the region lists (GEO-02 round 1, lead ruling).
 *
 * `@koshmoney/countries` 1.0.1 is the structure of the lists, and for most
 * countries it is right, but a verifier found some wrong against ISO 3166-2:
 * South Africa's names are vernacular and two codes are the retired ones, Ghana
 * still has ten regions, Great Britain lists three groupings and a set of
 * councils that no longer exist. Each correction below is written by hand from
 * ISO 3166-2 and pinned by `tests/geo-iso-lists.spec.ts`, which holds the ISO
 * list for NG, US, GB, GH, KE, ZA and CA and fails when the data and the ISO
 * list part. A country not here is the package's as it comes.
 *
 * A bump of the package may fix a country; the spec then still passes and the
 * entry here is dead weight (the spec `every correction still changes
 * something` fails, so the entry is removed in the same change).
 */

/** Whole lists replaced: the package's list for these countries is not ISO's. */
export const REGION_REPLACEMENTS: Readonly<Record<string, GeoRegionView[]>> = {
  // ISO 3166-2:ZA. The package has the old codes (ZA-GT, ZA-NL) and Sotho/Zulu names.
  ZA: [
    { code: 'ZA-EC', name: 'Eastern Cape', type: 'Province' },
    { code: 'ZA-FS', name: 'Free State', type: 'Province' },
    { code: 'ZA-GP', name: 'Gauteng', type: 'Province' },
    { code: 'ZA-KZN', name: 'KwaZulu-Natal', type: 'Province' },
    { code: 'ZA-LP', name: 'Limpopo', type: 'Province' },
    { code: 'ZA-MP', name: 'Mpumalanga', type: 'Province' },
    { code: 'ZA-NC', name: 'Northern Cape', type: 'Province' },
    { code: 'ZA-NW', name: 'North West', type: 'Province' },
    { code: 'ZA-WC', name: 'Western Cape', type: 'Province' },
  ],
  // ISO 3166-2:GH since the 2018 referendum: 16 regions, Brong-Ahafo split in three.
  GH: [
    { code: 'GH-AF', name: 'Ahafo', type: 'Region' },
    { code: 'GH-AH', name: 'Ashanti', type: 'Region' },
    { code: 'GH-BO', name: 'Bono', type: 'Region' },
    { code: 'GH-BE', name: 'Bono East', type: 'Region' },
    { code: 'GH-CP', name: 'Central', type: 'Region' },
    { code: 'GH-EP', name: 'Eastern', type: 'Region' },
    { code: 'GH-AA', name: 'Greater Accra', type: 'Region' },
    { code: 'GH-NE', name: 'North East', type: 'Region' },
    { code: 'GH-NP', name: 'Northern', type: 'Region' },
    { code: 'GH-OT', name: 'Oti', type: 'Region' },
    { code: 'GH-SV', name: 'Savannah', type: 'Region' },
    { code: 'GH-UE', name: 'Upper East', type: 'Region' },
    { code: 'GH-UW', name: 'Upper West', type: 'Region' },
    { code: 'GH-TV', name: 'Volta', type: 'Region' },
    { code: 'GH-WP', name: 'Western', type: 'Region' },
    { code: 'GH-WN', name: 'Western North', type: 'Region' },
  ],
};

/** Codes taken out of a list: not a place a person lives, or no longer a place. */
export const REGION_REMOVALS: Readonly<Record<string, readonly string[]>> = {
  GB: [
    // ISO's groupings, not places.
    'GB-EAW',
    'GB-GBN',
    'GB-UKM',
    // Northern Ireland's 26 districts, replaced by 11 councils in 2015.
    'GB-ANT',
    'GB-ARD',
    'GB-ARM',
    'GB-BLA',
    'GB-BLY',
    'GB-BNB',
    'GB-CGV',
    'GB-CKF',
    'GB-CKT',
    'GB-CLR',
    'GB-CSR',
    'GB-DGN',
    'GB-DOW',
    'GB-DRY',
    'GB-FER',
    'GB-LMV',
    'GB-LRN',
    'GB-LSB',
    'GB-MFT',
    'GB-MYL',
    'GB-NDN',
    'GB-NTA',
    'GB-NYM',
    'GB-OMH',
    'GB-STB',
    // England's councils merged in 2019 and 2021.
    'GB-BMH',
    'GB-POL',
    'GB-NTH',
  ],
};

/** Entries added to a list: places ISO has that the package does not. */
export const REGION_ADDITIONS: Readonly<Record<string, GeoRegionView[]>> = {
  GB: [
    {
      code: 'GB-ABC',
      name: 'Armagh City, Banbridge and Craigavon',
      type: 'District council area',
    },
    {
      code: 'GB-AND',
      name: 'Ards and North Down',
      type: 'District council area',
    },
    {
      code: 'GB-ANN',
      name: 'Antrim and Newtownabbey',
      type: 'District council area',
    },
    {
      code: 'GB-BCP',
      name: 'Bournemouth, Christchurch and Poole',
      type: 'Unitary authority',
    },
    {
      code: 'GB-CCG',
      name: 'Causeway Coast and Glens',
      type: 'District council area',
    },
    {
      code: 'GB-DRS',
      name: 'Derry and Strabane',
      type: 'District council area',
    },
    {
      code: 'GB-FMO',
      name: 'Fermanagh and Omagh',
      type: 'District council area',
    },
    {
      code: 'GB-LBC',
      name: 'Lisburn and Castlereagh',
      type: 'District council area',
    },
    {
      code: 'GB-MEA',
      name: 'Mid and East Antrim',
      type: 'District council area',
    },
    { code: 'GB-MUL', name: 'Mid-Ulster', type: 'District council area' },
    {
      code: 'GB-NMD',
      name: 'Newry, Mourne and Down',
      type: 'District council area',
    },
    {
      code: 'GB-NNH',
      name: 'North Northamptonshire',
      type: 'Unitary authority',
    },
    {
      code: 'GB-WNH',
      name: 'West Northamptonshire',
      type: 'Unitary authority',
    },
  ],
};

/** A region's name as ISO writes it, where the package writes it another way. */
export const REGION_RENAMES: Readonly<Record<string, string>> = {
  'GB-BFS': 'Belfast City',
  'GB-DUR': 'Durham, County',
  'GB-RCT': 'Rhondda Cynon Taff',
  'GB-SCB': 'Scottish Borders',
  'US-VI': 'United States Virgin Islands',
};

/** One country's list with the corrections applied. Does not touch `list`. */
export function applyRegionOverrides(
  country: string,
  list: readonly GeoRegionView[],
): GeoRegionView[] {
  const replaced = REGION_REPLACEMENTS[country];
  if (replaced) return replaced.map((r) => ({ ...r }));
  const removed = new Set(REGION_REMOVALS[country] ?? []);
  const out = list
    .filter((r) => !removed.has(r.code))
    .map((r) => ({ ...r, name: REGION_RENAMES[r.code] ?? r.name }));
  const have = new Set(out.map((r) => r.code));
  for (const added of REGION_ADDITIONS[country] ?? []) {
    if (!have.has(added.code)) out.push({ ...added });
  }
  return out;
}

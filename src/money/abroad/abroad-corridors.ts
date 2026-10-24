/**
 * Where a person can send money abroad, and what Nuvion asks to pay each
 * place (task NUV-11, R-84). Nothing here is invented: every rail and its
 * fields come from Nuvion's "Send a payout" table and from what the dev
 * server answered on 24 Oct 2026 (mobile repo docs/nuvion/DEV-RESULTS.md,
 * section NUV-11): the fields a payment detail was refused without, and the
 * ones the transfer itself was refused without (a US bank needs the bank's
 * address and the account type only at the transfer). A field dev did not ask
 * for and the docs do (the SEPA BIC) is left out; Nuvion's own refusal of one
 * comes back as `recipient_details_invalid` naming it. Where the docs and dev
 * disagree dev wins (Australia asks for a `bsb`, not a bank and branch code).
 *
 * The form is built from this: a person is asked for exactly the fields of
 * the country and rail they chose, never one list for every country.
 */

/** A field's kind tells the app which input to draw. */
export type AbroadFieldKind =
  'text' | 'digits' | 'bank' | 'phone' | 'email' | 'choice';

export interface AbroadFieldDef {
  /** The key Nuvion calls it (`account_number`), or `bank_address_line1`. */
  key: string;
  label: string;
  kind: AbroadFieldKind;
  /** A JavaScript pattern the value must match, or null. */
  pattern: string | null;
  hint: string | null;
  /** For `choice`. */
  options?: { value: string; label: string }[];
}

export interface AbroadSchemeDef {
  id: string;
  label: string;
  speed: string;
  /** Fields this scheme asks beyond the rail's own (replace, not add, when set). */
  fields?: string[];
}

export interface AbroadRailDef {
  /** `bank` or `mobile_money`: one of each at most per country, except where schemes say. */
  method: 'bank' | 'mobile_money';
  label: string;
  /** How long Nuvion's table says the money takes (the slowest scheme's, when several). */
  speed: string;
  /** The schemes a person picks from; a rail with none has one scheme Nuvion infers (`inferred`). */
  schemes: AbroadSchemeDef[];
  /** The scheme Nuvion infers when the rail has no choice. */
  inferred: string | null;
  /** The field keys asked (see FIELDS), in the order drawn. */
  fields: string[];
  /** Docs: the smallest and largest the rail takes, in the destination currency's smallest unit; null = none stated. */
  minMinor: number | null;
  maxMinor: number | null;
  /** Nuvion has a bank directory for the country (`GET /bank-codes/{country}`): the `bank` field is a picker. */
  directory: boolean;
}

export interface AbroadCountryDef {
  country: string;
  name: string;
  currency: string;
  rails: AbroadRailDef[];
}

const text = (
  key: string,
  label: string,
  hint: string | null = null,
): AbroadFieldDef => ({
  key,
  label,
  kind: 'text',
  pattern: null,
  hint,
});

/** Every field a rail can ask, keyed as Nuvion keys it. */
export const FIELDS: Record<string, AbroadFieldDef> = {
  bank: { key: 'bank', label: 'Bank', kind: 'bank', pattern: null, hint: null },
  bank_name: text('bank_name', 'Bank name'),
  account_number: {
    key: 'account_number',
    label: 'Account number',
    kind: 'digits',
    pattern: '^[0-9A-Za-z -]{4,34}$',
    hint: null,
  },
  sort_code: {
    key: 'sort_code',
    label: 'Sort code',
    kind: 'digits',
    pattern: '^[0-9]{6}$',
    hint: '6 digits',
  },
  iban: {
    key: 'iban',
    label: 'IBAN',
    kind: 'text',
    pattern: '^[A-Za-z]{2}[0-9]{2}[0-9A-Za-z]{10,30}$',
    hint: null,
  },
  swift_bic: {
    key: 'swift_bic',
    label: 'SWIFT or BIC code',
    kind: 'text',
    pattern: '^[A-Za-z]{4}[A-Za-z]{2}[0-9A-Za-z]{2}([0-9A-Za-z]{3})?$',
    hint: '8 or 11 characters',
  },
  routing_number: {
    key: 'routing_number',
    label: 'Routing number',
    kind: 'digits',
    pattern: '^[0-9]{9}$',
    hint: '9 digits',
  },
  account_type: {
    key: 'account_type',
    label: 'Account type',
    kind: 'choice',
    pattern: null,
    hint: null,
    options: [
      { value: 'checking', label: 'Checking' },
      { value: 'savings', label: 'Savings' },
    ],
  },
  bank_institution_number: {
    key: 'bank_institution_number',
    label: 'Institution number',
    kind: 'digits',
    pattern: '^[0-9]{3}$',
    hint: '3 digits',
  },
  transit_number: {
    key: 'transit_number',
    label: 'Transit number',
    kind: 'digits',
    pattern: '^[0-9]{5}$',
    hint: '5 digits',
  },
  branch_code: {
    key: 'branch_code',
    label: 'Branch code',
    kind: 'text',
    pattern: '^[0-9A-Za-z-]{1,12}$',
    hint: null,
  },
  bsb: {
    key: 'bsb',
    label: 'BSB',
    kind: 'digits',
    pattern: '^[0-9]{6}$',
    hint: '6 digits',
  },
  phone_number: {
    key: 'phone_number',
    label: 'Mobile money number',
    kind: 'phone',
    pattern: '^\\+[1-9][0-9]{7,14}$',
    hint: 'With the country code, like +233',
  },
  email: {
    key: 'email',
    label: 'Email address',
    kind: 'email',
    pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
    hint: null,
  },
  bank_code: text('bank_code', 'Bank code'),
  bank_address_line1: text('bank_address_line1', "Bank's street address"),
  bank_address_city: text('bank_address_city', "Bank's city"),
  bank_address_state: text('bank_address_state', "Bank's state or province"),
  bank_address_postal_code: text(
    'bank_address_postal_code',
    "Bank's postal code",
  ),
};

const BANK_ADDRESS = [
  'bank_address_line1',
  'bank_address_city',
  'bank_address_state',
  'bank_address_postal_code',
];

const bank = (
  r: Partial<AbroadRailDef> & Pick<AbroadRailDef, 'fields' | 'speed'>,
): AbroadRailDef => ({
  method: 'bank',
  label: 'Bank account',
  schemes: [],
  inferred: null,
  minMinor: null,
  maxMinor: null,
  directory: false,
  ...r,
});

const momo = (
  schemes: AbroadSchemeDef[],
  limits: { minMinor: number; maxMinor: number },
): AbroadRailDef => ({
  method: 'mobile_money',
  label: 'Mobile money',
  speed: 'Instant',
  schemes,
  inferred: null,
  fields: ['phone_number'],
  directory: false,
  ...limits,
});

const sepa = (country: string, name: string): AbroadCountryDef => ({
  country,
  name,
  currency: 'EUR',
  rails: [
    bank({
      speed: 'Same day',
      inferred: 'sepa',
      fields: ['bank_name', 'iban'],
    }),
  ],
});

/** The countries, in the order the app lists them (Africa and the usual homes first). */
export const ABROAD_COUNTRIES: readonly AbroadCountryDef[] = [
  {
    country: 'GH',
    name: 'Ghana',
    currency: 'GHS',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'gh_eft',
        directory: true,
        fields: ['bank', 'account_number'],
      }),
      momo(
        [
          { id: 'mtn', label: 'MTN', speed: 'Instant' },
          { id: 'vodafone', label: 'Vodafone', speed: 'Instant' },
          { id: 'airtel', label: 'AirtelTigo', speed: 'Instant' },
        ],
        { minMinor: 500, maxMinor: 2_500_000 },
      ),
    ],
  },
  {
    country: 'KE',
    name: 'Kenya',
    currency: 'KES',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'ke_eft',
        directory: true,
        fields: ['bank', 'account_number'],
      }),
      momo(
        [
          { id: 'mpesa', label: 'M-Pesa', speed: 'Instant' },
          { id: 'airtel', label: 'Airtel Money', speed: 'Instant' },
          { id: 'telkom', label: 'T-Kash', speed: 'Instant' },
        ],
        { minMinor: 2_000, maxMinor: 25_000_000 },
      ),
    ],
  },
  {
    country: 'TZ',
    name: 'Tanzania',
    currency: 'TZS',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'tz_eft',
        directory: true,
        fields: ['bank', 'account_number'],
      }),
      momo(
        [
          { id: 'vodacom', label: 'M-Pesa (Vodacom)', speed: 'Instant' },
          { id: 'airtel', label: 'Airtel Money', speed: 'Instant' },
          { id: 'tigo', label: 'Mixx by Yas (Tigo)', speed: 'Instant' },
          { id: 'halotel', label: 'Halopesa', speed: 'Instant' },
        ],
        { minMinor: 100_000, maxMinor: 500_000_000 },
      ),
    ],
  },
  {
    country: 'UG',
    name: 'Uganda',
    currency: 'UGX',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'ug_eft',
        directory: true,
        fields: ['bank', 'account_number'],
      }),
    ],
  },
  {
    country: 'ZA',
    name: 'South Africa',
    currency: 'ZAR',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'rtc',
        directory: true,
        fields: ['bank', 'account_number'],
      }),
    ],
  },
  {
    country: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'fps',
        fields: ['bank_name', 'sort_code', 'account_number'],
      }),
    ],
  },
  {
    country: 'US',
    name: 'United States',
    currency: 'USD',
    rails: [
      bank({
        speed: 'Same or next day',
        schemes: [
          { id: 'ach', label: 'ACH', speed: 'Same or next day' },
          { id: 'wire', label: 'Wire', speed: 'Same day' },
          { id: 'rtp', label: 'Instant (RTP)', speed: 'Instant' },
        ],
        fields: [
          'bank_name',
          'routing_number',
          'account_number',
          'account_type',
          ...BANK_ADDRESS,
        ],
      }),
    ],
  },
  {
    country: 'CA',
    name: 'Canada',
    currency: 'CAD',
    rails: [
      bank({
        speed: 'Same or next day',
        schemes: [
          {
            id: 'eft',
            label: 'Bank transfer (EFT)',
            speed: 'Same or next day',
          },
          {
            id: 'interac_account',
            label: 'Interac to an account',
            speed: 'Instant',
          },
          {
            id: 'interac_email',
            label: 'Interac e-Transfer by email',
            speed: 'Instant',
            fields: ['email'],
          },
        ],
        fields: [
          'bank_name',
          'bank_institution_number',
          'transit_number',
          'account_number',
        ],
      }),
    ],
  },
  {
    country: 'AU',
    name: 'Australia',
    currency: 'AUD',
    rails: [
      bank({
        speed: '1 to 2 business days',
        inferred: 'becs',
        fields: ['bank_name', 'bsb', 'account_number'],
      }),
    ],
  },
  {
    country: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    rails: [
      bank({
        speed: 'Same or next day',
        inferred: 'uae_local',
        fields: ['bank_name', 'iban', 'swift_bic'],
      }),
    ],
  },
  sepa('DE', 'Germany'),
  sepa('FR', 'France'),
  sepa('IE', 'Ireland'),
  sepa('ES', 'Spain'),
  sepa('IT', 'Italy'),
  sepa('NL', 'Netherlands'),
  sepa('BE', 'Belgium'),
  sepa('PT', 'Portugal'),
  sepa('AT', 'Austria'),
  sepa('FI', 'Finland'),
  sepa('GR', 'Greece'),
  sepa('LU', 'Luxembourg'),
  {
    country: 'CN',
    name: 'China',
    currency: 'CNY',
    rails: [
      bank({
        speed: 'Same day',
        inferred: 'wire',
        fields: ['bank_name', 'swift_bic', 'account_number'],
      }),
    ],
  },
  {
    country: 'HK',
    name: 'Hong Kong',
    currency: 'HKD',
    rails: [
      bank({
        speed: 'Instant',
        inferred: 'hk_chats',
        directory: true,
        fields: ['bank', 'branch_code', 'account_number'],
      }),
    ],
  },
  {
    country: 'SG',
    name: 'Singapore',
    currency: 'SGD',
    rails: [
      bank({
        speed: 'Instant',
        inferred: 'fast',
        fields: ['bank_name', 'swift_bic', 'account_number'],
      }),
    ],
  },
  {
    country: 'MX',
    name: 'Mexico',
    currency: 'MXN',
    rails: [
      bank({
        speed: 'Instant',
        inferred: 'clabe',
        label: 'Bank account (CLABE)',
        fields: ['account_number'],
      }),
    ],
  },
  {
    country: 'PH',
    name: 'Philippines',
    currency: 'PHP',
    rails: [
      bank({
        speed: 'Same day',
        schemes: [
          { id: 'insta_pay', label: 'InstaPay', speed: 'Instant' },
          { id: 'pesonet', label: 'PESONet', speed: 'Same day' },
        ],
        fields: ['bank_name', 'bank_code', 'account_number'],
      }),
    ],
  },
];

/**
 * Countries Nuvion's dev server refuses a transfer to or from (24 Oct 2026):
 * "The value 'UGX' is not supported for currency yet". They are listed as
 * not available until an admin empties `abroad.corridors_off`.
 */
export const DEV_REFUSED_COUNTRIES: readonly string[] = [
  'UG',
  'MX',
  'SG',
  'HK',
];

export function countryOf(code: string): AbroadCountryDef | null {
  return ABROAD_COUNTRIES.find((c) => c.country === code) ?? null;
}

export function railOf(
  country: AbroadCountryDef,
  method: 'bank' | 'mobile_money',
): AbroadRailDef | null {
  return country.rails.find((r) => r.method === method) ?? null;
}

/**
 * The field keys asked for a rail and scheme: the scheme's own list when it
 * has one, else the rail's.
 */
export function fieldKeysFor(
  rail: AbroadRailDef,
  scheme: string | null,
): string[] {
  const s = rail.schemes.find((x) => x.id === scheme);
  return s?.fields ?? rail.fields;
}

/** Smallest unit of a destination currency, per the docs ("the smallest currency unit"). */
export const ABROAD_DECIMALS = 2;

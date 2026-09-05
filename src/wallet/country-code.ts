/**
 * Flutterwave wants an ISO 3166-1 alpha-2 country code. WAWU ID's `country`
 * claim carries a full name ("Nigeria"), because that is what somebody picks
 * on a sign-up form.
 *
 * Handing the name straight through is what it looks like when a mock is more
 * permissive than the real thing: every local test passed, and the first real
 * call came back "country length must be 2 characters long".
 *
 * Only the countries this product actually serves are listed. An unknown value
 * falls back to NG rather than failing the call: the alternative is refusing to
 * open a wallet for somebody whose profile says something we did not predict,
 * and a wrong country on a NGN wallet at a Nigerian bank costs nothing, while a
 * creator who cannot be paid costs them.
 */
const ALPHA2_BY_NAME: Record<string, string> = {
  nigeria: 'NG',
  ghana: 'GH',
  kenya: 'KE',
  'south africa': 'ZA',
  uganda: 'UG',
  tanzania: 'TZ',
  rwanda: 'RW',
  'cote d’ivoire': 'CI',
  "cote d'ivoire": 'CI',
  'ivory coast': 'CI',
  cameroon: 'CM',
  senegal: 'SN',
  egypt: 'EG',
  'united kingdom': 'GB',
  'united states': 'US',
};

export function toAlpha2(country: string | null | undefined): string {
  const raw = (country ?? '').trim();
  if (!raw) return 'NG';
  // Already a code.
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return ALPHA2_BY_NAME[raw.toLowerCase()] ?? 'NG';
}

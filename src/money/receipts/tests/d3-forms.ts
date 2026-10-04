import { foldDigits } from '../receipt-document';

/** Every form the round-2 verifier listed (vw18r2/probe/seed2.js, rows d3_*), and what the public page may show. */
export const D3_FORMS: [string, string][] = [
  ['MTN 0803_123_4567', 'MTN •••• 4567'],
  ['MTN 0803,123,4567', 'MTN •••• 4567'],
  ['MTN 0803 123 4567 0805 987 6543', 'MTN •••• 6543'],
  ['MTN 08031234567/08059876543', 'MTN •••• 6543'],
  ['MTN ０８０３１２３４５６７', 'MTN •••• 4567'],
  ['MTN ٠٨٠٣١٢٣٤٥٦٧', 'MTN •••• 4567'],
  ['MTN ۰۸۰۳۱۲۳۴۵۶۷', 'MTN •••• 4567'],
  ['MTN ०८०३१२३४५६७', 'MTN •••• 4567'],
  ['MTN 0803x123x4567', 'MTN •••• 4567'],
  ['MTN +234 (0) 803 123 4567', 'MTN •••• 4567'],
  ['MTN 0803 – 123 – 4567', 'MTN •••• 4567'],
  ['MTN 0803\u00a0123\u00a04567', 'MTN •••• 4567'],
  ['MTN 0803·123·4567', 'MTN •••• 4567'],
  ['MTN 0803:123:4567', 'MTN •••• 4567'],
  ['MTN 0803\u200b123\u200b4567', 'MTN •••• 4567'],
  ['MTN 080\u00ad31234567', 'MTN •••• 4567'],
  ['MTN ⁰⁸⁰³¹²³⁴⁵⁶⁷', 'MTN •••• 4567'],
  ['MTN ⓪⑧⓪③①②③④⑤⑥⑦', 'MTN •••• 4567'],
  ['MTN 𝟎𝟖𝟎𝟑𝟏𝟐𝟑𝟒𝟓𝟔𝟕', 'MTN •••• 4567'],
  ['GTBank 0123456789', 'GTBank •••• 6789'],
  ['GTBank 012 345 6789', 'GTBank •••• 6789'],
  ['GTBank ０１２３４５６７８９', 'GTBank •••• 6789'],
  ['GTBank acct0123x456x789', 'GTBank acct•••• 6789'],
  ['Shop 12 Lekki Phase 1', 'Shop 12 Lekki Phase 1'],
];

/** The longest run of digits a text shows once digits are folded and everything but digits and • is ignored. */
export function visibleDigits(text: string): number {
  return Math.max(
    0,
    ...foldDigits(text)
      .replace(/[^\d•]/g, '')
      .split('•')
      .map((r) => r.length),
  );
}

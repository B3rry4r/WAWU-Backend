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
  // Round 3's verifier (vw18r3/probe/seed3.js, rows d3b_*):
  ['MTN ⓿❽⓿❸❶❷❸❹❺❻❼', 'MTN •••• 4567'],
  ['MTN ➇➂➀➁➂➃➄➅➆', 'MTN •••• 4567'],
  ['MTN ⓼⓷⓵⓶⓷⓸⓹⓺⓻', 'MTN •••• 4567'],
  ['MTN ፰፫፩፪፫፬፭፮፯', 'MTN •••• 4567'],
  ['MTN 0803 x 123 x 4567', 'MTN •••• 4567'],
  ['MTN 0803x 1234567', 'MTN •••• 4567'],
  ['MTN 0803X123X4567', 'MTN •••• 4567'],
  ['MTN 0803xx123xx4567', 'MTN •••• 4567'],
  ['MTN 0803 X 123-4567', 'MTN •••• 4567'],
  ['MTN 0\u03018\u03010\u03013\u0301 1\u03012\u03013 4567', 'MTN •••• 4567'],
  ['MTN 0803\u200f123\u200f4567', 'MTN •••• 4567'],
  [
    'MTN \u20660803\u2069\u2067123\u2069\u20684567\u2069',
    'MTN \u2066•••• 4567\u2069',
  ],
  ['MTN ٠٨٠3 １２３ ४५६७', 'MTN •••• 4567'],
  ['MTN 0٨0۳-१２3–4⁵67', 'MTN •••• 4567'],
  ['MTN + 234 803 123 4567', 'MTN + •••• 4567'],
  ['MTN 0803½1234567', 'MTN •••• 4567'],
  ['MTN 0803…123…4567', 'MTN •••• 4567'],
  ['GTBank ⓿❶❷❸❹❺❻❼❽❾', 'GTBank •••• 6789'],
  // Lead ruling, round 4: digits split by a letter other than x are separate numbers.
  ['MTN 0803 Ada 1234567', 'MTN 0803 Ada •••• 4567'],
  ['Shop 12 Lekki Phase 1', 'Shop 12 Lekki Phase 1'],
  // Round 4's verifier (vw18r4, finding 1): Unicode 15 to 17 digits, Kaktovik numerals and Yangqin signs.
  ['MTN 𝋀𝋈𝋀𝋃𝋁𝋂𝋃𝋄𝋅𝋆𝋇', 'MTN •••• 4567'],
  ['MTN 0803𝋁𝋂𝋃𝋄𝋅𝋆𝋇', 'MTN •••• 4567'],
  ['GTBank 𝋀𝋁𝋂𝋃𝋄𝋅𝋆𝋇𝋈𝋉', 'GTBank •••• 6789'],
  ['MTN 080312345𖿴𖿶', 'MTN •••• 4512'],
  ['MTN 𝋀8𜳰3𝋁2𜳳4𝋅6𜳷', 'MTN •••• 4567'],
  ['MTN 08031234𖿴𖿶𝋉', 'MTN •••• 4129'],
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

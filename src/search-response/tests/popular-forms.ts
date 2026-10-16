/**
 * Texts the popular list is tried with (EXPLORE-05 round 3). Shared by
 * search-popular-allowlist and popular-name specs; not a spec itself.
 */

// The forms the round 2 verifier reached the public list with (finding 1),
// that carry a digit run, a symbol or a letter of another script. Each is made
// the exact name of a public room in the spec, so the equality gate is met and the
// character rule is the only thing left to refuse it.
export const REFUSED_BY_CHARACTER_RULE = [
  // phones
  '0801,234,5678',
  '0801:234:5678',
  '0801*234*5678',
  '0801+234+5678',
  '0801|234|5678',
  '0801#234#5678',
  '0801~234~5678',
  "0801'234'5678",
  '0801;234;5678',
  '0801x234x5678',
  '0801–234–5678', // en dash
  '0801—234—5678', // em dash
  '0801−234−5678', // minus sign
  '0801·234·5678', // middle dot
  '08🔥01🔥234🔥5678',
  '0️⃣8️⃣0️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣', // keycap digits
  '0̷8̷0̷1̷2̷3̷4̷5̷6̷7̷8̷', // digits with a combining mark
  '0,8,0,1,2,3,4,5,6,7,8',
  '❶❷❸❹❺❻❼❽❾⓿❶', // circled digits
  '零八零一二三四五六七八', // Chinese numerals
  '08O1l34567B', // homoglyph letters
  'Call me 0801,234,5678',
  'Pay 08O1l34567B now',
  '123456',
  '0801.234.5678',
  '(0801) 234 5678',
  '0801/234/5678',
  '0801_234_5678',
  '٠٨٠١٢٣٤٥٦٧٨', // Arabic-Indic digits
  '०८०१२३४५६७८', // Devanagari digits
  '０８０１２３４５６７８', // full-width digits
  '+234 801 234 5678',
  '08012345678',
  '0801-234-5678',
  // emails
  'chidinma@gmail.com',
  'chidinma(at)gmail.com',
  'chidinma[at]gmail[dot]com',
  'chidinma_gmail_com',
  'chidinma_at_gmail_dot_com',
  'chidinma (a) gmail (.) com',
  'chidinma dоt com', // a Cyrillic o in "dot"
  // links
  'https://evil.example/claim-your-prize',
  'www.example',
  'evil.example',
  'bit.ly/abc',
  'evil。example', // ideographic full stop
  'evil[.]example',
  'evil(.)example',
  'evil·example',
  'evil,example',
  'evil;com',
  '10.0.0.1/evil',
  'instagram chidinma_okafor',
  'evil.example/claim-your-prize',
  // invisible characters inside a word
  'afro​beats',
  'afro‍beats',
  'af­robeats',
  'afro‮beats',
  // the false refusals the lead accepted (docs: the character rule)
  'node.js course',
  'asp.net core',
  'mr.beast',
];

/**
 * Forms from the round 2 verifier's finding 1 that are only letters, spaces
 * and hyphens. The character rule cannot refuse a word, so each of these can
 * be shown if (and only if) a public thing is named exactly so and three
 * accounts search it. That needs an account to turn creator and name a
 * community with that text: the owner question in tasks/EXPLORE-05.md.
 */
export const LETTERS_ONLY_FORMS = [
  'zero eight zero one two three four five six seven eight',
  'chidinma gmail',
  'chidinma okafor gmail com',
  'chidinmagmailcom',
  'chidinma-gmail',
  'gmail',
  'yahoo mail',
  'hxxps evil example',
  'evil example com',
  'telegram me',
  'whatsapp me',
];

/** Names that are shown. */
export const SHOWN_NAMES = [
  'Afrobeats',
  "Women's Health",
  'Rock & Roll',
  'Hip-Hop',
  'Top 10 Songs',
  'Lagos 2026',
  'Cafe au Lait',
  'Café',
  'Nnamdi Azikiwe',
  'S\u0323\u0300ango', // S, dot below, grave: a Yoruba letter with its marks
  'Ọ̀rúnmìlà',
];

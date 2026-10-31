/**
 * MOD-ROOMS (R-122). The words and phrases Who Made This does not accept in anything a person writes for others to read.
 * Apple App Review guideline 1.2 asks for "a method for filtering objectionable material from being posted"; this list is
 * that method. It is read by one function (`content-filter.ts`), applied to every text a person sends or saves
 * (comment, room message, chat message, paid question and answer, profile name and bio, piece, event and community
 * names and descriptions), and an admin can read it (`GET /admin/moderation/words`).
 *
 * HOW AN ENTRY IS WRITTEN. Lower-case letters and single spaces only: no accents, digits or punctuation. The matcher folds
 * what a person types to this form first (accents off, `0 1 3 4 5 7 @ $ !` back to letters, a `*` as any one letter), so
 * "F.u.c.k", "f*ck", "sh1t" and "fuuuuck" all meet "fuck". A word is whole-word only: "Scunthorpe", "class" and "assess"
 * are never hit. Two short lists beside the groups (below) are the exceptions: STRONG_WORDS are caught inside longer words
 * too, and ALLOWED_PHRASES and ALLOWED_WORDS are never refused. A trailing `~` means the word also takes the common endings (s, es, ed, er, ers, ing, in, y), so
 * `fuck~` covers fucks, fucked, fucker and fucking. A doubled letter in an entry must be doubled (or more) in the text,
 * so "ass" words do not hit the plain word "as".
 *
 * WHAT IS NOT HERE ON PURPOSE. Mild words (damn, hell, idiot, stupid, fool, mumu, yeye), words with an everyday meaning
 * that is not abuse (ass, cock, dick, hoe, cum, rape on its own), and words that name a person's religion, tribe or
 * sexuality without insulting it. A phrase is listed instead when the abuse is in the phrase ("kiss my ass").
 *
 * THE NIGERIAN PART IS SHORT. It holds the insults the lead could source with confidence (prostitute and bastard
 * insults in Yoruba, Igbo and Hausa, and the Hausa word for the Igbo that is used as a slur). It needs a native speaker's
 * review; until then `MODERATION_EXTRA_WORDS` (a comma-separated list in the Hub's environment) adds words without a
 * release. Adding or removing a built-in word is a code change on purpose.
 */

export type WordCategory = 'slur' | 'sexual' | 'abuse' | 'threat' | 'hate';
export type WordLanguage = 'en' | 'pcm' | 'yo' | 'ig' | 'ha';

export interface WordGroup {
  category: WordCategory;
  language: WordLanguage;
  words: readonly string[];
}

/** Groups people a threat or a call for killing can name; used to make the `kill all {group}` phrases. */
const GROUPS = [
  'igbo',
  'igbos',
  'hausa',
  'hausas',
  'yoruba',
  'yorubas',
  'fulani',
  'fulanis',
  'muslims',
  'christians',
  'jews',
  'blacks',
  'whites',
  'gays',
  'lesbians',
  'women',
] as const;

export const BLOCKED_WORD_GROUPS: readonly WordGroup[] = [
  {
    category: 'slur',
    language: 'en',
    words: [
      'nigger~',
      'nigga~',
      'sandnigger~',
      'faggot~',
      'fagot~',
      'faggit~',
      'tranny~',
      'trannies',
      'shemale~',
      // "retarding" is a plain English verb, so only the three forms of the slur are listed.
      'retard',
      'retards',
      'retarded',
      // MOD-ROOMS r2 (M1, 31 Oct 2026): "kike" is gone from the list (it is a common Yoruba name, short for Kikelomo, far
      // more often than the slur), and spic, coon, kaffir, gook and beaner take NO endings: "spicy jollof", "spices",
      // "Spicer", "Gookin" and "Beanery" are food and names. Each is whole-word only, with its plural written out.
      'spic',
      'spics',
      'spick',
      'spicks',
      'chink~',
      'gook',
      'gooks',
      'wetback~',
      'coon',
      'coons',
      'paki',
      'pakis',
      'kaffir',
      'kaffirs',
      'towelhead~',
      'beaner',
      'beaners',
      'darkie~',
      'darky',
      'golliwog~',
      'porch monkey',
      'jungle bunny',
      'jungle bunnies',
    ],
  },
  {
    category: 'sexual',
    language: 'en',
    words: [
      'fuck~',
      'fuk~',
      'fuq~',
      'fck~',
      'fvck~',
      'phuck~',
      // The short spellings with the word after them, written as one word ("fukyou"). "fuckyou" and the rest of the fuck
      // family are caught inside longer words by STRONG_WORDS below; these shorter spellings are not safe to catch that way.
      ...['fuk', 'fuq', 'fck'].flatMap((w) =>
        ['you', 'off', 'up', 'face', 'head', 'wit'].map(
          (tail) => `${w}${tail}`,
        ),
      ),
      'motherfuck~',
      'muthafuck~',
      'mutherfuck~',
      'mother fucker',
      'mother fuckers',
      'cunt~',
      'pussy',
      'pussies',
      'blowjob~',
      'blow job',
      'handjob~',
      'hand job',
      'rimjob~',
      'cumshot~',
      'cum shot',
      'gangbang~',
      'dildo~',
      'cocksucker~',
      'cock sucker',
      'suck my dick',
      'suck my cock',
      'suck dick',
      'dickhead~',
      'dick head',
      'titties',
      'send nudes',
      'porn',
      'porno',
      'pornhub',
      'xvideos',
      'xnxx',
    ],
  },
  {
    category: 'abuse',
    language: 'en',
    words: [
      'shit~',
      'bullshit~',
      'horseshit',
      'dipshit~',
      'shithead~',
      'shitface',
      'bitch~',
      'son of a bitch',
      'asshole~',
      'arsehole~',
      'dumbass',
      'fatass',
      // The same words split by a space or a hyphen ("fat ass", "fat-ass", "dum bass"); the hyphen is a space to the matcher.
      'fat ass',
      'dumb ass',
      'dum ass',
      'dum bass',
      'bitchass~',
      'kiss my ass',
      'whore~',
      'slut~',
      'skank~',
      'wanker~',
      'twat~',
    ],
  },
  {
    category: 'abuse',
    language: 'pcm',
    words: [
      'ashawo~',
      'ashewo~',
      'oloshi',
      'olosho',
      'olosi',
      'your mama is a',
      'sit down for your mama',
    ],
  },
  { category: 'abuse', language: 'yo', words: ['omo ale', 'agbaya'] },
  {
    category: 'abuse',
    language: 'ig',
    words: ['akwuna', 'nwa akwuna', 'efulefu'],
  },
  {
    category: 'abuse',
    language: 'ha',
    words: [
      'karuwa',
      'karuwai',
      'dan iska',
      'yar iska',
      'dan banza',
      'yar banza',
      'dan harami',
      'dan haram',
      'shege~',
      'shegiya',
    ],
  },
  { category: 'hate', language: 'ha', words: ['nyamiri'] },
  {
    category: 'threat',
    language: 'en',
    words: [
      'kill yourself',
      'kill your self',
      'kill urself',
      'kill ur self',
      'kys',
      'k y s',
      'hang yourself',
      'go and die',
      'go die',
      'i will kill you',
      'i will kill u',
      'ill kill you',
      'ill kill u',
      'i am going to kill you',
      'im going to kill you',
      'i m going to kill you',
      'im gonna kill you',
      'i will rape you',
      'ill rape you',
      'rape you',
      'i will shoot you',
      'i will stab you',
      'ill shoot you',
      'ill stab you',
      'slit your throat',
      'burn your house down',
    ],
  },
  {
    category: 'threat',
    language: 'pcm',
    words: [
      'i go kill you',
      'i go kill u',
      'make i kill you',
      'make i kill u',
      'i go rape you',
      'i go finish you',
      'i go shoot you',
      'i go stab you',
    ],
  },
  {
    category: 'hate',
    language: 'en',
    words: [
      ...GROUPS.map((g) => `kill all ${g}`),
      ...GROUPS.map((g) => `death to ${g}`),
      'heil hitler',
      'white power',
    ],
  },
];

/**
 * Phrases that contain a listed word and are plainly innocent. They are taken out of the text before it is checked, as
 * whole words (a space in an entry matches any run of spaces and marks, so "kaffir-lime" is "kaffir lime"). Each is a real
 * use of a listed word; "chink in the armour" and "spick and span" are idioms, "kaffir lime" is a leaf in Nigerian and
 * Thai cooking, and a Maine Coon is a cat.
 */
export const ALLOWED_PHRASES: readonly string[] = [
  'chink in the armour',
  'chink in the armor',
  'chinks in the armour',
  'chinks in the armor',
  'spick and span',
  'spic and span',
  'kaffir lime',
  'kaffir limes',
  'maine coon',
  'maine coons',
  'coon hound',
  'coon hounds',
];

/**
 * Whole words that are never refused, whatever they hold (read after folding: accents off, lower case). Names and plain
 * English that the word list or STRONG_WORDS would otherwise meet: "snigger" holds the n-word's letters, "Twatt" is a
 * surname and an Orkney place, and the list's doubled-letter rule would take it for "twat".
 */
export const ALLOWED_WORDS: readonly string[] = [
  'snigger',
  'sniggers',
  'sniggered',
  'sniggering',
  'niggard',
  'niggards',
  'niggardly',
  'niggardliness',
  'twatt',
];

/**
 * Words that are caught INSIDE a longer word as well ("fuckyou", "fuckoff", "bitchass", "muthafucka", "motherfuckers"),
 * because people write them run together. Kept short on purpose: a word only goes here when no clean word or name
 * holds it. Everything else on the list is whole-word only ("Scunthorpe", "Shitta", "Assa" and "Cockcroft" are never hit).
 * "Niger", "Nigeria" and "Nigerian" hold only one g and are not hit; the real English words that hold the n-word's letters
 * are in ALLOWED_WORDS.
 */
export const STRONG_WORDS: readonly string[] = [
  'fuck',
  'fvck',
  'phuck',
  'motherfuck',
  'muthafuck',
  'mutherfuck',
  'mothafuck',
  'nigger',
  'nigga',
  'bitchass',
];

/**
 * Words people split with a space or a dot ("fu ck", "fuc k", "f uck", "fu.ck"). When two to four short pieces (four
 * letters or fewer each) joined make one of these, it is caught. Only the longer spellings are here: "fu k" or "fc k" can
 * be a name and an initial, and a split of a short word is left to Report.
 */
export const SPLIT_WORDS: readonly string[] = ['fuck~', 'fvck~', 'phuck~'];

/** Every built-in entry, flat. */
export function builtInWords(): string[] {
  return BLOCKED_WORD_GROUPS.flatMap((g) => [...g.words]);
}

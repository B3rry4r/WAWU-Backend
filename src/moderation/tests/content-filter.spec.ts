import { BadRequestException } from '@nestjs/common';
import {
  CONTENT_BLOCKED_CODE,
  CONTENT_BLOCKED_MESSAGE,
  assertContentAllowed,
  blockedWordIn,
  containsBlockedContent,
  moderationWordList,
} from '../content-filter';
import { builtInWords } from '../blocked-words';

// MOD-ROOMS (R-122). The word filter: what it refuses, what it must never refuse, and how it refuses.

describe('MOD-ROOMS: the objectionable-words filter', () => {
  afterEach(() => {
    delete process.env.MODERATION_EXTRA_WORDS;
  });

  describe('refuses', () => {
    const hits: [string, string][] = [
      ['plain profanity', 'what the fuck is this'],
      ['upper case', 'SHIT'],
      ['an ending', 'you fucking liar'],
      ['an ending (ers)', 'bunch of motherfuckers'],
      ['repeated letters', 'fuuuuuck you'],
      ['repeated letters in a doubled word', 'what an assshole'],
      ['l33t digits', 'you are a b1tch'],
      ['l33t symbols with an edge mark', 'sh!t!'],
      ['a masked letter', 'f*ck this'],
      ['two masked letters', 'f**k this'],
      ['letters spelled out', 'you f u c k off'],
      ['letters with dots', 'f.u.c.k'],
      ['letters with dashes', 'b-i-t-c-h'],
      ['a name in a url', 'see https://www.xvideos.com/abc'],
      ['an accent', 'fúck'],
      ['a zero-width character', 'fu​ck'],
      ['a slur', 'you nigga'],
      ['a slur with an ending', 'those niggas'],
      ['a threat', 'I will kill you tomorrow'],
      ['a threat with a contraction', "I'll kill you"],
      ['a threat in Pidgin', 'i go kill you'],
      ['telling someone to die', 'just kill yourself'],
      ['a call to kill a group', 'kill all hausas'],
      ['a Yoruba insult', 'ashawo'],
      ['a Yoruba insult with a mark', 'ọmọ àlè'.replace('àlè', 'ale')],
      ['an Igbo insult', 'nwa akwụna'],
      ['a Hausa insult', 'dan iska'],
      ['a Hausa letter with a hook', 'ɗan iska'],
      ['a sexual phrase', 'send nudes please'],
    ];
    it.each(hits)('%s', (_name, text) => {
      expect(blockedWordIn(text)).not.toBeNull();
      expect(containsBlockedContent(text)).toBe(true);
    });
  });

  describe('never refuses the safe words (Scunthorpe-style false hits)', () => {
    const safe = [
      'Scunthorpe',
      'class',
      'classic',
      'assess',
      'assassin',
      'assume',
      'massive',
      'passage',
      'glass',
      'bass',
      'as',
      'ass',
      'cocktail',
      'peacock',
      'Hancock',
      'Dickson',
      'Moby Dick',
      'shiitake mushrooms',
      'analysis',
      'therapist',
      'grape',
      'rapeseed oil',
      'Essex',
      'Sussex',
      'Middlesex',
      'Penistone',
      'cockatoo',
      'bitcoin',
      'title',
      'Niger',
      'Nigeria',
      'Nigerian',
      'snigger',
      'Igbo',
      'Hausa',
      'Yoruba',
      'Fulani',
      'magna cum laude',
      'cumin',
      'a chink in the armour',
      'kill the process',
      'kill all processes',
      'this workout will kill you',
      'I want to kill time',
      'go and see it',
      'go diet',
      'hello',
      'Hi! How are you?',
      '2024 summer vibes!!!',
      'A B C D E F G',
      'Vitamin A B C D E',
      'Call 0803 123 4567 now',
      'Sharon, Hoe, Titus and Kyle',
      'Peter Piper picked a peck of pickled peppers',
    ];
    it.each(safe)('%s', (text) => {
      expect(blockedWordIn(text)).toBeNull();
      expect(containsBlockedContent(text)).toBe(false);
    });
  });

  // MOD-ROOMS r2 (M1): a food and creator marketplace in Nigeria. These were refused by ending rules and by a name on the list.
  describe('r2 M1: food, names and places are never refused', () => {
    const safeR2 = [
      'spicy jollof',
      'Spicy Jollof Rice',
      'spiced chicken',
      'spices',
      'spicing it up',
      'Spicer',
      'Kike is my sister',
      'Kike Adeyemi',
      'Kikelomo',
      'kike',
      'Maine Coon',
      'my Maine Coons',
      'Kaffir lime leaves',
      'kaffir-lime',
      'Gookin',
      'Beanery',
      'Twatt',
      'Babcock',
      'Cockcroft',
      'Dickson',
      'Shitta',
      'Shitta-Bey',
      'Shitta Bey',
      'Assa',
      'Raccoon',
      'Cocoon',
      'spick and span',
      'spick-and-span',
      'Retarding',
      'fire retardant',
      'Pakistan',
      'Chinedu',
      'Fukuoka',
      'Fukushima',
      'Fuku',
      'Olufuke',
      'Fuqua',
      'fu k',
      'Fu K Wong',
      'if uck',
      'NIG GER 2-1',
      'snigger',
      'he sniggered',
      'sniggering at the back',
      'a niggardly offer',
      'Kysha',
      'great 😀 idea',
      'Tolu says hi 😀🔥',
      'jollof, plantain and 🔥 peppered snail',
    ];
    it.each(safeR2)('%s', (text) => {
      expect(blockedWordIn(text)).toBeNull();
    });

    it('kike is not on the list, and spic, coon, kaffir, gook and beaner take no endings (whole word, plural written out)', () => {
      const words = builtInWords();
      expect(words.join(' ')).not.toMatch(/kike/);
      for (const w of ['spic', 'spick', 'coon', 'kaffir', 'gook', 'beaner']) {
        expect(words).toContain(w);
        expect(words).not.toContain(`${w}~`);
      }
    });

    it('the slurs themselves are still refused as whole words, and the allowed phrases only free their own words', () => {
      for (const t of [
        'spic',
        'those spics',
        'a coon',
        'kaffir',
        'gook',
        'beaner',
        'Maine Coon and a coon',
        'kaffir lime and a kaffir',
      ]) {
        expect(blockedWordIn(t)).not.toBeNull();
      }
    });
  });

  // MOD-ROOMS r2 (M2): what slipped through in round 1, and what is caught now.
  describe('r2 M2: look-alike letters, emoji, invisible characters, compounds and splits', () => {
    const hitsR2: [string, string][] = [
      ['Cyrillic c in fuck', 'fu\u0441k'],
      ['Cyrillic s in shit', '\u0455hit'],
      ['Greek upsilon in fuck', 'f\u03c5ck'],
      ['small capitals', 'f\u1d1c\u1d04k'],
      ['full-width letters', '\uff46\uff55\uff43\uff4b'],
      [
        'maths bold letters',
        '\ud835\udc1f\ud835\udc2e\ud835\udc1c\ud835\udc24',
      ],
      ['an emoji between letters', 'f\ud83d\ude00uck'],
      [
        'emoji between every letter',
        'f\ud83d\udd25u\ud83d\udd25c\ud83d\udd25k',
      ],
      [
        'an emoji with a skin tone between letters',
        'fu\ud83d\udc4d\ud83c\udffdck',
      ],
      ['an emoji as the gap in a phrase', 'i will kill\ud83d\ude00you'],
      ['a zero-width space', 'fu\u200bck'],
      ['a zero-width joiner', 'fu\u200dck'],
      ['an invisible operator', 'fu\u2062ck'],
      ['a combining grapheme joiner', 'f\u034fuck'],
      ['a soft hyphen', 'fu\u00adck'],
      ['a byte-order mark', 'fu\ufeffck'],
      ['a Hangul filler', 'fu\u3164ck'],
      ['a tag character', 'fu\udb40\udc61ck'],
      ['fuckyou, run together', 'fuckyou'],
      ['fuckoff, run together', 'FUCKOFF'],
      ['bitchass', 'bitchass'],
      ['muthafucka', 'muthafucka'],
      ['motherfuckers', 'motherfuckers'],
      ['fukyou', 'fukyou'],
      ['fuqoff', 'fuqoff'],
      ['the n-word inside a longer word', 'niggaz'],
      ['the n-word with digits', 'n1gg4'],
      ['fu ck', 'fu ck'],
      ['fuc k', 'fuc k'],
      ['f uck', 'f uck'],
      ['fu.ck', 'fu.ck'],
      ['f u ck', 'f u ck'],
      ['fu ck ing', 'you fu ck ing liar'],
      ['dum bass', 'dum bass'],
      ['dumb ass', 'dumb ass'],
      ['fat ass', 'fat ass'],
      ['fat-ass', 'fat-ass'],
      ['k y s', 'k y s'],
      ['K Y S in a sentence', 'just K Y S'],
    ];
    it.each(hitsR2)('%s', (_name, text) => {
      expect(blockedWordIn(text)).not.toBeNull();
    });

    const stillCleanR2 = [
      'Niger',
      'Nigeria',
      'Nigerian',
      'Nigeria 2 - 1 Niger',
      'Shitta',
      'Shitta-Bey',
      'assess',
      'class',
      'therapist',
      'grape',
      'cocktail',
      'Scunthorpe',
      'Essex',
      'Sussex',
      'Penistone',
      'Mufasa',
      'bass',
      'the fat assets',
      'Fu Chen',
      'K Y',
      'A B C D E',
    ];
    it.each(stillCleanR2)('%s stays clean', (text) => {
      expect(blockedWordIn(text)).toBeNull();
    });

    it('the forms left to Report are written down: a split short word and a swapped letter that is on no look-alike list', () => {
      // Said plainly in content-filter.ts: these slip through on purpose, because the pieces are also real words.
      for (const t of ['sh it', 'bi tch', 'nig ger']) {
        expect(blockedWordIn(t)).toBeNull();
      }
    });
  });

  it('the refusal is a 400 with the code content_blocked, plain words, no em-dash, and no word named', () => {
    expect(CONTENT_BLOCKED_MESSAGE).toBe(
      'Who Made This? does not allow some of those words. Change them and try again.',
    );
    expect(CONTENT_BLOCKED_MESSAGE).not.toContain('—');
    let caught: unknown;
    try {
      assertContentAllowed('fine', 'you piece of shit');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as {
      message: string;
      reason: { code: string; message: string };
    };
    expect(body.reason.code).toBe(CONTENT_BLOCKED_CODE);
    expect(body.message).toBe(CONTENT_BLOCKED_MESSAGE);
    expect(JSON.stringify(body)).not.toMatch(/shit/);
  });

  it('passes clean text, missing fields and arrays of text without throwing', () => {
    expect(() =>
      assertContentAllowed('A clean sentence.', undefined, null, '', [
        'one',
        'two',
      ]),
    ).not.toThrow();
    expect(() => assertContentAllowed(['one', 'a bitch'])).toThrow(
      BadRequestException,
    );
  });

  it('looks at a long text from both ends and stays fast', () => {
    const long = `${'word '.repeat(10_000)}fuck`;
    const started = Date.now();
    expect(containsBlockedContent(long)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('adds words from MODERATION_EXTRA_WORDS without a release, and cannot take a built-in word out', () => {
    expect(blockedWordIn('that is flibbertigibbet')).toBeNull();
    process.env.MODERATION_EXTRA_WORDS = 'flibbertigibbet, two words ,';
    expect(blockedWordIn('that is flibbertigibbet')).not.toBeNull();
    expect(blockedWordIn('these two words here')).not.toBeNull();
    expect(blockedWordIn('fuck')).not.toBeNull();
    process.env.MODERATION_EXTRA_WORDS = '';
    expect(blockedWordIn('that is flibbertigibbet')).toBeNull();
  });

  it('lists itself for the admin: built-in groups with their language and category, and the additions', () => {
    process.env.MODERATION_EXTRA_WORDS = 'zork';
    const list = moderationWordList();
    expect(list.fromEnvironment).toEqual(['zork']);
    expect(list.total).toBe(builtInWords().length + 1);
    expect(list.builtIn.map((g) => g.language)).toEqual(
      expect.arrayContaining(['en', 'pcm', 'yo', 'ig', 'ha']),
    );
    expect(list.builtIn.map((g) => g.category)).toEqual(
      expect.arrayContaining(['slur', 'sexual', 'abuse', 'threat', 'hate']),
    );
  });

  it('every built-in entry is letters and single spaces (plus a trailing ~), so the matcher can read it', () => {
    for (const w of builtInWords()) {
      expect(w).toMatch(/^[a-z]+(?: [a-z]+)*~?$/);
    }
  });
});

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

  it('the refusal is a 400 with the code content_blocked, one plain sentence, no em-dash, and no word named', () => {
    expect(CONTENT_BLOCKED_MESSAGE).toBe(
      "That has words we don't allow on Who Made This. Change them and try again.",
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

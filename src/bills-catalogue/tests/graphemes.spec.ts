import {
  clipGraphemes,
  graphemes,
  graphemesByRule,
  graphemesBySegmenter,
} from '../graphemes';
import {
  clipProviderText,
  PROVIDER_TEXT_MAX,
} from '../bills-catalogue.service';

/**
 * The cap on the owner's name and address cuts between graphemes (BILLS-01 round 3, R2-5). A cut by code points split a
 * family emoji (one man left), a flag (one regional letter left) and a letter from its accent. Both ways of finding the
 * boundaries are tested against the same strings: `Intl.Segmenter` (Node has it) and the small rule for a runtime without
 * it (Hermes lists none, so the rule is what the app would need if it ever capped text).
 */

const ZWJ = String.fromCodePoint(0x200d);
const point = (...codes: number[]) => String.fromCodePoint(...codes);
/** A family: man, woman, girl, boy, joined: 7 code points, 11 UTF-16 units, one character. */
const FAMILY = [0x1f468, 0x1f469, 0x1f467, 0x1f466]
  .map((c) => point(c))
  .join(ZWJ);
/** Nigeria's flag: two regional indicators, one character. */
const NG = point(0x1f1f3, 0x1f1ec);
const GH = point(0x1f1ec, 0x1f1ed);
/** An "e" and a combining acute accent: two code points, one character. */
const E_ACUTE = `e${point(0x301)}`;
/** A thumbs up with a skin tone: two code points, one character. */
const THUMB = point(0x1f44d, 0x1f3fd);
/** England's flag: a black flag and six tag characters, one character. */
const ENGLAND = [0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f]
  .map((c) => point(c))
  .join('');
/** A heart with the emoji variation selector. */
const HEART = point(0x2764, 0xfe0f);

const splitters: [string, (text: string) => string[]][] = [
  ['Intl.Segmenter', graphemesBySegmenter],
  ['the rule', graphemesByRule],
];

describe.each(splitters)('graphemes by %s', (_name, split) => {
  it.each([
    ['a family emoji', FAMILY, [FAMILY]],
    ['a flag', NG, [NG]],
    ['two flags', NG + GH, [NG, GH]],
    ['a letter and its accent', E_ACUTE, [E_ACUTE]],
    [
      'a letter with two accents',
      `a${point(0x301, 0x323)}`,
      [`a${point(0x301, 0x323)}`],
    ],
    ['a thumb with a skin tone', THUMB, [THUMB]],
    ['a heart with its variation selector', HEART, [HEART]],
    ['a flag made of tag characters', ENGLAND, [ENGLAND]],
    ['plain letters', 'abc', ['a', 'b', 'c']],
    ['nothing', '', []],
    ['an emoji between letters', `a${FAMILY}b`, ['a', FAMILY, 'b']],
    ['a flag and then a letter', `${NG}x`, [NG, 'x']],
    [
      'an accent on a flag-less letter after a flag',
      `${NG}${E_ACUTE}`,
      [NG, E_ACUTE],
    ],
  ])('keeps %s together', (_k, text, expected) => {
    expect(split(text)).toEqual(expected);
  });

  it('pairs regional indicators two by two', () => {
    const three = point(0x1f1f3, 0x1f1ec, 0x1f1ec);
    expect(split(three)).toEqual([NG, point(0x1f1ec)]);
  });

  it('joins what follows a zero-width joiner, however long the sequence', () => {
    const long = [0x1f468, 0x1f469, 0x1f467, 0x1f466, 0x1f468]
      .map((c) => point(c))
      .join(ZWJ);
    expect(split(long)).toEqual([long]);
  });

  it('puts a plain letter after a joined sequence in its own character', () => {
    expect(split(`${FAMILY}z`)).toEqual([FAMILY, 'z']);
  });
});

describe('the rule agrees with Intl.Segmenter on the cases it is written for', () => {
  it.each([
    FAMILY,
    NG + GH + NG,
    E_ACUTE + E_ACUTE,
    `${THUMB}${HEART}${FAMILY}x${ENGLAND}y`,
    'Chidinma Okoro',
  ])('%s', (text) => {
    expect(graphemesByRule(text)).toEqual(graphemesBySegmenter(text));
  });
});

describe('graphemes() picks the runtime’s segmenter, and the rule without one', () => {
  const real = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  afterEach(() => Object.defineProperty(Intl, 'Segmenter', real));

  it('uses Intl.Segmenter when the runtime has it', () => {
    let made = 0;
    class Counting extends Intl.Segmenter {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        made += 1;
      }
    }
    Object.defineProperty(Intl, 'Segmenter', {
      value: Counting,
      configurable: true,
      writable: true,
    });
    expect(graphemes(FAMILY)).toEqual([FAMILY]);
    expect(made).toBe(1);
  });

  it('falls back to the rule when the runtime has none, and still keeps a family emoji whole', () => {
    Object.defineProperty(Intl, 'Segmenter', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(typeof Intl.Segmenter).toBe('undefined');
    expect(graphemes(`${FAMILY}${NG}${E_ACUTE}`)).toEqual([
      FAMILY,
      NG,
      E_ACUTE,
    ]);
  });
});

describe.each(splitters)('clipGraphemes by %s', (_name, split) => {
  const as = (n: number) => 'a'.repeat(n);

  it('keeps the first n characters whole', () => {
    expect(clipGraphemes('abcdef', 3, split)).toBe('abc');
    expect(clipGraphemes('abc', 3, split)).toBe('abc');
    expect(clipGraphemes('abc', 10, split)).toBe('abc');
    expect(clipGraphemes('abc', 0, split)).toBe('');
  });

  it.each([
    ['a family emoji', FAMILY],
    ['a flag', NG],
    ['a letter with its accent', E_ACUTE],
    ['a thumb with a skin tone', THUMB],
  ])(
    'leaves out %s that would cross the cut, never half of it',
    (_k, whole) => {
      // 199 letters and then the character: 200 graphemes, the character is the 200th and stays.
      expect(clipGraphemes(as(199) + whole + 'tail', 200, split)).toBe(
        as(199) + whole,
      );
      // 200 letters and then the character: it is the 201st and goes whole.
      expect(clipGraphemes(as(200) + whole, 200, split)).toBe(as(200));
      // A cut at 198 puts the character (198th) in and its tail out.
      expect(clipGraphemes(as(197) + whole + 'xy', 198, split)).toBe(
        as(197) + whole,
      );
    },
  );

  it('counts a family emoji as one character, not seven', () => {
    expect(clipGraphemes(FAMILY.repeat(3), 2, split)).toBe(FAMILY.repeat(2));
  });
});

describe('clipProviderText: the cap on what the Hub passes on', () => {
  const as = (n: number) => 'a'.repeat(n);

  it('is 200 characters a person sees', () => {
    expect(PROVIDER_TEXT_MAX).toBe(200);
  });

  it.each([
    ['a family emoji', FAMILY],
    ['a flag', NG],
    ['a letter with its accent', E_ACUTE],
  ])('keeps %s at the cut whole', (_k, whole) => {
    expect(clipProviderText(as(199) + whole + 'tail')).toBe(as(199) + whole);
    expect(clipProviderText(as(200) + whole)).toBe(as(200));
  });

  it('counts the characters, so 200 family emoji are passed on whole', () => {
    expect(clipProviderText(FAMILY.repeat(200))).toBe(FAMILY.repeat(200));
    expect(clipProviderText(FAMILY.repeat(201))).toBe(FAMILY.repeat(200));
  });

  it('drops spaces left at the end by the cut', () => {
    expect(clipProviderText(`${as(199)} tail`)).toBe(as(199));
    expect(clipProviderText(`${as(150)}   ${as(100)}`)).toBe(
      `${as(150)}   ${as(47)}`,
    );
    expect(clipProviderText(`${as(10)}   `)).toBe(as(10));
  });

  it('passes a short text on as it is', () => {
    expect(clipProviderText('Chidinma Okoro')).toBe('Chidinma Okoro');
  });
});

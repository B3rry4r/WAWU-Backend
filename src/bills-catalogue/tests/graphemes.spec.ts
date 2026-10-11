import {
  boundBytes,
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

  it('drops the last character when it is told the text was cut short, since that one may be only part of one', () => {
    expect(clipGraphemes('abcdef', 10, split, true)).toBe('abcde');
    expect(clipGraphemes('abcdef', 3, split, true)).toBe('abc');
    expect(clipGraphemes(FAMILY.repeat(3), 10, split, true)).toBe(
      FAMILY.repeat(2),
    );
    expect(clipGraphemes('abcdef', 10, split, false)).toBe('abcdef');
    expect(clipGraphemes('', 10, split, true)).toBe('');
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

  it('counts the characters, so 200 family emoji are passed on whole when the byte bound leaves room', () => {
    // A family is 25 bytes, so 200 of them are 5,000: the default byte bound (R3-6) would cut them, this test is about the count.
    const room = 100_000;
    expect(clipProviderText(FAMILY.repeat(200), room)).toBe(FAMILY.repeat(200));
    expect(clipProviderText(FAMILY.repeat(201), room)).toBe(FAMILY.repeat(200));
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

describe('boundBytes: the text read only as far as the cap (BILLS-01 round 4, R3-6)', () => {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

  it('leaves a text that fits as it is, and says it was not cut', () => {
    expect(boundBytes('Chidinma Okoro', 1024)).toEqual({
      text: 'Chidinma Okoro',
      cut: false,
    });
    expect(boundBytes('', 10)).toEqual({ text: '', cut: false });
    expect(boundBytes('abcde', 5)).toEqual({ text: 'abcde', cut: false });
  });

  it('cuts at the byte, and says it cut', () => {
    expect(boundBytes('abcdef', 5)).toEqual({ text: 'abcde', cut: true });
  });

  it.each([
    ['two bytes a letter', 'é', 2],
    ['three bytes a letter', '\u20a6', 3],
    ['four bytes a letter', '\u{1F600}', 4],
  ])(
    'counts a character of %s by its bytes and never splits it',
    (_k, ch, size) => {
      const text = ch.repeat(10);
      for (const max of [size, size * 3, size * 3 + 1, size * 3 + size - 1]) {
        const got = boundBytes(text, max);
        expect(bytes(got.text)).toBeLessThanOrEqual(max);
        expect(got.text).toBe(ch.repeat(Math.floor(max / size)));
        expect(got.cut).toBe(true);
      }
    },
  );

  it.each([
    ['U+007F, the last of one byte', 0x7f, 1],
    ['U+0080, the first of two', 0x80, 2],
    ['U+07FF, the last of two', 0x7ff, 2],
    ['U+0800, the first of three', 0x800, 3],
    ['U+FFFF, the last of three', 0xffff, 3],
    ['U+10000, the first of four', 0x10000, 4],
    ['U+10FFFF, the last of four', 0x10ffff, 4],
  ])('counts %s as %i bytes', (_k, code, size) => {
    const ch = String.fromCodePoint(code);
    expect(bytes(ch)).toBe(size);
    const text = ch.repeat(20);
    const got = boundBytes(text, size * 7);
    expect(got).toEqual({ text: ch.repeat(7), cut: true });
    expect(boundBytes(ch.repeat(7), size * 7)).toEqual({
      text: ch.repeat(7),
      cut: false,
    });
  });

  it('cuts a text of many characters of three bytes even when its length is under the cap (the length is not the bytes)', () => {
    const text = '\u20a6'.repeat(300);
    expect(boundBytes(text, 800)).toEqual({
      text: '\u20a6'.repeat(266),
      cut: true,
    });
  });

  it('reads no further than the cap: five megabytes are cut as quickly as five thousand', () => {
    const started = Date.now();
    const got = boundBytes('x'.repeat(5_000_000), 1024);
    expect(got.text).toHaveLength(1024);
    expect(got.cut).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('clipProviderText: the byte bound before the cut (R3-6)', () => {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const marks = (n: number) => point(0x301).repeat(n);

  it('is a bound: one letter and a thousand and a half marks, one character a person sees, is not passed on', () => {
    // The 200 characters cap alone let this through whole (1,501 code points).
    expect(clipProviderText(`e${marks(1500)}`)).toBe('');
  });

  it('is a bound: a chain of 400 emoji joined by a joiner is one character and is not passed on', () => {
    expect(clipProviderText(Array(400).fill(point(0x1f468)).join(ZWJ))).toBe(
      '',
    );
  });

  it('is a bound: 150 letters with ten accents each are cut to the whole letters that fit', () => {
    const unit = `a${marks(10)}`;
    const got = clipProviderText(unit.repeat(150));
    expect(bytes(got)).toBeLessThanOrEqual(1024);
    expect(got).toBe(unit.repeat(got.length / unit.length));
    // The one the cut landed in is left out, and the rest are whole.
    expect(got.length / unit.length).toBeGreaterThan(30);
    expect(got.length / unit.length).toBeLessThan(50);
  });

  it('takes the cap from its argument, which is the Hub’s setting', () => {
    expect(clipProviderText('N'.repeat(100), 64)).toBe('N'.repeat(63));
    expect(clipProviderText('N'.repeat(100), 4096)).toBe('N'.repeat(100));
  });

  it('keeps a text of exactly the cap whole when it is not cut (the cap is on the bytes read, 1,024 by default)', () => {
    expect(clipProviderText('N'.repeat(150))).toBe('N'.repeat(150));
  });

  it('takes the spaces and invisible characters off its start before it cuts, so a name behind 250 of them is read', () => {
    for (const blank of [
      '\u200b',
      '\u2800',
      '\u3164',
      ' ',
      '\ufeff',
      '\u00a0',
    ]) {
      expect(clipProviderText(`${blank.repeat(250)}Ada Eze`)).toBe('Ada Eze');
    }
    expect(clipProviderText(` \u200b\u2800 \u3164Ada Eze`)).toBe('Ada Eze');
  });

  it('is nothing for a text of invisible characters only', () => {
    expect(clipProviderText('\u200b'.repeat(250))).toBe('');
    expect(clipProviderText('\u2800'.repeat(5_000_000))).toBe('');
  });

  it('gives the segmenter at most the byte cap, never the five megabytes', () => {
    const segment = jest.spyOn(Intl.Segmenter.prototype, 'segment');
    try {
      const started = Date.now();
      expect(clipProviderText('N'.repeat(5_000_000))).toBe('N'.repeat(200));
      expect(Date.now() - started).toBeLessThan(1000);
      const longest = Math.max(
        ...segment.mock.calls.map(([text]) => String(text).length),
      );
      expect(longest).toBeLessThanOrEqual(1024);
      expect(segment).toHaveBeenCalled();
    } finally {
      segment.mockRestore();
    }
  });
});

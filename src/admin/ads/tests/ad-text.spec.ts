import {
  checkAdText,
  checkArtworkUrl,
  normaliseAdText,
  parseUtcInstant,
} from '../ad-text';
import { AD_TEXT_LIMITS } from '../../../ads/ads-text-limits';

/**
 * The rules the admin ads DTOs apply to text, by Unicode category (ADS-06).
 * ADS-03's database check refuses only 139 listed code points; every case here
 * is one it lets through.
 */

const u = (...cps: number[]) => String.fromCodePoint(...cps);
const text = (value: string, max = 60) => checkAdText(value, 'headline', max);

describe('checkAdText: invisible text is refused', () => {
  const invisible: Array<[string, string]> = [
    ['braille blank U+2800', u(0x2800)],
    ['object replacement U+FFFC', u(0xfffc)],
    ['replacement character U+FFFD', u(0xfffd)],
    ['Hangul filler U+3164', u(0x3164)],
    ['halfwidth Hangul filler U+FFA0', u(0xffa0)],
    ['Hangul choseong filler U+115F', u(0x115f)],
    ['Hangul jungseong filler U+1160', u(0x1160)],
    ['Khmer inherent vowel U+17B4', u(0x17b4)],
    ['combining grapheme joiner U+034F', u(0x034f)],
    ['tag space U+E0020', u(0xe0020)],
    ['tag letters U+E0041 to U+E0043', u(0xe0041, 0xe0042, 0xe0043)],
    ['cancel tag U+E007F', u(0xe007f)],
    ['one lone combining acute U+0301', u(0x0301)],
    ['several lone combining marks', u(0x0301, 0x0302, 0x0303)],
    ['enclosing mark U+20DD alone', u(0x20dd)],
    ['spacing mark U+0903 alone', u(0x0903)],
    ['zero-width space U+200B', u(0x200b)],
    ['zero-width joiner U+200D alone', u(0x200d)],
    ['zero-width non-joiner U+200C alone', u(0x200c)],
    ['word joiner U+2060', u(0x2060)],
    ['invisible separator U+2063', u(0x2063)],
    ['soft hyphen U+00AD', u(0x00ad)],
    ['left-to-right mark U+200E', u(0x200e)],
    ['arabic letter mark U+061C', u(0x061c)],
    ['byte order mark', u(0xfeff)],
    ['variation selector U+FE0F alone', u(0xfe0f)],
    ['private use U+E000', u(0xe000)],
    ['unassigned U+0378', u(0x0378)],
    ['lone high surrogate', '\ud800'],
    ['line separator U+2028', u(0x2028)],
    ['paragraph separator U+2029', u(0x2029)],
    ['spaces and a combining mark', ` ${u(0x0301)} `],
    [
      'mixed invisible characters',
      `${u(0x2800)}${u(0x200b)}${u(0x3164)} ${u(0xfffc)}`,
    ],
    ['only a no-break space', u(0x00a0)],
    ['only an ideographic space', u(0x3000)],
    ['empty', ''],
    ['spaces', '    '],
    ['tab and newline', '\t\n'],
  ];
  it.each(invisible)('%s', (_name, value) => {
    expect(text(value).ok).toBe(false);
  });

  it('refuses invisible characters hidden inside visible text, not only blank text', () => {
    expect(text(`Gospel${u(0x200b)}Night`).ok).toBe(false);
    expect(text(`Gospel${u(0x2800)}Night`).ok).toBe(false);
    expect(text(`Gospel${u(0xe0041)}`).ok).toBe(false);
    expect(text(`Gospel Night${u(0x202e)}`).ok).toBe(false); // right-to-left override
    expect(text(`Gospel Night${u(0x2066)}`).ok).toBe(false); // directional isolate
    expect(text(`Gospel${u(0xfffc)}`).ok).toBe(false);
  });

  it('refuses a combining mark that is on nothing, even beside visible text', () => {
    expect(text(`${u(0x0301)}Gospel`).ok).toBe(false);
    expect(text(`SPONSORED ${u(0x0301)}`).ok).toBe(false);
    expect(text(`Gospel ${u(0x0301)}Night`).ok).toBe(false);
  });

  it('refuses a joiner that is not between two visible characters', () => {
    expect(text(`Gospel${u(0x200d)}`).ok).toBe(false);
    expect(text(`${u(0x200d)}Gospel`).ok).toBe(false);
    expect(text(`Gospel ${u(0x200d)} Night`).ok).toBe(false);
    expect(text(`Gospel${u(0x200d)}${u(0x0301)}`).ok).toBe(false);
  });

  it('refuses a control character, so the text is one line', () => {
    expect(text('Gospel\nNight').ok).toBe(false);
    expect(text('Gospel\tNight').ok).toBe(false);
    expect(text('Gospel\u0000Night').ok).toBe(false);
    expect(text('Gospel\u0085Night').ok).toBe(false);
  });

  it('refuses an em dash and an en dash, and allows a hyphen', () => {
    expect(text('Gospel \u2014 Night').ok).toBe(false);
    expect(text('Gospel \u2013 Night').ok).toBe(false);
    expect(text('Gospel - Night').ok).toBe(true);
  });
});

describe('checkAdText: real text is accepted and normalised', () => {
  it('accepts the words the designs draw', () => {
    expect(text('Gospel Night Live')).toEqual({
      ok: true,
      value: 'Gospel Night Live',
    });
    expect(
      checkAdText('Abuja · Sat 18 October · from ₦5,000', 'subline', 80).ok,
    ).toBe(true);
    expect(checkAdText('Get tickets', 'ctaLabel', 24).ok).toBe(true);
  });

  it('trims, and turns every run of spaces into one space', () => {
    expect(text(`  Gospel${u(0x00a0)}${u(0x00a0)}Night\u3000Live  `)).toEqual({
      ok: true,
      value: 'Gospel Night Live',
    });
  });

  it('normalises to NFC', () => {
    const decomposed = `Cafe${u(0x0301)}`;
    const r = text(decomposed);
    expect(r).toEqual({ ok: true, value: 'Café' });
  });

  it('accepts marks that sit on a letter, in several scripts', () => {
    expect(text(`e${u(0x0323)}${u(0x0301)}`).ok).toBe(true); // Yoruba e with dot below and acute
    expect(text('Ọ̀gbẹ́ni').ok).toBe(true);
    expect(text('नमस्ते').ok).toBe(true); // Devanagari: spacing and nonspacing marks
    expect(text('日本語').ok).toBe(true);
    expect(text('مرحبا').ok).toBe(true);
  });

  it('accepts emoji, a joiner sequence and a variation selector on an emoji', () => {
    expect(text('Night \u{1F3B6}').ok).toBe(true);
    expect(text(`\u{1F468}${u(0x200d)}\u{1F469}${u(0x200d)}\u{1F467}`).ok).toBe(
      true,
    );
    expect(text(`❤${u(0xfe0f)}`).ok).toBe(true);
    expect(text(`\u{1F44D}\u{1F3FD}`).ok).toBe(true);
  });

  it('accepts a joiner between letters', () => {
    expect(text(`می${u(0x200c)}خواهم`).ok).toBe(true);
  });

  it('accepts punctuation and symbols alone, since a person can see them', () => {
    expect(text('?').ok).toBe(true);
    expect(text('₦').ok).toBe(true);
  });

  it('is idempotent', () => {
    const once = normaliseAdText(`  A${u(0x00a0)}B  `);
    expect(normaliseAdText(once)).toBe(once);
  });
});

describe('checkAdText: length', () => {
  it('counts code points after trimming, not UTF-16 units', () => {
    const emoji = '\u{1F3B6}'.repeat(24);
    expect(checkAdText(emoji, 'ctaLabel', AD_TEXT_LIMITS.ctaLabel).ok).toBe(
      true,
    );
    expect(
      checkAdText(`${emoji}\u{1F3B6}`, 'ctaLabel', AD_TEXT_LIMITS.ctaLabel).ok,
    ).toBe(false);
  });

  it('accepts exactly the cap and refuses one more, per field', () => {
    for (const [field, max] of Object.entries(AD_TEXT_LIMITS)) {
      expect(checkAdText('a'.repeat(max), field, max).ok).toBe(true);
      const over = checkAdText('a'.repeat(max + 1), field, max);
      expect(over.ok).toBe(false);
      if (!over.ok)
        expect(over.message).toBe(
          `${field} must be at most ${max} characters.`,
        );
    }
  });

  it('does not count the spaces it trims', () => {
    expect(checkAdText(`   ${'a'.repeat(24)}   `, 'ctaLabel', 24).ok).toBe(
      true,
    );
  });

  it('refuses a very long text without being slow', () => {
    const start = Date.now();
    expect(text('a'.repeat(1_000_000)).ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('keeps every cap inside what a card can show: short, and in order', () => {
    expect(AD_TEXT_LIMITS.ctaLabel).toBeLessThanOrEqual(
      AD_TEXT_LIMITS.headline,
    );
    expect(AD_TEXT_LIMITS.headline).toBeLessThanOrEqual(AD_TEXT_LIMITS.subline);
    expect(AD_TEXT_LIMITS.subline).toBeLessThanOrEqual(100);
  });
});

describe('checkAdText: messages carry no em dash', () => {
  it('for every refusal', () => {
    const cases = [
      '',
      u(0x2800),
      u(0x0301),
      'a'.repeat(999),
      'a\nb',
      'a\u2014b',
      `a${u(0x200d)}`,
    ];
    for (const value of cases) {
      const r = text(value);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toMatch(/\u2014|\u2013/);
      }
    }
  });
});

describe('checkArtworkUrl', () => {
  const ok = [
    'https://cdn.example.com/a.png',
    'https://cdn.example.com/a/b.png?x=1&y=2',
    'HTTPS://CDN.EXAMPLE.COM/A.PNG',
    'https://bucket.s3.eu-west-1.amazonaws.com/ads/pic.jpg',
    'https://xn--bcher-kva.example/x.png',
    '  https://cdn.example.com/a.png  ',
  ];
  it.each(ok)('accepts %s', (value) => {
    expect(checkArtworkUrl(value).ok).toBe(true);
  });

  const bad = [
    'http://cdn.example.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://cdn.example.com/a.png',
    '//cdn.example.com/a.png',
    'https://',
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://10.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://user:pass@cdn.example.com/a.png',
    'https://cdn.example.com/a b.png',
    'https://cdn.example.com/a"><script>',
    'https://cdn.example.com/a\nb',
    'https://-bad.example.com/a.png',
    'https://example/a.png',
    'https:cdn.example.com/a.png',
    'https:\\\\cdn.example.com\\a.png',
    'not a url',
    '',
    '   ',
    `https://cdn.example.com/${'a'.repeat(500)}`,
  ];
  it.each(bad)('refuses %s', (value) => {
    expect(checkArtworkUrl(value).ok).toBe(false);
  });
});

describe('parseUtcInstant', () => {
  it('reads UTC instants with up to three decimals', () => {
    expect(parseUtcInstant('2026-10-18T09:00:00Z')?.toISOString()).toBe(
      '2026-10-18T09:00:00.000Z',
    );
    expect(parseUtcInstant('2026-10-18T09:00:00.5Z')?.toISOString()).toBe(
      '2026-10-18T09:00:00.500Z',
    );
    expect(parseUtcInstant('2026-10-18T09:00:00.123Z')?.toISOString()).toBe(
      '2026-10-18T09:00:00.123Z',
    );
  });

  it.each([
    '2026-10-18T09:00:00+01:00',
    '2026-10-18T09:00:00-00:00',
    '2026-10-18T09:00:00',
    '2026-10-18',
    '2026-10-18 09:00:00Z',
    '2026-10-18T09:00:00z',
    '2026-10-18T09:00Z',
    '2026-10-18T09:00:00.1234Z',
    '0000-01-01T00:00:00Z',
    '0000-12-31T23:59:59.999Z',
    '-000001-01-01T00:00:00Z',
    '+275760-09-13T00:00:00.000Z',
    '+010000-01-01T00:00:00Z',
    '10000-01-01T00:00:00Z',
    '99999-01-01T00:00:00Z',
    '9999-12-31T23:59:60Z',
    '2016-12-31T23:59:60Z',
    '2026-02-31T09:00:00Z',
    '2026-13-01T09:00:00Z',
    '2026-10-18T24:00:00Z',
    '2026-10-18T09:60:00Z',
    '2026-10-18T09:00:60Z',
    '0050-10-18T09:00:00Z-',
    'Sat 18 October 2026',
    '1792314000000',
    '',
  ])('refuses %s', (value) => {
    expect(parseUtcInstant(value)).toBeNull();
  });

  it('accepts the first and last instants the database is sent', () => {
    expect(parseUtcInstant('0001-01-01T00:00:00Z')?.toISOString()).toBe(
      '0001-01-01T00:00:00.000Z',
    );
    expect(parseUtcInstant('9999-12-31T23:59:59.999Z')?.toISOString()).toBe(
      '9999-12-31T23:59:59.999Z',
    );
  });

  it('accepts a real leap day and refuses a false one', () => {
    expect(parseUtcInstant('2028-02-29T00:00:00Z')).not.toBeNull();
    expect(parseUtcInstant('2026-02-29T00:00:00Z')).toBeNull();
  });

  it('reads a year before 100 as that year, not as 19xx', () => {
    expect(parseUtcInstant('0050-01-01T00:00:00Z')?.getUTCFullYear()).toBe(50);
  });
});

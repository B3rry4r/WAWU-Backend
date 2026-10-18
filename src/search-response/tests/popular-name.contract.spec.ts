import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  FOLD_FROM,
  FOLD_TO,
  foldSearchText,
  foldSql,
  isShowableName,
  showableNameSql,
} from '../popular-name';
import {
  LETTERS_ONLY_FORMS,
  REFUSED_BY_CHARACTER_RULE,
  SHOWN_NAMES,
} from './popular-forms';

/**
 * EXPLORE-05 round 3. The two halves of the allow-list for GET
 * /search/popular: the fold that makes a searched text and a name comparable,
 * and the character rule on the shown name. Each is written twice (in code,
 * and in SQL for the one ranking query); the last block feeds both the same
 * texts, so the two cannot drift apart.
 */

// White space that JavaScript and the database do not agree on is left out.
const ODD_SPACE = new RegExp('[\\uFEFF\\u0085\\u180E]');

const FOLD_CASES: [string, string][] = [
  ['Afrobeats', 'afrobeats'],
  ['  Tax \t Filing ', 'tax filing'],
  ['AFRObeats   2026', 'afrobeats 2026'],
  ['Ａfrobeats', 'afrobeats'], // full-width A
  ['аfrоbeats', 'afrobeats'], // Cyrillic a and o
  ['АFRОBEATS', 'afrobeats'], // Cyrillic capital A and O
  ['ΑFRΟBEATS', 'afrobeats'], // Greek capital alpha and omicron
  ['ονe', 'ove'], // Greek omicron, nu
  ['top ①⓪ songs', 'top 10 songs'], // circled digits
  ['top ❶⓿ songs', 'top 10 songs'], // dingbat circled digits
  ['top ➀➁ songs', 'top 12 songs'],
  ['top 1️⃣0️⃣ songs', 'top 10 songs'], // keycap digits
  ['top １０ songs', 'top 10 songs'], // full-width digits
  ['ǅ', 'dž'],
  ['Naija’s', 'naija’s'],
];

describe('foldSearchText', () => {
  it.each(FOLD_CASES)('reads %j as %j', (text, folded) => {
    expect(foldSearchText(text)).toBe(folded);
  });

  it('is one plain form: folding again changes nothing', () => {
    for (const [text] of FOLD_CASES)
      expect(foldSearchText(foldSearchText(text))).toBe(foldSearchText(text));
  });

  it('has one Latin letter or digit for each lookalike, and no character twice', () => {
    expect([...FOLD_FROM].length).toBe([...FOLD_TO].length);
    expect(new Set([...FOLD_FROM]).size).toBe([...FOLD_FROM].length);
    expect(/^[a-z0-9]+$/.test(FOLD_TO)).toBe(true);
  });
});

describe('isShowableName (the character rule)', () => {
  it.each(SHOWN_NAMES)('shows %j', (name) => {
    expect(isShowableName(name)).toBe(true);
  });

  it.each(REFUSED_BY_CHARACTER_RULE)('refuses %j', (name) => {
    expect(isShowableName(name)).toBe(false);
  });

  it.each([
    'next.js tutorial',
    'Lagos 20261', // five digits
    '08012345678',
    'chidinma@gmail.com',
    'chidinma_okafor', // an underscore, as a handle may have
    'a/b',
    'a:b',
    '(0801)',
    '&',
    '-',
    ' ',
    '',
    "'",
    'Ａfrobeats', // full-width letter
    'Afrоbeats', // Cyrillic o: a lookalike of a Latin word
    'Chıdi Kitchen', // U+0131 dotless i: folded as i in the search, so never shown (SWEEP-APP-4, R3-2)
    'ɑfrobeats', // U+0251 latin alpha, folded as a
    'Big ɡrace', // U+0261 script g, folded as g
    'Afrobeats​', // an invisible character
    'tab\tname',
    'line\nbreak',
    'Women’s Health', // a typographic apostrophe: a false refusal, accepted
    'Top 10 songs 2026', // six digits
    '́abc', // a mark with no letter before it
  ])('refuses %j', (name) => {
    expect(isShowableName(name)).toBe(false);
  });

  it('allows four digits in the whole name, not four in a row', () => {
    expect(isShowableName('1 2 3 4 stars')).toBe(true);
    expect(isShowableName('1 2 3 4 5 stars')).toBe(false);
  });

  // The rule is on the name's characters. A word is made of letters, so the
  // rule cannot refuse "zero eight zero one ..." or "chidinma gmail": they can
  // be shown only when a public thing carries exactly that name (owner
  // question, tasks/EXPLORE-05.md).
  it('cannot refuse a name made only of words', () => {
    for (const form of LETTERS_ONLY_FORMS)
      expect(isShowableName(form)).toBe(true);
  });
});

describe('the database and the code read the same way', () => {
  let prisma: PrismaService;
  let moduleRef: Awaited<ReturnType<typeof build>>;
  const build = () =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    }).compile();

  beforeAll(async () => {
    moduleRef = await build();
    prisma = moduleRef.get(PrismaService);
  }, 30000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  const everyText = [
    ...FOLD_CASES.map(([t]) => t),
    ...REFUSED_BY_CHARACTER_RULE,
    ...LETTERS_ONLY_FORMS,
    ...SHOWN_NAMES,
    'Lagos 20261',
    'Top 10 songs 2026',
    "Women's Health",
    '1 2 3 4 stars',
    '1 2 3 4 5 stars',
    '́abc',
    'Afrobeats   Mix ',
    'Chıdi Kitchen', // the three Latin lookalikes the fold reads as plain letters (SWEEP-APP-4, R3-2)
    'ɑfrobeats',
    'Big ɡrace',
  ].filter((t) => !ODD_SPACE.test(t));

  it('fold: SQL equals the code for every text', async () => {
    const wrong: string[] = [];
    for (const text of everyText) {
      const rows = await prisma.$queryRaw<{ f: string }[]>(
        Prisma.sql`SELECT ${foldSql(Prisma.sql`${text}::text`)} AS f`,
      );
      if (rows[0].f !== foldSearchText(text))
        wrong.push(`${JSON.stringify(text)} sql=${JSON.stringify(rows[0].f)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('character rule: SQL equals the code for every text', async () => {
    const wrong: string[] = [];
    for (const text of everyText) {
      const rows = await prisma.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT ${showableNameSql(Prisma.sql`${text}::text`)} AS ok`,
      );
      if (rows[0].ok !== isShowableName(text))
        wrong.push(`${JSON.stringify(text)} sql=${rows[0].ok}`);
    }
    expect(wrong).toEqual([]);
  });
});

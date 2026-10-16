import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { NUVION_FEE_CONFIG_KEYS } from '../../fees/nuvion-fee-config';
import { MONEY_LIMIT_CONFIG_KEYS } from '../money-limit-config';

/**
 * NO FEE OR LIMIT FIGURE IN SOURCE (task NUV-07, R-42: Nuvion's fees and
 * WAWU's limits are settings filled in when Nuvion answers; WORKFLOW section
 * 4: never invent a fee or a limit).
 *
 * The code NUV-07 added for Nuvion's fees and for the limits holds no number
 * but 0 and 1 (an empty sum, a first day, a minimum of one kobo): no default
 * fee, no band edge, no limit. Comments and strings are left out of the
 * search (they explain); code is read. And the settings files list every
 * setting the code reads, each with nothing after the `=`.
 *
 * Fintava's schedule (fee-config.ts) keeps its ruled figures (R-10, WALLET-15)
 * and WAWU's own fees on top stay as they are: neither is NUV-07's.
 */

const SRC = resolve(__dirname, '..', '..', '..');
const ROOT = resolve(SRC, '..');

const LIMITS_DIR = join(SRC, 'money', 'limits');
const FILES = [
  join(SRC, 'money', 'fees', 'nuvion-fee-config.ts'),
  join(SRC, 'money', 'fees', 'provider-fee-schedule.ts'),
  join(SRC, 'money', 'fees', 'fees-not-set.ts'),
  join(SRC, 'money', 'fees', 'fees-set.guard.ts'),
  join(SRC, 'wallet-provider', 'wallet-provider-limit.ts'),
  ...readdirSync(LIMITS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(LIMITS_DIR, f)),
];

/**
 * The code of a TypeScript file with every comment, string and template
 * literal blanked out (a template's `${...}` code is kept), and regular
 * expression literals blanked too. Line breaks are kept, so a finding names
 * its line.
 */
function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  const blankOut = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blankOut(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blankOut(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += blankOut(text.slice(i, j + 1));
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let chunk = ' ';
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') {
          chunk += '  ';
          j += 2;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < text.length && depth > 0) {
            if (text[k] === '{') depth += 1;
            if (text[k] === '}') depth -= 1;
            k += 1;
          }
          chunk += '  ' + codeOnly(text.slice(j + 2, k - 1)) + ' ';
          j = k;
          continue;
        }
        chunk += text[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      out += chunk + ' ';
      i = j + 1;
      prevSignificant = '`';
      continue;
    }
    // A regular expression literal: a slash where an operand may start.
    if (c === '/' && /^$|[(,=:[!&|?{};]$/.test(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j += 1;
      }
      j += 1;
      while (j < text.length && /[a-z]/.test(text[j])) j += 1;
      out += blankOut(text.slice(i, j));
      i = j;
      prevSignificant = 'regex';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }
  return out;
}

/** Every numeric literal in this code, with its line, other than 0 and 1. */
function figuresIn(text: string, name: string): string[] {
  const found: string[] = [];
  codeOnly(text)
    .split('\n')
    .forEach((line, index) => {
      for (const m of line.matchAll(
        /(?<![\w$.])(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?|0x[\da-f_]+n?)(?![\w$])/gi,
      )) {
        if (!['0', '1', '0n', '1n'].includes(m[1])) {
          found.push(`${name}:${index + 1} ${m[1]}`);
        }
      }
    });
  return found;
}

function figures(file: string): string[] {
  return figuresIn(readFileSync(file, 'utf8'), relative(ROOT, file));
}

/** `KEY=value` lines of an env file (or of the env block in a Markdown page). */
function settingsIn(file: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) found.set(m[1], [...(found.get(m[1]) ?? []), m[2]]);
  }
  return found;
}

const KEYS = [
  ...Object.values(NUVION_FEE_CONFIG_KEYS),
  ...MONEY_LIMIT_CONFIG_KEYS,
];

describe('NUV-07: no fee or limit figure in source', () => {
  it('scans the files it means to (and the scanner sees code)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(10);
    // Comments and strings are blanked, code is kept.
    expect(codeOnly("const a = 12; // 34\nconst b = '56';")).toBe(
      'const a = 12;      \nconst b =     ;',
    );
    expect(codeOnly('const r = /^[0-9]+$/.test(x) ? 7 : 0;')).toContain(' 7 ');
    expect(codeOnly('f(`a ${2500} b`)')).toContain('2500');
  });

  it('no number but 0 and 1 in the code of the Nuvion fees and the limits', () => {
    expect(FILES.flatMap(figures)).toEqual([]);
  });

  it('a figure written in any of those files would be found', () => {
    expect(figuresIn('export const NUVION_DEFAULT_FEE = 2500;', 'f')).toEqual([
      'f:1 2500',
    ]);
    expect(figuresIn('\nconst daily = 5_000_000n;', 'f')).toEqual([
      'f:2 5_000_000n',
    ]);
    expect(
      figuresIn(
        "return feeOf(rule ?? { kind: 'flat', feeKobo: 4000 }, a);",
        'f',
      ),
    ).toEqual(['f:1 4000']);
    expect(figuresIn('const cap = 1e7; const x = 0x10;', 'f')).toEqual([
      'f:1 1e7',
      'f:1 0x10',
    ]);
    expect(figuresIn('// 2500 in a comment\nconst k = "2500";', 'f')).toEqual(
      [],
    );
  });
});

describe('NUV-07: every setting is listed, with no figure', () => {
  for (const file of ['.env.example', join('deploy', 'README.md')]) {
    it(`${file} lists every Nuvion fee and WAWU limit setting once, each empty`, () => {
      const settings = settingsIn(join(ROOT, file));
      for (const key of KEYS) {
        expect({ key, values: settings.get(key) ?? [] }).toEqual({
          key,
          values: [''],
        });
      }
      // And nothing that looks like one of them but is not read.
      const strays = [...settings.keys()].filter(
        (k) =>
          (k.startsWith('NUVION_FEE_') || k.startsWith('WAWU_LIMIT_')) &&
          !KEYS.includes(k),
      );
      expect(strays).toEqual([]);
    });
  }
});

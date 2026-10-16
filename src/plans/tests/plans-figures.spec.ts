import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';
import { PLANS_CONFIG_FILE } from '../plans-config';

/**
 * TIER-01: "No price, points amount, cost or cap appears in source outside
 * plans.config.json." Two greps over the TypeScript syntax tree (so comments
 * are never counted and a digit inside a name is never a number):
 *
 *  1. In the plan's own code (FIGURE_FREE_DIRS), no number literal equals a
 *     figure in the config, except the few listed in NOT_A_FIGURE with the
 *     reason. A later task that prices from the plan adds its folder here.
 *  2. In every string anywhere in `src/`, no plan price written as money
 *     ("₦1,500", "$3") and no plan points amount written as points
 *     ("1,000 points").
 *
 * Not grepped: number literals across the whole of `src/`. The plan's kobo
 * figures collide with unrelated limits there (Fintava's fee band edge, the
 * statement row cap, the selfie size), so that grep could only fail on
 * coincidences. The plan's figures can only be used through the config.
 *
 * Specs are not scanned: a spec may quote a figure to test the reading of
 * it, and these specs never pin the shipped figures.
 */

const SRC = join(__dirname, '..', '..');
const REPO = join(SRC, '..');

/** Folders whose code works with the plan and must take every figure from the config. */
const FIGURE_FREE_DIRS = ['src/plans'];

/** Number literals in those folders that equal a figure by coincidence. */
const NOT_A_FIGURE: Record<string, Record<number, string>> = {
  'src/plans/plans-config.ts': { 100: 'the top of a percent' },
};

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'tests' || name === 'node_modules') continue;
      out.push(...codeFiles(path));
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts')
    ) {
      out.push(path);
    }
  }
  return out;
}

const rel = (path: string) => relative(REPO, path).split(sep).join('/');

interface Found {
  numbers: { value: number; line: number }[];
  strings: { text: string; line: number }[];
}

/** Number literals and string texts of one file, comments excluded. */
function scan(path: string): Found {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: Found = { numbers: [], strings: [] };
  const line = (n: ts.Node) =>
    file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isNumericLiteral(n)) {
      found.numbers.push({ value: Number(n.text), line: line(n) });
    } else if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      found.strings.push({ text: n.text, line: line(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const raw = JSON.parse(readFileSync(PLANS_CONFIG_FILE, 'utf8')) as {
  [k: string]: Json;
};

/** Every number in the file, with the key path it sits under. */
function numbersIn(v: Json, path: string, out: [string, number][]): void {
  if (typeof v === 'number') out.push([path, v]);
  else if (Array.isArray(v))
    v.forEach((x, i) => numbersIn(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) numbersIn(x, `${path}.${k}`, out);
}

const all: [string, number][] = [];
for (const [k, v] of Object.entries(raw))
  if (k !== 'provisional') numbersIn(v, k, all);

/** 0 and 1 are everywhere (a minimum, a first index) and are not figures. */
const FIGURES = new Set(
  all.map(([, n]) => n).filter((n) => n !== 0 && n !== 1),
);

const kobo = all.filter(([p]) => p.endsWith('.kobo')).map(([, n]) => n);
const cents = all.filter(([p]) => p.endsWith('.cents')).map(([, n]) => n);
const points = all
  .filter(
    ([p]) =>
      /\.points(\.NGN|\.USD)?$/.test(p) ||
      /bonus_points$/.test(p) ||
      /^referral\.base_points\./.test(p) ||
      p === 'caps.daily_points_per_user' ||
      p === 'cash_out.minimum_points',
  )
  .map(([, n]) => n);

function moneyForms(): { form: string; re: RegExp }[] {
  const forms: { form: string; re: RegExp }[] = [];
  const add = (form: string) =>
    forms.push({
      form,
      re: new RegExp(`${form.replace(/[$.]/g, '\\$&')}(?![\\d,.])`),
    });
  for (const k of new Set(kobo)) {
    const naira = k / 100;
    add(`₦${naira.toLocaleString('en-NG')}`);
    add(`₦${naira}`);
  }
  for (const c of new Set(cents)) {
    const dollars = c / 100;
    add(`$${dollars.toFixed(2)}`);
    add(`$${dollars}`);
  }
  return forms;
}

function pointsForms(): { form: string; re: RegExp }[] {
  const forms: { form: string; re: RegExp }[] = [];
  for (const p of new Set(points))
    for (const n of new Set([String(p), p.toLocaleString('en-NG')]))
      forms.push({
        form: `${n} points`,
        re: new RegExp(`(?<![\\d,.])${n.replace(/,/g, ',')} points\\b`, 'i'),
      });
  return forms;
}

describe('the plan figures live only in plans.config.json (TIER-01)', () => {
  it('reads a config that has figures to look for', () => {
    expect(FIGURES.size).toBeGreaterThan(20);
    expect(kobo.length).toBeGreaterThan(5);
    expect(cents.length).toBe(kobo.length);
    expect(points.length).toBeGreaterThan(5);
  });

  it("the plan's own code writes no figure from the config as a number", () => {
    const hits: string[] = [];
    for (const dir of FIGURE_FREE_DIRS)
      for (const path of codeFiles(join(REPO, dir))) {
        const allowed = NOT_A_FIGURE[rel(path)] ?? {};
        for (const { value, line } of scan(path).numbers)
          if (FIGURES.has(value) && !(value in allowed))
            hits.push(`${rel(path)}:${line} ${value}`);
      }
    expect(hits).toEqual([]);
  });

  it('no string in src/ writes a plan price as money', () => {
    const forms = moneyForms();
    const hits: string[] = [];
    for (const path of codeFiles(SRC))
      for (const { text, line } of scan(path).strings)
        for (const { form, re } of forms)
          if (re.test(text)) hits.push(`${rel(path)}:${line} "${form}"`);
    expect(hits).toEqual([]);
  });

  it('no string in src/ writes a plan points amount', () => {
    const forms = pointsForms();
    const hits: string[] = [];
    for (const path of codeFiles(SRC))
      for (const { text, line } of scan(path).strings)
        for (const { form, re } of forms)
          if (re.test(text)) hits.push(`${rel(path)}:${line} "${form}"`);
    expect(hits).toEqual([]);
  });

  it('would catch a figure: the greps find one planted in a string and in code', () => {
    const tier = (raw.tiers as { [k: string]: Json }[])[0];
    const price = (tier.price as { kobo: number }).kobo;
    const naira = (price / 100).toLocaleString('en-NG');
    expect(moneyForms().some(({ re }) => re.test(`Pay ₦${naira} now`))).toBe(
      true,
    );
    expect(
      pointsForms().some(({ re }) =>
        re.test(`You get ${tier.bonus_points as number} points`),
      ),
    ).toBe(true);
    expect(FIGURES.has(price)).toBe(true);
  });
});

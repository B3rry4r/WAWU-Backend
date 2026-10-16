/**
 * FIX-09: no em-dash in anything a person can read from the backend.
 *
 * The product owner's rule (CLAUDE.md, R-5): no em-dash in an error message,
 * a notification, seeded content, an email, a label or a served asset. Code
 * comments are exempt, and so are test files (they are not served).
 *
 * What this reads, without a database or a running server:
 *  - every string and template literal in the TypeScript the Hub ships
 *    (`src/**` outside spec and test files, and `prisma/**` outside the
 *    migrations), through the TypeScript parser, so a comment never counts and
 *    an escaped dash (`—`) is caught as the character it becomes;
 *  - every text asset the Hub serves (`assets/**` and the JSON or HTML files
 *    under `src/`), as raw text, including the escaped and entity forms.
 *
 * It fails with the file and line of each hit, so adding one back names itself.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// The character is written as an escape on purpose: this file must not carry
// one itself, and the scan below would otherwise flag its own source.
const EM_DASH = '—';
const ENTITY_FORMS = /&mdash;|&#0*8212;|&#x0*2014;/i;
const ESCAPED_FORMS = /\\u0*2014|\\u\{0*2014\}|\\x\{0*2014\}/i;

export interface Hit {
  file: string;
  line: number;
  excerpt: string;
}

function hasEmDash(text: string): boolean {
  return text.includes(EM_DASH) || ENTITY_FORMS.test(text);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  const at = Math.max(0, flat.indexOf(EM_DASH));
  return flat.slice(Math.max(0, at - 30), at + 30);
}

/** Em-dashes inside the string and template literals of one TypeScript source. */
export function emDashesInTypeScript(fileName: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node): void => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail;
    if (isText) {
      // `.text` is the cooked value, so an escaped dash is seen as the dash.
      const text = (node as ts.StringLiteral).text;
      if (hasEmDash(text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ file: fileName, line: line + 1, excerpt: excerpt(text) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Em-dashes anywhere in the raw text of an asset, in any of its spellings. */
export function emDashesInText(fileName: string, source: string): Hit[] {
  const hits: Hit[] = [];
  source.split('\n').forEach((lineText, i) => {
    if (hasEmDash(lineText) || ESCAPED_FORMS.test(lineText)) {
      hits.push({ file: fileName, line: i + 1, excerpt: excerpt(lineText) });
    }
  });
  return hits;
}

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'migrations',
  'tests',
  'test',
  '__tests__',
]);

function isTestFile(name: string): boolean {
  return /\.(spec|test|e2e-spec)\.ts$/.test(name) || /\.d\.ts$/.test(name);
}

function walk(dir: string, visit: (file: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name))
        walk(path.join(dir, entry.name), visit);
    } else if (entry.isFile()) {
      visit(path.join(dir, entry.name));
    }
  }
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file);
}

function servedTypeScript(): string[] {
  const files: string[] = [];
  for (const root of ['src', 'prisma']) {
    walk(path.join(REPO_ROOT, root), (f) => {
      if (f.endsWith('.ts') && !isTestFile(path.basename(f))) files.push(f);
    });
  }
  return files;
}

const TEXT_ASSET = /\.(json|svg|html?|hbs|txt|csv|md|xml|yml|yaml)$/i;

function servedTextAssets(): string[] {
  const files: string[] = [];
  walk(path.join(REPO_ROOT, 'assets'), (f) => {
    if (TEXT_ASSET.test(f)) files.push(f);
  });
  walk(path.join(REPO_ROOT, 'src'), (f) => {
    if (TEXT_ASSET.test(f)) files.push(f);
  });
  return files;
}

function describe_(hits: Hit[]): string {
  return hits.map((h) => `${rel(h.file)}:${h.line}  "${h.excerpt}"`).join('\n');
}

describe('FIX-09: no em-dash in anything a person can read', () => {
  it('scans a real set of files (the scan is not empty)', () => {
    expect(servedTypeScript().length).toBeGreaterThan(300);
    // The twelve months of the TGIF book are among the assets scanned.
    const book = servedTextAssets().filter((f) => f.includes('assets/tgif/'));
    expect(book.length).toBeGreaterThanOrEqual(12);
  });

  it('finds no em-dash in a string or template literal the Hub ships', () => {
    const hits: Hit[] = [];
    for (const file of servedTypeScript()) {
      hits.push(...emDashesInTypeScript(file, fs.readFileSync(file, 'utf8')));
    }
    expect(describe_(hits)).toBe('');
  });

  it('finds no em-dash in an asset the Hub serves (the TGIF book, receipts, configs)', () => {
    const hits: Hit[] = [];
    for (const file of servedTextAssets()) {
      hits.push(...emDashesInText(file, fs.readFileSync(file, 'utf8')));
    }
    expect(describe_(hits)).toBe('');
  });
});

describe('FIX-09: the scan itself', () => {
  const dash = EM_DASH;

  it('flags an error message that carries a dash', () => {
    const src = `throw new BadRequestException('Not allowed ${dash} try again.');`;
    const hits = emDashesInTypeScript('x.ts', src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it('flags a template literal, in its head, middle and tail', () => {
    const src = [
      'const a = `one ' + dash + ' ${x}`;',
      'const b = `${x} ' + dash + ' ${y}`;',
      'const c = `${x} ' + dash + ' two`;',
    ].join('\n');
    expect(emDashesInTypeScript('x.ts', src).map((h) => h.line)).toEqual([
      1, 2, 3,
    ]);
  });

  it('flags a dash written as an escape, because it is a dash once cooked', () => {
    const src = "const m = 'Saved \\u2014 try again';";
    expect(emDashesInTypeScript('x.ts', src)).toHaveLength(1);
  });

  it('flags an HTML entity in a string', () => {
    const src = "const html = '<p>Saved &mdash; try again</p>';";
    expect(emDashesInTypeScript('x.ts', src)).toHaveLength(1);
  });

  it('does not flag a comment, a JSDoc block or a regular expression', () => {
    const src = [
      `// a note ${dash} for developers`,
      `/* another ${dash} note */`,
      `/** doc ${dash} comment */`,
      `const re = /\\s*${dash}\\s*/g;`,
      "const ok = 'Saved, try again.';",
    ].join('\n');
    expect(emDashesInTypeScript('x.ts', src)).toHaveLength(0);
  });

  it('flags a dash in a text asset in every spelling', () => {
    expect(emDashesInText('a.json', `{"quote":"a ${dash} b"}`)).toHaveLength(1);
    expect(emDashesInText('a.json', '{"quote":"a \\u2014 b"}')).toHaveLength(1);
    expect(emDashesInText('a.html', '<p>a &mdash; b</p>')).toHaveLength(1);
    expect(emDashesInText('a.html', '<p>a &#8212; b</p>')).toHaveLength(1);
    expect(emDashesInText('a.json', '{"quote":"a, b: c"}')).toHaveLength(0);
  });

  it('leaves the en-dash and the hyphen alone', () => {
    expect(emDashesInText('a.txt', '9–12 and a-b')).toHaveLength(0);
  });
});

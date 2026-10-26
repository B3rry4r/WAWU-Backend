// LEGAL-DOCS: the data migration that writes the owner's nine documents, and its rollback.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  POLICY_MAX_BYTES,
  isCleanText,
  isPlainSections,
} from '../../admin/legal-documents/policy-input';

jest.setTimeout(60_000);

const STAMP = '20261203090100_legal_documents_nine';
const DIR = join(__dirname, '../../../prisma/migrations', STAMP);
const SOURCE = readFileSync(
  join(__dirname, 'fixtures/owner-legal-docs-2026-10-26.txt'),
  'utf8',
);

/** The owner's order and each document's title (the heading line of its block in the owner's text). */
const TITLES: Record<string, string> = {
  privacy: 'PRIVACY POLICY: WHO MADE THIS? (WMT)',
  terms: 'TERMS OF SERVICE',
  cookies: 'COOKIE POLICY',
  'creator-monetization': 'CREATOR MONETIZATION AGREEMENT',
  'verification-refund': 'VERIFICATION AND REFUND POLICY',
  'acceptable-use': 'ACCEPTABLE USE POLICY',
  'partner-dpa': 'DATA PROCESSING AGREEMENT (DPA) FOR PARTNERS',
  'community-guidelines': 'COMMUNITY GUIDELINES',
  disclaimer: 'DISCLAIMER',
};
const ORDER = Object.keys(TITLES);

type Section = { heading: string; body: string };

/**
 * The owner's text turned into sections, by the only changes the owner allowed: sections numbered 1, 2, 3 in order (the
 * source shows "1." on every section after the first document), the Privacy Policy's title without the em-dash, and
 * "#1000" written "₦1,000". Anything before the first numbered section (the title line, a line under it, the dates, an
 * opening paragraph) is kept as a first section headed by the first line.
 */
export function expectedFrom(text: string): Record<string, Section[]> {
  const parts = text.split(/^=== DOCUMENT \d+: .* \(slug: ([a-z-]+)\) ===$/m);
  const out: Record<string, Section[]> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const blocks = parts[i + 1].trim().split(/\n(?:[ \t]*\n)+/);
    const isHeading = (b: string) => /^\d+\. [A-Z][A-Z0-9 ,'()&/?-]*$/.test(b);
    const first = blocks.findIndex(isHeading);
    const lead = blocks.slice(0, first);
    const sections: Section[] = [];
    if (lead.length > 1) {
      sections.push({
        heading: lead[0].replace(' — ', ': '),
        body: lead.slice(1).join('\n\n'),
      });
    }
    let n = 0;
    let current: { heading: string; paras: string[] } | null = null;
    const close = () => {
      if (current) {
        sections.push({
          heading: current.heading,
          body: current.paras.join('\n\n').replace('#1000', '₦1,000'),
        });
      }
    };
    for (const b of blocks.slice(first)) {
      if (isHeading(b)) {
        close();
        n += 1;
        current = { heading: b.replace(/^\d+\./, `${n}.`), paras: [] };
      } else current!.paras.push(b);
    }
    close();
    out[parts[i]] = sections;
  }
  return out;
}

describe('LEGAL-DOCS: the data migration writes the owner nine documents', () => {
  const migration = readFileSync(join(DIR, 'migration.sql'), 'utf8');
  const rollbackFile = readFileSync(join(DIR, 'rollback.sql'), 'utf8');
  // The first line is psql's `\set ON_ERROR_STOP on` (FIX-96); this runner is not psql, so it leaves out lines that start with a backslash.
  const rollback = rollbackFile
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
  const expected = expectedFrom(SOURCE);
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  class Done extends Error {}
  /** Runs `body` inside a transaction that is always rolled back, with the table emptied first; returns what `body` returned. */
  async function inside<T>(
    body: (
      tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> {
    let result!: T;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('DELETE FROM "LegalDocument"');
          result = await body(tx);
          throw new Done();
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      if (!(e instanceof Done)) throw e;
    }
    return result;
  }

  type Row = {
    slug: string;
    title: string;
    effectiveDate: string;
    sections: Section[];
  };
  const read = async (
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  ): Promise<Row[]> =>
    tx.$queryRawUnsafe<Row[]>(
      `SELECT "slug","title","effectiveDate"::text AS "effectiveDate","sections" FROM "LegalDocument" ORDER BY "slug"`,
    );

  it('starts with the stop line', () => {
    expect(rollbackFile.split('\n', 1)[0]).toBe('\\set ON_ERROR_STOP on');
  });

  it('reads the owner text as nine documents in the owner order (the check is not reading nothing)', () => {
    expect(Object.keys(expected)).toEqual(ORDER);
    expect(expected.privacy).toHaveLength(21);
    expect(expected.terms).toHaveLength(18);
    expect(expected.cookies).toHaveLength(6);
    expect(expected['creator-monetization']).toHaveLength(11);
    expect(expected.disclaimer).toHaveLength(4);
  });

  it('writes the nine documents, dated 26 October 2026, each with the owner wording and numbering', async () => {
    const rows = await inside(async (tx) => {
      await tx.$executeRawUnsafe(migration);
      return read(tx);
    });
    expect(rows.map((r) => r.slug).sort()).toEqual([...ORDER].sort());
    for (const row of rows) {
      expect(row.title).toBe(TITLES[row.slug]);
      expect(row.effectiveDate).toBe('2026-10-26');
      expect(row.sections).toEqual(expected[row.slug]);
    }
  });

  it('numbers every section 1, 2, 3 in order, and the Terms point at the right section for the verification fee', async () => {
    const rows = await inside(async (tx) => {
      await tx.$executeRawUnsafe(migration);
      return read(tx);
    });
    for (const row of rows) {
      const numbers = row.sections
        .map((s) => /^(\d+)\. /.exec(s.heading)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
    const terms = rows.find((r) => r.slug === 'terms')!.sections;
    expect(terms.map((s) => s.heading)).toContain('5. VERIFICATION');
    expect(terms[5].heading).toBe('5. VERIFICATION');
    expect(terms.find((s) => s.heading === '8. REFUND POLICY')!.body).toContain(
      'Verification Fees: As set out in Section 5.',
    );
  });

  it('has no em-dash, no "#1000" and the naira amount instead, and nothing the owner dropped', async () => {
    const rows = await inside(async (tx) => {
      await tx.$executeRawUnsafe(migration);
      return read(tx);
    });
    const all = JSON.stringify(rows);
    expect(all).not.toContain('—');
    expect(all).not.toContain('#1000');
    const creator = rows.find((r) => r.slug === 'creator-monetization')!;
    expect(JSON.stringify(creator.sections)).toContain(
      'The minimum payout amount is ₦1,000.',
    );
    // Every line the owner wrote (bar the document markers, the formatting note and the numbers) is in the stored text.
    const stored = rows
      .flatMap((r) => [
        r.title,
        ...r.sections.flatMap((s) => [s.heading, s.body]),
      ])
      .join('\n');
    const stripNumber = (s: string) => s.replace(/^\d+\. /, '');
    const lines = SOURCE.split('\n');
    const wanted = lines
      .slice(lines.findIndex((l) => l.startsWith('=== DOCUMENT 1:')) + 1)
      .filter((l) => l.trim() !== '' && !l.startsWith('=== DOCUMENT'))
      .map((l) =>
        stripNumber(
          l.replace(' \u2014 ', ': ').replace('#1000', '\u20a61,000'),
        ),
      );
    expect(wanted.length).toBeGreaterThan(250);
    const missing = wanted.filter((line) => !stored.includes(line));
    expect(missing).toEqual([]);
  });

  it('writes what the dashboard would accept back, so the owner can save an edit: sizes, plain sections, clean text', async () => {
    const rows = await inside(async (tx) => {
      await tx.$executeRawUnsafe(migration);
      return read(tx);
    });
    for (const row of rows) {
      expect(row.title.length).toBeLessThanOrEqual(120);
      expect(isCleanText(row.title)).toBe(true);
      expect(isPlainSections(row.sections)).toBe(true);
      let bytes = 0;
      for (const s of row.sections) {
        expect(s.heading.length).toBeLessThanOrEqual(200);
        expect(s.body.length).toBeLessThanOrEqual(20000);
        expect(isCleanText(s.heading)).toBe(true);
        expect(isCleanText(s.body)).toBe(true);
        bytes += Buffer.byteLength(s.heading) + Buffer.byteLength(s.body);
      }
      expect(bytes).toBeLessThanOrEqual(POLICY_MAX_BYTES);
    }
  });

  it('replaces a Terms row the owner already saved, and a second run changes nothing', async () => {
    const rows = await inside(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "LegalDocument" ("slug","title","effectiveDate","sections","updatedAt") VALUES ('terms','Old terms',DATE '2026-09-01','[{"heading":"Old","body":"Old text."}]'::jsonb, now())`,
      );
      await tx.$executeRawUnsafe(migration);
      const once = await read(tx);
      await tx.$executeRawUnsafe(migration);
      const twice = await read(tx);
      expect(twice).toEqual(once);
      return once;
    });
    expect(rows).toHaveLength(9);
    const terms = rows.find((r) => r.slug === 'terms')!;
    expect(terms.title).toBe('TERMS OF SERVICE');
    expect(terms.effectiveDate).toBe('2026-10-26');
    expect(JSON.stringify(terms.sections)).not.toContain('Old text.');
  });

  it('leaves a row outside the nine alone', async () => {
    const rows = await inside(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "LegalDocument" ("slug","title","effectiveDate","sections","updatedAt") VALUES ('imprint','Mine',DATE '2026-09-01','[{"heading":"a","body":"b"}]'::jsonb, now())`,
      );
      await tx.$executeRawUnsafe(migration);
      return read(tx);
    });
    expect(rows).toHaveLength(10);
    expect(rows.find((r) => r.slug === 'imprint')!.title).toBe('Mine');
  });

  describe('rollback.sql', () => {
    /** Runs the rollback after the migration (and `setup`); returns the refusal text, or null with the slugs left. */
    async function roll(
      setup?: string,
    ): Promise<{ refused: string | null; left: string[] }> {
      return inside(async (tx) => {
        await tx.$executeRawUnsafe(migration);
        if (setup) await tx.$executeRawUnsafe(setup);
        await tx.$executeRawUnsafe('SAVEPOINT roll');
        let refused: string | null = null;
        try {
          await tx.$executeRawUnsafe(rollback);
        } catch (e) {
          refused = (e as Error).message;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT roll');
        }
        const left = (await read(tx)).map((r) => r.slug);
        return { refused, left };
      });
    }

    it('removes the seven documents old code cannot read when nobody has edited any of the nine, and keeps Terms and Privacy', async () => {
      const { refused, left } = await roll();
      expect(refused).toBeNull();
      expect(left.sort()).toEqual(['privacy', 'terms']);
    });

    it('refuses, and changes nothing, once the owner has saved an edit to any of the nine', async () => {
      const { refused, left } = await roll(
        `UPDATE "LegalDocument" SET "title" = 'Edited', "updatedAt" = now() WHERE "slug" = 'cookies'`,
      );
      expect(refused).toMatch(/LEGAL-DOCS rollback.*Nothing was changed/);
      expect(left).toHaveLength(9);
    });
  });
});

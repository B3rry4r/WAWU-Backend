/**
 * FIX-96: every rollback.sql stops at its first error, however it is run.
 *
 * A rollback guards its drops with a DO block that raises while data exists.
 * psql reports a raise and carries on to the next statement unless
 * ON_ERROR_STOP is on, so a bare `psql -f rollback.sql` would run the drops
 * after the guard had refused and lose the data. The first line of every
 * rollback.sql is therefore psql's own `\set ON_ERROR_STOP on`, and this spec
 * fails for any rollback.sql that lacks it, so a new migration cannot ship
 * without it.
 *
 * It reads the files as text, without a database or a server. A runner that is
 * not psql (a spec running a rollback through Prisma or pg) must leave out the
 * lines that start with a backslash; see the two specs that do.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.resolve(__dirname, '../../../prisma/migrations');

/** The exact first line, with nothing before it (no blank line, no comment, no BOM). */
export const STOP_LINE = '\\set ON_ERROR_STOP on';

/** Null when the text starts as it must, else what is wrong. */
export function firstLineProblem(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0];
  if (first === STOP_LINE) return null;
  return `its first line is ${JSON.stringify(first.slice(0, 60))}, not ${JSON.stringify(STOP_LINE)}`;
}

function rollbackFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(MIGRATIONS, e.name, 'rollback.sql'))
    .filter((f) => fs.existsSync(f))
    .sort();
}

describe('FIX-96: every rollback.sql starts with `\\set ON_ERROR_STOP on`', () => {
  it('finds the rollbacks (the check is not reading nothing)', () => {
    // 24 on 21 Oct 2026; a new migration adds one, none is removed.
    expect(rollbackFiles().length).toBeGreaterThanOrEqual(24);
  });

  it('has the line first in every rollback.sql, so a bare psql -f stops at a guard that raises', () => {
    const problems = rollbackFiles()
      .map((f) => {
        const why = firstLineProblem(fs.readFileSync(f, 'utf8'));
        return why ? `${path.relative(MIGRATIONS, f)}: ${why}` : null;
      })
      .filter((p): p is string => p !== null);
    // The message names each file, so adding a rollback without the line names itself.
    expect(problems).toEqual([]);
  });

  it('the check itself: it takes the exact first line and nothing else', () => {
    expect(firstLineProblem(`${STOP_LINE}\nDROP TABLE "X";\n`)).toBeNull();
    expect(firstLineProblem(`${STOP_LINE}\r\nDROP TABLE "X";\r\n`)).toBeNull();
    // missing, after a comment, after a blank line, off, or spelled differently
    expect(firstLineProblem('DROP TABLE "X";\n')).not.toBeNull();
    expect(firstLineProblem(`-- note\n${STOP_LINE}\n`)).not.toBeNull();
    expect(firstLineProblem(`\n${STOP_LINE}\n`)).not.toBeNull();
    expect(firstLineProblem('\\set ON_ERROR_STOP off\n')).not.toBeNull();
    expect(firstLineProblem('\\set ON_ERROR_STOP on \n')).not.toBeNull();
    expect(firstLineProblem('\\set ON_ERROR_STOP\n')).not.toBeNull();
    expect(firstLineProblem('')).not.toBeNull();
  });
});

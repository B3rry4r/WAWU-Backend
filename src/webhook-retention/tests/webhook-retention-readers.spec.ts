import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  WEBHOOK_STATE_RULES,
  WEBHOOK_TABLE_READERS,
} from '../webhook-retention-config';

/**
 * FIX-20: a delivery's body is cleared when no reader can still need it, so
 * every reader of the two webhook tables has to be known. This scans the
 * server's source (src/ and scripts/, not specs) for any file that touches
 * either table, and fails when one is missing from WEBHOOK_TABLE_READERS, or
 * a listed file no longer touches a table. A new reader is added to the list
 * with what it reads; one that reads a body reads only the rows in a held
 * state (WEBHOOK_STATE_RULES), or changes the rules in its own task.
 */

const ROOT = join(__dirname, '..', '..', '..');

/** The table touched through Prisma's accessor, in raw SQL, or by name. */
const TOUCHES =
  /\b(?:fintavaWebhookEvent|nuvionWebhookEvent)\b|"(?:Fintava|Nuvion)WebhookEvent"|'(?:Fintava|Nuvion)WebhookEvent'/;

/** The rules themselves name the tables; they are the list, not a reader. */
const THE_LIST = 'src/webhook-retention/webhook-retention-config.ts';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === 'dist')
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

function touching(): string[] {
  return [
    ...sourceFiles(join(ROOT, 'src')),
    ...sourceFiles(join(ROOT, 'scripts')),
  ]
    .filter((p) => TOUCHES.test(readFileSync(p, 'utf8')))
    .map((p) => relative(ROOT, p))
    .filter((p) => p !== THE_LIST)
    .sort();
}

describe('FIX-20: every reader of a webhook event table is known', () => {
  it('scans real source (not an empty folder)', () => {
    expect(sourceFiles(join(ROOT, 'src')).length).toBeGreaterThan(500);
  });

  it('no file touches a webhook event table without being listed, and no listed file is stale', () => {
    const listed = WEBHOOK_TABLE_READERS.map((r) => r.file).sort();
    expect(touching()).toEqual(listed);
  });

  it('says what each reader reads', () => {
    for (const r of WEBHOOK_TABLE_READERS) {
      expect(r.reads.length).toBeGreaterThan(30);
      expect(r.reads).not.toContain('—');
    }
  });

  it('the two readers of a body read only pending rows, as the held states say', () => {
    // The ledger sweep and the Nuvion dispatcher are the only readers of
    // `payload`. Both select `pending` rows and check `pending` again under
    // their lock; a held state is what they leave alone.
    expect(WEBHOOK_STATE_RULES.FintavaWebhookEvent.pending.clear).toBe(false);
    expect(WEBHOOK_STATE_RULES.NuvionWebhookEvent.pending.clear).toBe(false);
    const consumer = readFileSync(
      join(ROOT, 'src/money/ledger/ledger-consumer.service.ts'),
      'utf8',
    );
    const dispatcher = readFileSync(
      join(ROOT, 'src/nuvion/webhook/nuvion-webhook-dispatcher.service.ts'),
      'utf8',
    );
    expect(consumer).toContain("processingStatus: 'pending'");
    expect(consumer).toContain("event.processingStatus !== 'pending'");
    expect(dispatcher).toContain("processingStatus: 'pending'");
    expect(dispatcher).toContain("head.processingStatus !== 'pending'");
  });
});

/**
 * NUV-LIVE (R-138): retire every wallet record made on Nuvion's TEST system, before the Hub moves to Nuvion live. WRITTEN,
 * NOT RUN by the task that wrote it: the owner runs it on the server, while the server is still on the test keys.
 *
 * Every Nuvion wallet on the Hub was opened on api.nuvion.dev, and the Hub keeps no environment on its Nuvion rows. On live
 * keys those rows would be read with test ids, would refuse a second opening of the same BVN and phone, and could be paid
 * out of WAWU's live account. This command ends that. It touches the database only: it calls no provider at all.
 *
 *   dry run (default)  writes nothing. Prints how many rows of each kind would be deleted, closed, relabelled or cleared,
 *                      per person an id (no name, email, phone, BVN or account number), who is kept and why, and the phrase.
 *   apply              needs --apply AND --confirm "<the exact phrase the dry run printed>". One transaction per person;
 *                      the person's rows are locked first and every check is run again inside.
 *
 * Refuses unless proveTestProvider (delete-test-account.ts) shows WALLET_PROVIDER=nuvion on Nuvion's sandbox host. On live
 * keys it refuses, so it can never touch a live wallet.
 *
 * A person is KEPT, untouched, and listed, when they hold a row that is not provably Nuvion test money: Flutterwave, a store
 * purchase that is not a store sandbox one, credits bought with money, any row of another wallet provider, or a table whose
 * provider is unclear (scripts/ops/real-money-rows.ts, the same rows OPS-DEL-TEST refuses on). Also kept: a person with a
 * payment, hold, transfer or refund in motion with a kept person (closing it would touch the kept person's side). There is
 * no flag that overrides it. A kept person still carries test records: do not move the server to live keys until each is
 * settled by hand (the command says so at the end).
 *
 * What it does to each kind of row is in scripts/ops/nuvion-live-reset-kinds.ts (KIND_TABLE and STEPS), one reason each. A
 * retired row's provider reads `nuvion_test`, which no server runs.
 *
 *   cd /srv/wawu/hub-api   (the deploy builds dist/scripts/ops/nuvion-live-reset.js with the rest of the Hub)
 *   set -a; . /etc/wawu/hub-api.env; set +a
 *   node dist/scripts/ops/nuvion-live-reset.js
 *   node dist/scripts/ops/nuvion-live-reset.js --apply --confirm "<phrase>"
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PointsService } from '../../src/points/points.service';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { proveTestProvider } from './delete-test-account';
import { findRealMoneyRows, type RealMoneyRow } from './real-money-rows';
import {
  CLOSED_WORDS,
  KIND_TABLE,
  type Mode,
  PROVIDER_PARTY_TABLES,
  POINT_CONVERSION_STEP,
  RETIRED_PROVIDER,
  SHARED_IN_MOTION,
  STEPS,
  type Step,
} from './nuvion-live-reset-kinds';

type Db =
  PrismaService | Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface Deps {
  prisma: PrismaService;
  points: Pick<PointsService, 'release'>;
  getEnv: (key: string) => string | undefined;
  out: (line: string) => void;
  /** A test hook, never set by the command line: look only at these people (a shared test database holds others). */
  onlyIds?: string[];
  /** A test hook: runs for each person after the plan is made and before they are retired. */
  beforePerson?: (id: string) => Promise<void>;
}

export interface Options {
  apply: boolean;
  confirm?: string;
}

export const phraseFor = (n: number) => `RETIRE ${n} NUVION TEST WALLETS`;

const IDS = '$1::text[]';

function pred(cols: string[], mode: Mode): string {
  if (cols.length === 0) return mode === 'persons' ? 'FALSE' : 'TRUE';
  return mode === 'persons'
    ? `(${cols.map((c) => `${c} = ANY(${IDS})`).join(' OR ')})`
    : `NOT (${cols.map((c) => `COALESCE(${c} = ANY(${IDS}), FALSE)`).join(' OR ')})`;
}

const ENTITIES = `SELECT "entityId" FROM "NuvionEntity" WHERE "entityId" IS NOT NULL AND "wawuUserId" = ANY(${IDS})`;

function whereOf(step: Step, mode: Mode): string {
  // Every statement names $1, so the driver always gets the parameter it is given.
  return `(${whereCore(step, mode)}) AND ${IDS} IS NOT NULL`;
}

function whereCore(step: Step, mode: Mode): string {
  let base = step.base;
  const placeholder =
    base.includes('__LEDGER_PARTY__') ||
    base.includes('__SCHOOL_PARTY__') ||
    step.id === 'book_transfers';
  base = base
    .replace('__LEDGER_PARTY__', pred(['"wawuUserId"'], mode))
    .replace('__SCHOOL_PARTY__', pred(['"wawuUserId"'], mode));
  if (step.id === 'book_transfers') {
    const hit = `("fromEntityId" IN (${ENTITIES}) OR "toEntityId" IN (${ENTITIES}))`;
    return mode === 'persons'
      ? hit
      : `NOT (COALESCE("fromEntityId" IN (${ENTITIES}), FALSE) OR COALESCE("toEntityId" IN (${ENTITIES}), FALSE))`;
  }
  return placeholder ? base : `${base} AND ${pred(step.party, mode)}`;
}

const stepsFor = (mode: Mode) =>
  STEPS.filter((s) => !(mode === 'orphans' && s.personOnly));

const verbOf = (s: Step) =>
  s.verb === 'delete' ? 'deleted' : KIND_TABLE[s.model].action;

async function countStep(
  db: Db,
  s: Step,
  mode: Mode,
  ids: string[],
): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM ${s.table} WHERE ${whereOf(s, mode)}`,
    ids,
  );
  return rows[0].n;
}

async function runStep(
  db: Db,
  s: Step,
  mode: Mode,
  ids: string[],
): Promise<number> {
  const where = whereOf(s, mode);
  const sql =
    s.verb === 'delete'
      ? `DELETE FROM ${s.table} WHERE ${where}`
      : `UPDATE ${s.table} SET ${s.set} WHERE ${where}`;
  return db.$executeRawUnsafe(sql, ids);
}

async function countConversions(db: Db, ids: string[]): Promise<number> {
  const r = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "PointConversion" WHERE "provider" = 'nuvion' AND "status" = 'held' AND "wawuUserId" = ANY(${IDS})`,
    ids,
  );
  return r[0].n;
}

/** Cancels each held test conversion and gives its points back, the service's own way (the table's trigger demands both). */
async function runConversions(
  db: Db,
  points: Deps['points'],
  ids: string[],
): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "PointConversion" WHERE "provider" = 'nuvion' AND "status" = 'held' AND "wawuUserId" = ANY(${IDS}) ORDER BY "id" FOR UPDATE`,
    ids,
  );
  for (const { id } of rows) {
    await db.$executeRawUnsafe(
      `UPDATE "PointConversion" SET "status" = 'cancelled', "settledAt" = now(), "failureReason" = $2, "nextAttemptAt" = NULL, "reviewSince" = NULL WHERE "id" = $1 AND "status" = 'held'`,
      id,
      CLOSED_WORDS,
    );
    try {
      await points.release({ purpose: 'cash_out', reference: id }, { tx: db });
    } catch (e) {
      if ((e as { code?: string }).code !== 'points_hold_not_found') throw e;
    }
  }
  return rows.length;
}

/** Everyone who holds a row of the test system. */
async function discover(db: Db): Promise<string[]> {
  const parts: string[] = [];
  for (const s of STEPS) {
    if (s.noDiscover) continue;
    if (s.discover) {
      parts.push(s.discover);
      continue;
    }
    for (const c of s.party) {
      parts.push(`SELECT ${c} AS id FROM ${s.table} WHERE ${s.base}`);
    }
  }
  // A store sandbox earning is test money too, and may wait for a person with no wallet.
  parts.push(
    `SELECT "payeeWawuUserId" AS id FROM "StoreEarning" WHERE ${STEPS.find((x) => x.id === 'store_earnings')!.base}`,
  );
  parts.push(
    `SELECT "wawuUserId" AS id FROM "PointConversion" WHERE "provider" = 'nuvion' AND "status" = 'held'`,
  );
  const rows = await db.$queryRawUnsafe<Array<{ id: string | null }>>(
    `SELECT DISTINCT id FROM (${parts.join(' UNION ')}) x WHERE id IS NOT NULL ORDER BY id`,
  );
  return rows.map((r) => r.id!);
}

const TABLE_OF_MODEL: Record<string, string> = Object.fromEntries(
  PROVIDER_PARTY_TABLES.map((t) => [t.table.replace(/"/g, ''), t.table]),
);

/** The rows that make a person not provably test money. Run on the Hub's handle or inside the transaction. */
export async function keepReasons(db: Db, id: string): Promise<RealMoneyRow[]> {
  const found = await findRealMoneyRows(db as PrismaService, id, 'nuvion');
  const out: RealMoneyRow[] = [];
  for (const r of found) {
    // The command's own cache columns on a payout account are not money.
    if (r.table === 'MoneyPayoutAccount') continue;
    // A row this command already retired is not another provider's money.
    const t = TABLE_OF_MODEL[r.table];
    if (r.klass === 'provider' && t && r.id !== '?') {
      const p = await db.$queryRawUnsafe<Array<{ provider: string | null }>>(
        `SELECT "provider" FROM ${t} WHERE "id" = $1`,
        r.id,
      );
      if (p[0]?.provider === RETIRED_PROVIDER) continue;
    }
    out.push(r);
  }
  for (const t of PROVIDER_PARTY_TABLES) {
    const rows = await db.$queryRawUnsafe<Array<{ k: string }>>(
      `SELECT ${t.id}::text AS k FROM ${t.table} WHERE (${t.party.map((c) => `${c} = $1`).join(' OR ')}) AND "provider" IS DISTINCT FROM 'nuvion' AND "provider" IS DISTINCT FROM '${RETIRED_PROVIDER}' LIMIT 3`,
      id,
    );
    for (const r of rows)
      out.push({
        table: t.table.replace(/"/g, ''),
        id: r.k,
        status: '-',
        amountKobo: '-',
        klass: 'provider',
        why: 'a row of a wallet provider other than Nuvion, or with no provider',
      });
  }
  return out;
}

async function sharedEdges(db: Db): Promise<Array<[string, string]>> {
  const edges: Array<[string, string]> = [];
  for (const t of SHARED_IN_MOTION) {
    const rows = await db.$queryRawUnsafe<Array<{ a: string; b: string }>>(
      `SELECT ${t.a} AS a, ${t.b} AS b FROM ${t.table} WHERE ${t.open} AND ${t.a} IS NOT NULL AND ${t.b} IS NOT NULL AND ${t.a} <> ${t.b}`,
    );
    for (const r of rows) edges.push([r.a, r.b]);
  }
  return edges;
}

/** Closes the kept set over rows in motion: whoever shares one with a kept person is kept. */
function closeKept(
  kept: Map<string, string[]>,
  edges: Array<[string, string]>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of edges) {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        if (kept.has(x) && !kept.has(y)) {
          kept.set(y, [
            'a payment, hold, transfer or refund in motion with a kept person',
          ]);
          changed = true;
        }
      }
    }
  }
}

interface Plan {
  persons: string[];
  retire: string[];
  kept: Map<string, string[]>;
  keptRows: Map<string, RealMoneyRow[]>;
}

async function makePlan(deps: Deps): Promise<Plan> {
  const { prisma } = deps;
  let persons = await discover(prisma);
  if (deps.onlyIds) persons = persons.filter((p) => deps.onlyIds!.includes(p));
  const kept = new Map<string, string[]>();
  const keptRows = new Map<string, RealMoneyRow[]>();
  for (const id of persons) {
    const rows = await keepReasons(prisma, id);
    if (rows.length > 0) {
      keptRows.set(id, rows);
      kept.set(id, ['holds money that is not provably Nuvion test money']);
    }
  }
  closeKept(kept, await sharedEdges(prisma));
  return {
    persons,
    retire: persons.filter((p) => !kept.has(p)),
    kept,
    keptRows,
  };
}

export interface ApplyResult {
  kept?: string;
  counts: Record<string, number>;
}

/** One person, one transaction: lock, check again, retire. */
async function retirePerson(
  deps: Deps,
  id: string,
  keptIds: string[],
): Promise<ApplyResult> {
  const counts: Record<string, number> = {};
  return deps.prisma.$transaction(
    async (tx) => {
      const ids = [id];
      // 1. Lock first: this person's rows in every table the steps touch, in a fixed order.
      for (const s of stepsFor('persons')) {
        if (s.party.length === 0 && !s.base.includes('__')) continue;
        if (s.id === 'book_transfers' || s.id === 'ledger_receipts') continue;
        await tx.$queryRawUnsafe(
          `SELECT 1 FROM ${s.table} WHERE ${whereOf(s, 'persons')} FOR UPDATE`,
          ids,
        );
      }
      // 2. Checks again, now that nothing can change under us.
      const rows = await keepReasons(tx, id);
      if (rows.length > 0)
        return {
          kept: `real money appeared (${[...new Set(rows.map((r) => r.table))].join(', ')})`,
          counts,
        };
      const edges = await sharedEdges(tx);
      const kept = new Map(keptIds.map((k) => [k, ['kept']]));
      closeKept(kept, edges);
      if (kept.has(id))
        return {
          kept: 'a payment, hold, transfer or refund in motion with a kept person',
          counts,
        };
      // 3. Retire.
      for (const s of stepsFor('persons')) {
        if (s.id === 'pass_refunds') {
          counts[POINT_CONVERSION_STEP] = await runConversions(
            tx,
            deps.points,
            ids,
          );
        }
        counts[s.id] = await runStep(tx, s, 'persons', ids);
      }
      return { counts };
    },
    { timeout: 5 * 60 * 1000, maxWait: 60 * 1000 },
  );
}

/** The unowned rows, on the handle given (the Hub's own, or a transaction a test rolls back). */
export async function runUnowned(
  db: Db,
  keptIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const s of stepsFor('orphans')) {
    counts[s.id] = await runStep(db, s, 'orphans', keptIds);
  }
  return counts;
}

async function retireUnowned(
  deps: Deps,
  keptIds: string[],
): Promise<Record<string, number>> {
  return deps.prisma.$transaction((tx) => runUnowned(tx, keptIds), {
    timeout: 5 * 60 * 1000,
    maxWait: 60 * 1000,
  });
}

const sum = (c: Record<string, number>) =>
  Object.values(c).reduce((a, n) => a + n, 0);

async function countAll(
  db: Db,
  mode: Mode,
  ids: string[],
): Promise<Record<string, number>> {
  const c: Record<string, number> = {};
  for (const s of stepsFor(mode)) c[s.id] = await countStep(db, s, mode, ids);
  if (mode === 'persons')
    c[POINT_CONVERSION_STEP] = await countConversions(db, ids);
  return c;
}

/** Runs the command. Returns the exit code: 0 done or nothing to do, 1 refused, 2 failed. */
export async function nuvionLiveReset(
  deps: Deps,
  opts: Options,
): Promise<number> {
  const { out, prisma } = deps;
  const refuse = (why: string) => {
    out(`REFUSED: ${why}`);
    out('Nothing was changed.');
    return 1;
  };
  const proof = proveTestProvider(deps.getEnv);
  if (!proof.ok)
    return refuse(
      `the wallet provider is not proven to be on Nuvion test credentials (${proof.why}). This command only runs while the server is still on the test keys.`,
    );
  if (proof.provider !== 'nuvion')
    return refuse(
      `the wallet provider is ${proof.provider}, not nuvion. This command retires Nuvion test records only.`,
    );

  const plan = await makePlan(deps);
  const keptIds = [...plan.kept.keys()];
  const personTotals = await countAll(prisma, 'persons', plan.retire);
  // With a test hook narrowing the people, the unowned rows of a shared test database are not this run's.
  const orphanTotals = deps.onlyIds
    ? {}
    : await countAll(prisma, 'orphans', [...keptIds, ...plan.retire]);
  const phrase = phraseFor(plan.retire.length);

  out(opts.apply ? 'APPLY' : 'DRY RUN (nothing is written)');
  out(`Provider: ${proof.provider}, ${proof.environment}. ${proof.proof}`);
  out(
    'This command calls no provider. It reads and writes the Hub database only.',
  );
  out(`People with a record of the test system: ${plan.persons.length}`);
  out(`  to retire: ${plan.retire.length}`);
  out(`  kept (not provably test money): ${plan.kept.size}`);

  const names: Record<string, string> = {};
  for (const s of STEPS) names[s.id] = `${s.model} (${s.id})`;
  names[POINT_CONVERSION_STEP] = 'PointConversion (point_conversions)';
  const line = (id: string, n: number, mode: string) => {
    const s = STEPS.find((x) => x.id === id);
    const what = s ? verbOf(s) : 'closed';
    out(`  ${names[id]}: ${what} ${n}${mode}`);
  };
  out('What apply would do, rows per kind, for the people to retire:');
  for (const [id, n] of Object.entries(personTotals))
    if (n > 0) line(id, n, '');
  out(
    "And for rows that belong to no kept person (unowned, WAWU's own test account, logs):",
  );
  for (const [id, n] of Object.entries(orphanTotals))
    if (n > 0) line(id, n, '');

  for (const id of plan.retire) {
    const c = await countAll(prisma, 'persons', [id]);
    const parts = Object.entries(c)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`);
    out(`Person ${id}: ${parts.join(', ') || 'nothing'}`);
  }
  for (const [id, why] of plan.kept) {
    out(`KEPT ${id}: ${why.join('; ')}`);
    for (const r of plan.keptRows.get(id) ?? [])
      out(
        `    ${r.table} ${r.id} status ${r.status} amount ${r.amountKobo} kobo [${r.klass}: ${r.why}]`,
      );
  }
  out(
    `Totals: ${plan.retire.length} people, ${sum(personTotals)} rows for them, ${sum(orphanTotals)} unowned rows`,
  );
  if (plan.retire.length === 0 && sum(orphanTotals) === 0) {
    out('Nothing to retire.');
    if (plan.kept.size > 0) keptWarning(out, plan.kept.size);
    return 0;
  }
  out(`Confirmation phrase: ${phrase}`);
  if (!opts.apply) {
    out('Dry run only. To retire: add --apply --confirm "<the phrase above>".');
    if (plan.kept.size > 0) keptWarning(out, plan.kept.size);
    return 0;
  }
  if (opts.confirm === undefined)
    return refuse('--apply needs --confirm with the exact phrase above.');
  if (opts.confirm !== phrase)
    return refuse('the confirmation phrase is not the one printed above.');

  let done = 0;
  const stopped: string[] = [];
  const failures: string[] = [];
  for (const id of plan.retire) {
    try {
      await deps.beforePerson?.(id);
      const res = await retirePerson(deps, id, keptIds);
      if (res.kept) {
        stopped.push(id);
        out(`Kept ${id}: ${res.kept}.`);
      } else {
        done++;
        out(
          `Retired ${id}: ${
            Object.entries(res.counts)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${k} ${n}`)
              .join(', ') || 'nothing left'
          }`,
        );
      }
    } catch (e) {
      failures.push(id);
      out(
        `FAILED ${id}: ${(e as Error).message.slice(0, 200)} (that person is unchanged)`,
      );
    }
  }
  const allKept = [...keptIds, ...stopped, ...failures];
  try {
    // With a test hook narrowing the people, the unowned rows of a shared test database are not this run's to touch.
    const c = deps.onlyIds ? {} : await retireUnowned(deps, allKept);
    out(
      `Unowned rows: ${
        Object.entries(c)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || 'none'
      }`,
    );
  } catch (e) {
    failures.push('unowned');
    out(
      `FAILED unowned rows: ${(e as Error).message.slice(0, 200)} (unchanged)`,
    );
  }
  // What is left: nothing of the test system may remain for anyone who is not kept.
  const left = deps.onlyIds ? {} : await countAll(prisma, 'orphans', allKept);
  const leftN = sum(left);
  out(
    `Audit: retired ${done} people at ${new Date().toISOString()}; kept ${allKept.length}; failed ${failures.length}; rows still on the test system outside kept people ${leftN}`,
  );
  if (failures.length > 0 || leftN > 0) {
    out('Not finished. It is safe to run the same command again.');
    return 2;
  }
  out('Done. Running the dry run again finds nothing to retire.');
  if (allKept.length > 0) keptWarning(out, allKept.length);
  return 0;
}

function keptWarning(out: (l: string) => void, n: number) {
  out(
    `WARNING: ${n} kept ${n === 1 ? 'person still carries' : 'people still carry'} test records (listed above). Do not move the server to live keys until each is settled by hand, or live Nuvion will be asked about test ids and test earnings could be paid.`,
  );
}

export function parseArgs(argv: string[]): Options | string {
  const known = ['--apply', '--confirm'];
  const unknown = argv.filter(
    (a, i) =>
      a.startsWith('--') && !known.includes(a) && argv[i - 1] !== '--confirm',
  );
  if (unknown.length > 0)
    return `unknown option ${unknown[0]}. There is no flag that retires a person holding real money.`;
  const i = argv.indexOf('--confirm');
  if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith('--')))
    return 'usage: [--apply --confirm "<phrase>"]';
  return {
    apply: argv.includes('--apply'),
    confirm: i >= 0 ? argv[i + 1] : undefined,
  };
}

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule] })
class OpsModule {}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    console.error(opts);
    return 1;
  }
  // The proof comes before anything connects.
  const early = proveTestProvider((k) => process.env[k]);
  if (!early.ok) {
    console.log(
      `REFUSED: the wallet provider is not proven to be on Nuvion test credentials (${early.why}).`,
    );
    console.log('Nothing was changed.');
    return 1;
  }
  const app = await NestFactory.createApplicationContext(OpsModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService, { strict: false });
    return await nuvionLiveReset(
      {
        prisma,
        points: new PointsService(prisma),
        getEnv: (k) => process.env[k],
        out: (l) => console.log(l),
      },
      opts,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`FAILED: ${(e as Error).message}`);
      process.exit(2);
    },
  );
}

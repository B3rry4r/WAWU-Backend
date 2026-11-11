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
 * The unit retired is the Nuvion TEST WALLET of every person who has one: wallet, entity, accounts, opening, onboarding,
 * documents, identity rows, BVN and phone claims, and every Nuvion-provider money row that is provably test money. Real
 * money (Flutterwave, a store purchase that is not a sandbox one, Fintava, other providers) is never a Nuvion row, so no
 * step reaches it, and a person holding real money is retired all the same. WAWU Credits and Studio points are counts and
 * are never touched. A credit balance is never a reason to keep anything.
 *
 * What stays untouched, and is listed row by row, is a Nuvion-provider row that cannot be proven test money: an earning
 * of a REAL store purchase waiting for a wallet (R-11), a store-refund debt, a payout of such an earning. If such a row
 * holds a Nuvion test id that a live sweep would use (an unfinished store payout: it carries the test merchant account and
 * the test destination account), that person's apply is REFUSED and the row is listed. No flag overrides it; the owner
 * settles that row first.
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
import {
  CLOSED_WORDS,
  KIND_TABLE,
  type Mode,
  POINT_CONVERSION_STEP,
  SANDBOX_STORE_PURCHASES,
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
  // An unfinished payout of a REAL store purchase holds test account numbers: its person must be seen, to be refused.
  parts.push(
    `SELECT "payeeWawuUserId" AS id FROM "StoreEarningPayout" WHERE "provider" = 'nuvion' AND "status" NOT IN ('paid', 'cancelled')`,
  );
  const rows = await db.$queryRawUnsafe<Array<{ id: string | null }>>(
    `SELECT DISTINCT id FROM (${parts.join(' UNION ')}) x WHERE id IS NOT NULL ORDER BY id`,
  );
  return rows.map((r) => r.id!);
}

/** A Nuvion-provider row that is not provably test money: it stays, untouched, and is listed. */
export interface StayRow {
  person: string;
  table: string;
  id: string;
  status: string;
  amountKobo: string;
  /** True when the row holds or points at a Nuvion test id that a live sweep, retry or webhook would use. */
  refuses: boolean;
  why: string;
}

const NOT_FINAL_PAYOUT = `p."status" NOT IN ('paid', 'cancelled')`;

/**
 * The Nuvion-provider rows of these people that cannot be proven test money (R-138, NUV-LIVE). Three kinds, and only these:
 *  - StoreEarning of a store purchase that is not a sandbox one: real money owed, waits for a wallet (R-11). No id.
 *  - EarningDeduction of a store refund of such a purchase: a real debt, taken from the next live move. No id.
 *  - StoreEarningPayout of such an earning. A final one (paid, cancelled) is history and holds nothing a sweep reads. An
 *    unfinished one carries the TEST merchant account and the TEST destination account and is sent from them once the
 *    person has a live wallet, so it REFUSES the person.
 * Every other Nuvion-provider row is a row of a test wallet or of money paid from one: provable, and retired.
 */
export async function stayingRows(db: Db, ids: string[]): Promise<StayRow[]> {
  if (ids.length === 0) return [];
  const out: StayRow[] = [];
  const real = `NOT (e."storePurchaseId" IN (${SANDBOX_STORE_PURCHASES}))`;
  const earnings = await db.$queryRawUnsafe<
    Array<{ id: string; person: string; status: string; kobo: string }>
  >(
    `SELECT e."id", e."payeeWawuUserId" AS person, e."status", e."amountKobo"::text AS kobo FROM "StoreEarning" e
      WHERE e."provider" = 'nuvion' AND e."status" = 'owed' AND ${real} AND e."payeeWawuUserId" = ANY(${IDS}) ORDER BY e."id"`,
    ids,
  );
  for (const r of earnings)
    out.push({
      person: r.person,
      table: 'StoreEarning',
      id: r.id,
      status: r.status,
      amountKobo: r.kobo,
      refuses: false,
      why: 'real store money waiting for a wallet (R-11); no Nuvion id; stays owed and lands on the live wallet',
    });
  const debts = await db.$queryRawUnsafe<
    Array<{ id: string; person: string; kobo: string }>
  >(
    `SELECT d."id", d."payeeWawuUserId" AS person, d."amountKobo"::text AS kobo FROM "EarningDeduction" d
      WHERE d."provider" = 'nuvion' AND d."passRefundId" IS NULL AND d."storePurchaseId" IS NOT NULL
        AND NOT (d."storePurchaseId" IN (${SANDBOX_STORE_PURCHASES})) AND d."payeeWawuUserId" = ANY(${IDS}) ORDER BY d."id"`,
    ids,
  );
  for (const r of debts)
    out.push({
      person: r.person,
      table: 'EarningDeduction',
      id: r.id,
      status: '-',
      amountKobo: r.kobo,
      refuses: false,
      why: 'debt from a refund of a real store purchase; no Nuvion id; taken from the next live move',
    });
  const payouts = await db.$queryRawUnsafe<
    Array<{ id: string; person: string; status: string; kobo: string }>
  >(
    `SELECT p."id", p."payeeWawuUserId" AS person, p."status", p."amountKobo"::text AS kobo FROM "StoreEarningPayout" p
       JOIN "StoreEarning" e ON e."id" = p."storeEarningId"
      WHERE p."provider" = 'nuvion' AND ${NOT_FINAL_PAYOUT} AND ${real} AND p."payeeWawuUserId" = ANY(${IDS}) ORDER BY p."id"`,
    ids,
  );
  for (const r of payouts)
    out.push({
      person: r.person,
      table: 'StoreEarningPayout',
      id: r.id,
      status: r.status,
      amountKobo: r.kobo,
      refuses: true,
      why: 'real store money, payout not finished: it holds the TEST merchant account and TEST destination account and would be sent from them on live. Settle this row first',
    });
  return out;
}

interface Plan {
  persons: string[];
  retire: string[];
  /** People whose apply is refused, with the rows that refuse them. */
  refused: Map<string, StayRow[]>;
  stay: StayRow[];
}

async function makePlan(deps: Deps): Promise<Plan> {
  const { prisma } = deps;
  let persons = await discover(prisma);
  if (deps.onlyIds) persons = persons.filter((p) => deps.onlyIds!.includes(p));
  const stay = await stayingRows(prisma, persons);
  const refused = new Map<string, StayRow[]>();
  for (const r of stay)
    if (r.refuses) refused.set(r.person, [...(refused.get(r.person) ?? []), r]);
  return {
    persons,
    retire: persons.filter((p) => !refused.has(p)),
    refused,
    stay,
  };
}

export interface ApplyResult {
  /** Why this person was refused (rows listed by the caller), when they were. */
  refused?: StayRow[];
  counts: Record<string, number>;
}

/** One person, one transaction: lock, check again, retire. */
async function retirePerson(deps: Deps, id: string): Promise<ApplyResult> {
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
      // 2. Check again, now that nothing can change under us. A payout is planned under a lock on the earning, so the
      //    earnings are locked first, as the payout service does.
      await tx.$queryRawUnsafe(
        `SELECT 1 FROM "StoreEarning" WHERE "payeeWawuUserId" = ANY(${IDS}) FOR UPDATE`,
        ids,
      );
      const blocking = (await stayingRows(tx, ids)).filter((r) => r.refuses);
      if (blocking.length > 0) return { refused: blocking, counts };
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
  /** A test hook: run only these steps. */
  only?: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const s of stepsFor('orphans')) {
    if (only && !only.includes(s.id)) continue;
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

/** Nuvion's live keys start with this. A key of that shape is never run against, whatever host it sits with. */
const LIVE_KEY_PREFIX = /^["']?\s*nv_live_/i;

/** The refusal for a live-shaped key, or null. The key is read here and never printed. */
export function liveKeyRefusal(
  get: (key: string) => string | undefined,
): string | null {
  const key = get('NUVION_API_KEY');
  return key !== undefined && LIVE_KEY_PREFIX.test(key)
    ? 'NUVION_API_KEY starts with nv_live_, the shape of a live key (the key is not printed). This command only runs while the server is still on the test keys.'
    : null;
}

/** Runs the command. Returns the exit code: 0 done or nothing to do, 1 refused, 2 not finished (safe to run again). */
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
  const keyWhy = liveKeyRefusal(deps.getEnv);
  if (keyWhy) return refuse(keyWhy);

  const plan = await makePlan(deps);
  const heldBack = [...plan.refused.keys()];
  const personTotals = await countAll(prisma, 'persons', plan.retire);
  // With a test hook narrowing the people, the unowned rows of a shared test database are not this run's.
  const orphanTotals = deps.onlyIds
    ? {}
    : await countAll(prisma, 'orphans', [...heldBack, ...plan.retire]);
  const phrase = phraseFor(plan.retire.length);

  out(opts.apply ? 'APPLY' : 'DRY RUN (nothing is written)');
  out(
    `Provider: ${proof.provider}, ${proof.environment}. ${proof.proof}. The key does not start with nv_live_ (it is not printed).`,
  );
  out(
    'This command calls no provider. It reads and writes the Hub database only.',
  );
  out(`People with a record of the test system: ${plan.persons.length}`);
  out(`  to retire: ${plan.retire.length}`);
  out(`  refused (a row that cannot be proven test money): ${heldBack.length}`);

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
    "And for rows that belong to no refused person (unowned, WAWU's own test account, logs):",
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
  if (plan.stay.length > 0) {
    out(
      'Rows that STAY untouched (Nuvion rows that cannot be proven test money; real store money, kept for the live wallet):',
    );
    for (const r of plan.stay)
      out(
        `  ${r.refuses ? 'REFUSES ' : ''}${r.table} ${r.id} of ${r.person} status ${r.status} amount ${r.amountKobo} kobo: ${r.why}`,
      );
  }
  for (const id of heldBack)
    out(
      `REFUSED ${id}: ${plan.refused.get(id)!.length} row(s) above hold a Nuvion test id that live Nuvion would be sent. This person is not retired.`,
    );
  out(
    `Totals: ${plan.retire.length} people, ${sum(personTotals)} rows for them, ${sum(orphanTotals)} unowned rows`,
  );
  if (plan.retire.length === 0 && sum(orphanTotals) === 0) {
    out('Nothing to retire.');
    if (heldBack.length > 0) refusedWarning(out, heldBack.length);
    return opts.apply && heldBack.length > 0 ? 2 : 0;
  }
  out(`Confirmation phrase: ${phrase}`);
  if (!opts.apply) {
    out('Dry run only. To retire: add --apply --confirm "<the phrase above>".');
    if (heldBack.length > 0) refusedWarning(out, heldBack.length);
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
      const res = await retirePerson(deps, id);
      if (res.refused) {
        stopped.push(id);
        out(
          `Refused ${id}: a row appeared that holds a Nuvion test id (${res.refused.map((r) => `${r.table} ${r.id}`).join(', ')}). Not retired.`,
        );
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
  const allHeld = [...heldBack, ...stopped, ...failures];
  try {
    // With a test hook narrowing the people, the unowned rows of a shared test database are not this run's to touch.
    const c = deps.onlyIds ? {} : await retireUnowned(deps, allHeld);
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
  // What is left: nothing of the test system may remain for anyone who is not held back.
  const left = deps.onlyIds ? {} : await countAll(prisma, 'orphans', allHeld);
  const leftN = sum(left);
  out(
    `Audit: retired ${done} people at ${new Date().toISOString()}; refused ${heldBack.length + stopped.length}; failed ${failures.length}; rows still on the test system outside refused people ${leftN}`,
  );
  if (failures.length > 0 || leftN > 0) {
    out(
      'Not finished. It is safe to run the same command again. (If someone opened a wallet while this ran, the audit counts it and this ends here; run it again.)',
    );
    return 2;
  }
  if (heldBack.length + stopped.length > 0) {
    refusedWarning(out, heldBack.length + stopped.length);
    return 2;
  }
  out('Done. Running the dry run again finds nothing to retire.');
  return 0;
}

function refusedWarning(out: (l: string) => void, n: number) {
  out(
    `NOT FINISHED: ${n} ${n === 1 ? 'person was' : 'people were'} refused (rows listed above) and still carry a test wallet. Settle each listed row, then run the command again. Do not move the server to live keys until a dry run says "Nothing to retire" with no refused person.`,
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
  const keyWhy = liveKeyRefusal((k) => process.env[k]);
  if (keyWhy) {
    console.log(`REFUSED: ${keyWhy}`);
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

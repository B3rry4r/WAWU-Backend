/**
 * OPS-DEL-TEST: delete ONE test account that holds sandbox wallet money, on the owner's word. WRITTEN, NOT RUN by the
 * task that wrote it: the owner runs it on the server.
 *
 * The app refuses to delete an account whose wallet holds money (R-17). A test account's money is sandbox money that
 * cannot be withdrawn, so this script waives that one blocker, for a server whose wallet provider is proven to be on
 * TEST or sandbox credentials, and for nothing else.
 *
 *   dry run (default)  writes nothing; prints what apply would do, and the confirmation phrase for that account.
 *   apply              needs --apply AND --confirm "<the exact phrase the dry run printed>".
 *
 * Refuses unless: exactly one account has the email; the provider is on sandbox (proven from the adapter's own
 * settings reader: WALLET_PROVIDER picks the adapter, then NUVION_BASE_URL must be Nuvion's sandbox host, or
 * FINTAVA_BASE_URL Fintava's sandbox host; the values are compared, never printed, and no key is read); the account is
 * not an admin login; and no blocker besides the wallet balance exists (an open hold, waiting earnings, a payment in
 * flight) unless --allow-test-holds is passed.
 *
 * Apply uses the app's own services: the money check (AccountDeletionMoneyService), the deletion row (status `purging`,
 * no 30-day wait), WAWU ID told through the Hub's identity service and client, then the sweep's own purge steps for
 * this one account (`purgeNow`: held points released, AccountPurgeService.purge, the deleted-account email, WAWU ID
 * anonymised, row `purged`). Pieces other people bought stay with their buyers (R-130, the purge's own rule). The
 * AccountDeletion row (reason `ops_delete_test_account`, status `purged`, the purge note) is the audit record and stays.
 * Running it again finds nothing: WAWU ID's anonymise frees the email, so no account matches it any more.
 *
 * Finding the account: the Hub keeps no email, so the email is looked up in WAWU ID's user table, read only, through
 * WAWU_ID_DATABASE_URL (a read-only connection string for WAWU ID's database, set for this run only).
 *
 *   cd /srv/wawu/hub-api            (the deploy builds dist/scripts/ops/delete-test-account.js with the rest of the Hub)
 *   set -a; . /etc/wawu/hub-api.env; set +a
 *   WAWU_ID_DATABASE_URL=... node dist/scripts/ops/delete-test-account.js --email <address>
 *   WAWU_ID_DATABASE_URL=... node dist/scripts/ops/delete-test-account.js --email <address> \
 *     --apply --confirm "<phrase>"
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { AccountModule } from '../../src/account/account.module';
import { AccountDeletionIdentityService } from '../../src/account/account-deletion-identity.service';
import {
  AccountDeletionMoneyService,
  type DeletionBlocker,
} from '../../src/account/account-deletion-money.service';
import { AccountDeletionSweepService } from '../../src/account/account-deletion-sweep.service';
import { rowsToDelete } from '../../src/account-purge/account-data-map';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { readFintavaSettings } from '../../src/fintava/fintava-config';
import { readNuvionSettings } from '../../src/nuvion/nuvion-config';
import { readWalletProviderName } from '../../src/wallet-provider/wallet-provider-config';

export const LEAVING_REASON = 'ops_delete_test_account';

export interface Deps {
  prisma: PrismaService;
  money: AccountDeletionMoneyService;
  identity: AccountDeletionIdentityService;
  sweep: AccountDeletionSweepService;
  /** WAWU ID user ids whose email equals `email` (any letter case). */
  resolveEmail: (email: string) => Promise<string[]>;
  getEnv: (key: string) => string | undefined;
  out: (line: string) => void;
}

export interface Options {
  email: string;
  apply: boolean;
  confirm?: string;
  allowTestHolds: boolean;
}

export type Proof =
  | { ok: true; provider: string; environment: string; proof: string }
  | { ok: false; provider: string; why: string };

/** Proves the server's wallet provider is on sandbox, from the provider's own settings reader. Prints no secret. */
export function proveTestProvider(
  get: (key: string) => string | undefined,
): Proof {
  let provider: string;
  try {
    provider = readWalletProviderName(get('WALLET_PROVIDER'));
  } catch (e) {
    return { ok: false, provider: '?', why: (e as Error).message };
  }
  try {
    if (provider === 'nuvion') {
      const { settings } = readNuvionSettings(get);
      return settings.environment === 'sandbox'
        ? {
            ok: true,
            provider,
            environment: 'sandbox',
            proof:
              "NUVION_BASE_URL is Nuvion's sandbox host (read by readNuvionSettings in src/nuvion/nuvion-config.ts; the address and the key are not printed)",
          }
        : {
            ok: false,
            provider,
            why: `Nuvion runs in ${settings.environment}, not sandbox`,
          };
    }
    const settings = readFintavaSettings(get);
    return settings.environment === 'sandbox'
      ? {
          ok: true,
          provider,
          environment: 'sandbox',
          proof:
            "FINTAVA_BASE_URL is Fintava's sandbox host (read by readFintavaSettings in src/fintava/fintava-config.ts; the address and the key are not printed)",
        }
      : {
          ok: false,
          provider,
          why: `Fintava runs in ${settings.environment}, not sandbox`,
        };
  } catch (e) {
    return {
      ok: false,
      provider,
      why: `settings unreadable: ${(e as Error).message}`,
    };
  }
}

const delegateOf = (prisma: PrismaService, model: string) =>
  (
    prisma as unknown as Record<
      string,
      { count: (a: unknown) => Promise<number> }
    >
  )[model.charAt(0).toLowerCase() + model.slice(1)];

async function countRows(prisma: PrismaService, id: string) {
  const perTable: Record<string, number> = {};
  for (const rule of rowsToDelete()) {
    const n = await delegateOf(prisma, rule.model).count({
      where: { [rule.column]: id },
    });
    if (n > 0) perTable[`${rule.model}.${rule.column}`] = n;
  }
  const sum = (pred: (k: string) => boolean) =>
    Object.entries(perTable)
      .filter(([k]) => pred(k))
      .reduce((a, [, n]) => a + n, 0);
  const keptForBuyers = await prisma.contentPiece.count({
    where: { creatorWawuId: id, purchases: { some: {} } },
  });
  return {
    perTable,
    pieces: perTable['ContentPiece.creatorWawuId'] ?? 0,
    keptForBuyers,
    purchasesByOthers: await prisma.purchase.count({
      where: { creatorWawuId: id, buyerWawuId: { not: id } },
    }),
    messages: sum((k) => /Message/.test(k)),
    files: perTable['StorageObject.wawuUserId'] ?? 0,
  };
}

/** Runs the script. Returns the exit code: 0 done or nothing to do, 1 refused, 2 failed. */
export async function deleteTestAccount(
  deps: Deps,
  opts: Options,
): Promise<number> {
  const { out, prisma } = deps;
  const refuse = (why: string) => {
    out(`REFUSED: ${why}`);
    out('Nothing was changed.');
    return 1;
  };

  // 1. Where the money is: sandbox only, proven before anything else is read.
  const proof = proveTestProvider(deps.getEnv);
  if (!proof.ok) {
    return refuse(
      `the wallet provider is not proven to be on test credentials (${proof.why}).`,
    );
  }

  // 2. Exactly one account.
  const ids = [...new Set(await deps.resolveEmail(opts.email))];
  if (ids.length === 0) {
    out(
      'Nothing to do: no account has this email (already deleted, or never existed).',
    );
    return 0;
  }
  if (ids.length > 1) {
    return refuse(
      `${ids.length} accounts match this email; exactly one is needed.`,
    );
  }
  const id = ids[0];

  // 3. Not an admin login.
  const admin = await prisma.adminUser.findFirst({
    where: { email: { equals: opts.email.trim(), mode: 'insensitive' } },
    select: { id: true },
  });
  if (admin) return refuse('this email is an admin login.');

  // 4. Money, as the app sees it.
  const existing = await prisma.accountDeletion.findUnique({
    where: { wawuUserId: id },
  });
  let check;
  try {
    check = await deps.money.check(id);
  } catch (e) {
    return refuse(
      `the wallet provider could not be read (${(e as Error).message}).`,
    );
  }
  const other = check.blockers.filter(
    (b: DeletionBlocker) => b !== 'wallet_balance',
  );
  const profile = await prisma.userProfile.findUnique({
    where: { wawuUserId: id },
    select: { handle: true, accountType: true },
  });
  // The first 8 characters of the WAWU ID user id: the same before and after a half-finished run (a handle is gone by then).
  const phrase = `DELETE ${id.slice(0, 8)}`;
  const counts = await countRows(prisma, id);

  out(opts.apply ? 'APPLY' : 'DRY RUN (nothing is written)');
  out(`WAWU ID user: ${id}`);
  out(`Hub profile: ${profile ? `yes (${profile.accountType})` : 'none'}`);
  out(`Deletion row: ${existing ? existing.status : 'none'}`);
  out(`Provider: ${proof.provider}, ${proof.environment}`);
  out(`Proof: ${proof.proof}`);
  out(
    `Wallet: ${check.wallet ? `${check.wallet.provider}, balance ${check.balanceKobo} kobo (test money)` : 'none'}`,
  );
  out(
    `Blockers: ${check.blockers.length ? check.blockers.join(', ') : 'none'}`,
  );
  for (const b of check.blockers) {
    out(
      `  ${b}: ${b === 'wallet_balance' ? 'waived (test balance)' : opts.allowTestHolds ? 'waived (--allow-test-holds)' : 'REFUSES'}`,
    );
  }
  out(
    `Would remove: ${counts.pieces} pieces, ${counts.messages} messages, ${counts.files} files`,
  );
  out(
    `Kept for buyers (R-130): ${counts.keptForBuyers} pieces others bought, ${counts.purchasesByOthers} purchases by others stay`,
  );
  for (const [k, n] of Object.entries(counts.perTable)) out(`  ${k}: ${n}`);
  out(`Confirmation phrase: ${phrase}`);

  if (other.length > 0 && !opts.allowTestHolds) {
    return refuse(
      `blockers besides the test balance (${other.join(', ')}). Pass --allow-test-holds to waive them.`,
    );
  }
  if (!opts.apply) {
    out('Dry run only. To delete: add --apply --confirm "<the phrase above>".');
    return 0;
  }
  if (opts.confirm === undefined) {
    return refuse('--apply needs --confirm with the exact phrase above.');
  }
  if (opts.confirm !== phrase) {
    return refuse('the confirmation phrase is not the one printed above.');
  }
  if (existing?.status === 'purged') {
    out('Nothing to do: this account was already deleted.');
    return 0;
  }

  // Apply. The deletion row, with no grace: purging at once.
  const now = new Date();
  const fields = {
    status: 'purging',
    // The table requires purgeAfter after scheduledAt; no wait, so one second apart.
    scheduledAt: new Date(now.getTime() - 1000),
    purgeAfter: now,
    leavingReason: LEAVING_REASON,
    walletId: check.wallet?.walletId ?? null,
    walletProvider: check.wallet?.provider ?? null,
    cancelledAt: null,
    purgeBlockedAt: null,
    purgeBlockedBy: null,
  };
  if (existing) {
    await prisma.accountDeletion.update({
      where: { wawuUserId: id },
      data: fields,
    });
  } else {
    await prisma.accountDeletion.create({
      data: { wawuUserId: id, ...fields },
    });
  }
  const row = await prisma.accountDeletion.findUniqueOrThrow({
    where: { wawuUserId: id },
  });
  if (row.identityMarkedAt === null) {
    if (!(await deps.identity.tell(id, row.purgeAfter))) {
      out(
        'WAWU ID did not confirm the start. Nothing was purged. Run the same command again.',
      );
      return 2;
    }
  }
  const outcome = await deps.sweep.purgeNow(id);
  const after = await prisma.accountDeletion.findUnique({
    where: { wawuUserId: id },
  });
  out(`Outcome: ${outcome}`);
  out(`Deletion row now: ${after?.status} ${after?.purgeNote ?? ''}`.trim());
  out(
    `Audit: AccountDeletion row ${id}, reason ${LEAVING_REASON}, at ${new Date().toISOString()}`,
  );
  if (outcome !== 'purged') {
    out('Not finished. It is safe to run the same command again.');
    return 2;
  }
  out(
    'Done. The WAWU ID account is anonymised, so its email can be used to sign up again.',
  );
  return 0;
}

export function parseArgs(argv: string[]): Options | string {
  const val = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const email = val('email');
  if (!email || email.startsWith('--'))
    return 'usage: --email <address> [--apply --confirm "<phrase>"] [--allow-test-holds]';
  return {
    email,
    apply: argv.includes('--apply'),
    confirm: val('confirm'),
    allowTestHolds: argv.includes('--allow-test-holds'),
  };
}

export async function resolveEmailInWawuId(
  url: string,
  email: string,
): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const r = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM wawu_users WHERE lower(email) = lower($1)',
      [email.trim()],
    );
    return r.rows.map((x) => x.id);
  } finally {
    await client.end();
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AccountModule,
  ],
})
class OpsModule {}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    console.error(opts);
    return 1;
  }
  const idUrl = process.env.WAWU_ID_DATABASE_URL;
  if (!idUrl) {
    console.error(
      'REFUSED: WAWU_ID_DATABASE_URL is not set (read-only, WAWU ID database).',
    );
    return 1;
  }
  // The proof comes before anything connects.
  const early = proveTestProvider((k) => process.env[k]);
  if (!early.ok) {
    console.log(
      `REFUSED: the wallet provider is not proven to be on test credentials (${early.why}).`,
    );
    console.log('Nothing was changed.');
    return 1;
  }
  const app = await NestFactory.createApplicationContext(OpsModule, {
    logger: ['error', 'warn'],
  });
  try {
    const get = <T>(t: new (...a: never[]) => T) =>
      app.get(t, { strict: false });
    return await deleteTestAccount(
      {
        prisma: get(PrismaService),
        money: get(AccountDeletionMoneyService),
        identity: get(AccountDeletionIdentityService),
        sweep: get(AccountDeletionSweepService),
        resolveEmail: (e) => resolveEmailInWawuId(idUrl, e),
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

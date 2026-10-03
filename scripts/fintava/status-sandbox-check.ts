/**
 * MONEY-08: the pending sweep against Fintava's SANDBOX, read only.
 *
 *   createdb m08_live_test && DATABASE_URL=... npx prisma migrate deploy
 *   npx tsc scripts/fintava/status-sandbox-check.ts --outDir dist-seed \
 *     --module nodenext --moduleResolution nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --experimentalDecorators --emitDecoratorMetadata
 *   DATABASE_URL=postgresql://...m08_live_test... \
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     node dist-seed/scripts/fintava/status-sandbox-check.js
 *
 * Every request goes through a fetch guard that refuses any host but
 * https://dev.fintavapay.com and any method but GET: this run moves no money
 * and creates nothing at Fintava. It refuses a database whose name has no
 * `test`. The key is read from the environment and never printed.
 *
 * It writes pending ledger rows the way a sending feature would after
 * losing an answer, for movements MONEY-10 really made in the sandbox
 * (`docs/fintava/sandbox/30-money10-ledger.md`), plus one reference that
 * never existed, withholds every webhook (there is no tunnel, R-25, and
 * none is posted), and runs the real sweep (LedgerStatusService) once.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FintavaClient } from '../../src/fintava/fintava-client';
import { FINTAVA_SANDBOX_BASE_URL } from '../../src/fintava/fintava-config';
import { LedgerStatusService } from '../../src/money/ledger/ledger-status.service';
import { LedgerModule } from '../../src/money/ledger/ledger.module';
import { LedgerService } from '../../src/money/ledger/ledger.service';
import type { LedgerWallet } from '../../src/money/ledger/ledger.interface';

/** OPS-02's customer A, as MONEY-10's sandbox check used it. */
const A = {
  customerId: '4e8409cf-1234-40f7-963a-5c212c7a9836',
  walletId: '3b84eae9-f1d5-4c7f-b5b7-7dfc52185cf7',
  accountNumber: '1154079370',
};
/** MONEY-10's four ₦10 sends, 2 Oct 2026 20:17:56 UTC. */
const SENT = 'MONEY10-SBX-20261002201756';
const SENT_AT = new Date('2026-10-02T20:17:56Z');

const log: string[] = [];
const say = (line: string) => {
  log.push(line);
  console.log(line);
};

const realFetch = globalThis.fetch;
const calls: Array<{ method: string; path: string; status: number | null }> =
  [];
globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url.origin !== 'https://dev.fintavapay.com') {
    throw new Error(`refused: only the Fintava sandbox (${url.origin})`);
  }
  if (method !== 'GET')
    throw new Error(`refused: ${method} in a read-only run`);
  const res = await realFetch(input, init);
  calls.push({
    method,
    path: url.pathname.replace('/api/dev', '') + url.search,
    status: res.status,
  });
  return res;
};

class Quiet implements LoggerService {
  log() {}
  error(...a: unknown[]) {
    log.push(`app error: ${a.map(String).join(' ')}`);
  }
  warn(...a: unknown[]) {
    log.push(`app warn: ${a.map(String).join(' ')}`);
  }
}

async function main() {
  const key = (process.env.FINTAVA_API_KEY ?? '').trim();
  const db = process.env.DATABASE_URL ?? '';
  if (!key) throw new Error('FINTAVA_API_KEY is not set');
  if (
    !/\/[^/?]*test[^/?]*(\?|$)/.test(db) ||
    !/@(localhost|127\.0\.0\.1)[:/]/.test(db)
  ) {
    throw new Error(
      'DATABASE_URL must be a local database whose name contains "test"',
    );
  }
  process.env.FINTAVA_BASE_URL = FINTAVA_SANDBOX_BASE_URL;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      LedgerModule,
    ],
  }).compile();
  moduleRef.useLogger(new Quiet());
  await moduleRef.init();
  const prisma = moduleRef.get(PrismaService);
  const ledger = moduleRef.get(LedgerService);
  const status = moduleRef.get(LedgerStatusService);
  const fintava = moduleRef.get(FintavaClient);
  say(`environment: ${fintava.environment}`);
  if (fintava.environment !== 'sandbox') throw new Error('not the sandbox');

  const merchant = await fintava.getMerchantBalance();
  const wawu: LedgerWallet = {
    kind: 'merchant',
    accountNumber: merchant.accountNumber,
  };
  const wawuUserId = randomUUID();
  await prisma.fintavaWallet.create({ data: { wawuUserId, ...A } });
  const a: LedgerWallet = {
    kind: 'user',
    wawuUserId,
    accountNumber: A.accountNumber,
  };

  const absent = `MONEY08-SBX-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-ABSENT`;
  const cases: Array<{
    name: string;
    wallet: LedgerWallet;
    ours: string;
    amountKobo: number;
    ageMin: number;
    sentAt: Date | null;
    expect: string;
  }> = [
    {
      name: `1 WAWU to A, ${SENT}-1`,
      wallet: wawu,
      ours: `${SENT}-1`,
      amountKobo: 1000,
      ageMin: 3,
      sentAt: SENT_AT,
      expect: 'settled completed',
    },
    {
      name: `2 A to WAWU, ${SENT}-2`,
      wallet: a,
      ours: `${SENT}-2`,
      amountKobo: 1000,
      ageMin: 3,
      sentAt: SENT_AT,
      expect: 'settled completed',
    },
    {
      name: `3 a reference that never existed, ${absent}`,
      wallet: wawu,
      ours: absent,
      amountKobo: 1000,
      ageMin: 11,
      sentAt: null,
      expect: 'failed_absent failed',
    },
    {
      name: `4 WAWU to B, ${SENT}-3, recorded as ₦20`,
      wallet: wawu,
      ours: `${SENT}-3`,
      amountKobo: 2000,
      ageMin: 3,
      sentAt: SENT_AT,
      expect: 'disagrees pending',
    },
  ];
  const ids: string[] = [];
  for (const c of cases) {
    const r = await ledger.record({
      wallet: c.wallet,
      direction: 'out',
      status: 'pending',
      category: 'transfer',
      amountKobo: c.amountKobo,
      references: { customerReference: c.ours },
      source: 'send',
    });
    const at = new Date(Date.now() - c.ageMin * 60_000);
    await prisma.$executeRaw`
      UPDATE "FintavaLedgerEntry"
         SET "createdAt" = ${at}, "updatedAt" = ${at},
             "occurredAt" = ${c.sentAt ?? at}
       WHERE "id" = ${r.entryId}`;
    ids.push(r.entryId);
  }

  // Only this run's rows are in this database (a fresh `test` database).
  let counts = await status.sweep();
  say(`sweep 1: ${JSON.stringify(counts)}`);
  const waiting = await prisma.fintavaLedgerEntry.count({
    where: { id: { in: ids }, status: 'pending', discrepancy: null },
  });
  if (waiting > 0) {
    // A lookup can answer `{}` (sandbox/26-): one more sweep after the rest.
    counts = await status.sweep(new Date(Date.now() + 61_000));
    say(
      `sweep 2 (after a {} answer's 1-minute rest): ${JSON.stringify(counts)}`,
    );
  }

  let ok = true;
  for (const [i, c] of cases.entries()) {
    const r = await prisma.fintavaLedgerEntry.findUniqueOrThrow({
      where: { id: ids[i] },
    });
    const outcome =
      r.status === 'completed'
        ? 'settled completed'
        : r.status === 'failed'
          ? 'failed_absent failed'
          : r.discrepancy
            ? 'disagrees pending'
            : `waiting ${r.status}`;
    const pass = outcome === c.expect;
    ok &&= pass;
    say(
      `${pass ? 'ok  ' : 'FAIL'} ${c.name}: ${r.status}; fintavaReference ${r.fintavaReference ?? '-'}; transaction ${r.fintavaTransactionId ?? '-'}; failureReason ${r.failureReason ?? '-'}; discrepancy ${r.discrepancy ?? '-'}`,
    );
  }

  await prisma.fintavaLedgerEntry.deleteMany({ where: { id: { in: ids } } });
  await prisma.fintavaWallet.deleteMany({ where: { wawuUserId } });
  await moduleRef.close();

  say(`sandbox calls: ${calls.length}, every one a GET`);
  for (const c of calls) say(`  ${c.method} ${c.path} -> ${c.status}`);
  for (const line of log.filter((l) => l.startsWith('app '))) say(line);
  say(`RESULT ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

void main().catch((e: unknown) => {
  console.error(`stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});

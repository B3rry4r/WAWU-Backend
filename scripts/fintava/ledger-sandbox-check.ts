/**
 * MONEY-10: the ledger, end to end against Fintava's SANDBOX.
 *
 *   createdb m10_live_test && DATABASE_URL=... npx prisma migrate deploy
 *   npx tsc scripts/fintava/ledger-sandbox-check.ts --outDir dist-seed \
 *     --module nodenext --moduleResolution nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --experimentalDecorators --emitDecoratorMetadata
 *   DATABASE_URL=postgresql://...m10_live_test... LEDGER_CHECK_PORT=4762 \
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     node dist-seed/scripts/fintava/ledger-sandbox-check.js
 *
 * Only https://dev.fintavapay.com and this machine are called: every
 * request goes through a fetch guard that refuses anything else, and the
 * script refuses a database whose name has no `test`. It uses OPS-02's two
 * test customers (A and B), creates none, and runs no charged call. Money
 * moves are exactly two ₦10 round trips (WAWU to A and back, WAWU to B and
 * back), so the balances end where they started.
 *
 * Fintava cannot reach this machine (no tunnel, R-25), so each movement's
 * webhook is built in Fintava's documented `wallet_to_wallet_transfer_v2`
 * format from the real transfer's answer, signed with a local secret and
 * posted to the real route, MONEY-07's `POST /api/hub/webhooks/fintava`.
 * Whether a real delivery carries the same fields is G-19's question; the
 * script sends both readings.
 *
 * The key is read from the environment and never printed.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ValidationPipe, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FintavaClient } from '../../src/fintava/fintava-client';
import { koboToFintavaAmount } from '../../src/fintava/fintava-amount';
import { FINTAVA_SANDBOX_BASE_URL } from '../../src/fintava/fintava-config';
import type { FintavaTransferReceipt } from '../../src/fintava/fintava.interface';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../src/fintava/webhook/fintava-signature';
import { FintavaWebhookModule } from '../../src/fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { LedgerConsumerService } from '../../src/money/ledger/ledger-consumer.service';
import { LedgerModule } from '../../src/money/ledger/ledger.module';
import { LedgerService } from '../../src/money/ledger/ledger.service';
import type { LedgerWallet } from '../../src/money/ledger/ledger.interface';

const A = {
  name: 'A (Ada Sandbox)',
  customerId: '4e8409cf-1234-40f7-963a-5c212c7a9836',
  walletId: '3b84eae9-f1d5-4c7f-b5b7-7dfc52185cf7',
  accountNumber: '1154079370',
};
const B = {
  name: 'B (Bayo Sandbox)',
  customerId: '3c672d13-cc4f-4200-bf13-038f21aab06a',
  walletId: 'bd656a80-6984-4832-9a06-a858f249aec6',
  accountNumber: '1151496137',
};
const TEN_NAIRA = 1000;
const MAX_SENDS = 4;
const SECRET = `whsec_local_m10_${randomUUID()}`;
const PORT = Number(process.env.LEDGER_CHECK_PORT ?? '4762');

const log: string[] = [];
const say = (line: string) => {
  log.push(line);
  console.log(line);
};

// --- Every request goes through here: the sandbox and this machine only. ---
const realFetch = globalThis.fetch;
const calls: Array<{ method: string; path: string; status: number | null }> =
  [];
let sends = 0;
globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const local = url.hostname === '127.0.0.1' && url.port === String(PORT);
  if (!local && url.origin !== 'https://dev.fintavapay.com') {
    throw new Error(
      `refused: only the Fintava sandbox may be called (${url.origin})`,
    );
  }
  if (!local && method === 'POST') {
    if (url.pathname !== '/api/dev/transaction/wallet-to-wallet') {
      throw new Error(`refused: ${url.pathname} is not allowed in this run`);
    }
    if (sends >= MAX_SENDS)
      throw new Error('refused: no more than four ₦10 sends');
    sends += 1;
  }
  const res = await realFetch(input, init);
  if (!local) {
    calls.push({
      method,
      path: url.pathname.replace('/api/dev', ''),
      status: res.status,
    });
  }
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

function w2wDelivery(
  r: FintavaTransferReceipt,
  from: string,
  to: string,
  shape: 'response' | 'documented',
): string {
  // `response`: the field names the transfer response uses (its `reference`
  // is the tagapay one, its `customerReference` Fintava's). `documented`:
  // only `reference`, as the events page prints it.
  const data: Record<string, unknown> = {
    amount: koboToFintavaAmount(r.amountKobo),
    reference: r.tagapayTransRef,
    ...(shape === 'response' ? { customerReference: r.fintavaReference } : {}),
    total: koboToFintavaAmount(r.totalKobo),
    transaction_fee: r.feeKobo === 0 ? 0 : koboToFintavaAmount(r.feeKobo),
    source_customer_accno: from,
    source_customer_wallet: from,
    target_customer_accno: to,
    target_customer_wallet: to,
    description: 'Fund transfer between customers',
  };
  return JSON.stringify(
    { event: 'wallet_to_wallet_transfer_v2', data },
    null,
    2,
  );
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
  process.env.FINTAVA_WEBHOOK_SECRET = SECRET;
  process.env.FINTAVA_MONEY_TIMEOUT_MS = '15000';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      FintavaWebhookModule,
      LedgerModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({
    ...HUB_APP_OPTIONS,
    logger: new Quiet(),
  });
  app.setGlobalPrefix('api/hub');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.listen(PORT, '127.0.0.1');
  const prisma = moduleRef.get(PrismaService);
  const ledger = moduleRef.get(LedgerService);
  const consumer = moduleRef.get(LedgerConsumerService);
  const fintava = moduleRef.get(FintavaClient);

  const deliver = async (text: string) => {
    const res = await fetch(
      `http://127.0.0.1:${PORT}/api/hub/webhooks/fintava`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [FINTAVA_SIGNATURE_HEADER]: signFintavaBody(
            SECRET,
            Buffer.from(text),
          ),
        },
        body: text,
      },
    );
    const body = (await res.json()) as { data?: { outcome?: string } };
    return `${res.status} ${body.data?.outcome ?? '?'}`;
  };

  // Two people whose wallets are A and B, as MONEY-12 will store them. With
  // LEDGER_CHECK_RESUME=<stamp> nothing is sent: an earlier run's rows and
  // waiting deliveries are swept again and checked.
  const resume = (process.env.LEDGER_CHECK_RESUME ?? '').trim();
  const people: Record<'A' | 'B', string> = {
    A: randomUUID(),
    B: randomUUID(),
  };
  for (const [k, c] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const had = await prisma.fintavaWallet.findUnique({
      where: { accountNumber: c.accountNumber },
    });
    if (had && resume) {
      people[k] = had.wawuUserId;
      continue;
    }
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: people[k],
        customerId: c.customerId,
        walletId: c.walletId,
        accountNumber: c.accountNumber,
      },
    });
  }
  const merchant = await fintava.getMerchantBalance();
  const startA = await fintava.getWalletBalance(A.walletId);
  const startB = await fintava.getWalletBalance(B.walletId);
  say(
    `start: WAWU ${merchant.availableKobo} kobo (account ${merchant.accountNumber}), A ${startA.availableKobo}, B ${startB.availableKobo}`,
  );
  const W: LedgerWallet = {
    kind: 'merchant',
    accountNumber: merchant.accountNumber,
  };
  const wallet = (k: 'A' | 'B', acct: string): LedgerWallet => ({
    kind: 'user',
    wawuUserId: people[k],
    accountNumber: acct,
  });

  const stamp =
    resume || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const movements: Array<{
    label: string;
    ours: string;
    from: LedgerWallet;
    to: LedgerWallet;
  }> = [];

  /** The sending feature's own record, from the MONEY-06 receipt. */
  const recordReceipt = (from: LedgerWallet, r: FintavaTransferReceipt) =>
    ledger.record({
      wallet: from,
      direction: 'out',
      status: 'completed',
      category: 'transfer',
      amountKobo: r.amountKobo,
      feeKobo: r.feeKobo,
      totalKobo: r.totalKobo,
      references: {
        customerReference: r.customerReference,
        fintavaReference: r.fintavaReference,
        tagapayTransRef: r.tagapayTransRef,
        fintavaTransactionId: r.transactionId,
      },
      source: 'send',
    });

  const send = async (
    label: string,
    from: LedgerWallet,
    fromAcct: string,
    to: LedgerWallet,
    toAcct: string,
    n: number,
  ) => {
    const ours = `MONEY10-SBX-${stamp}-${n}`;
    movements.push({ label, ours, from, to });
    const r = await fintava.walletToWallet({
      senderAccountNumber: fromAcct,
      receiverAccountNumber: toAcct,
      amountKobo: TEN_NAIRA,
      customerReference: ours,
      narration: `MONEY-10 ledger check ${n}`,
    });
    say(
      `${label}: sent ${ours}: amount ${r.amountKobo} kobo, fee ${r.feeKobo}, total ${r.totalKobo}`,
    );
    return r;
  };

  if (resume) {
    const mA = wallet('A', A.accountNumber);
    const mB = wallet('B', B.accountNumber);
    movements.push(
      {
        label: '1. WAWU to A',
        ours: `MONEY10-SBX-${stamp}-1`,
        from: W,
        to: mA,
      },
      {
        label: '2. A to WAWU',
        ours: `MONEY10-SBX-${stamp}-2`,
        from: mA,
        to: W,
      },
      {
        label: '3. WAWU to B',
        ours: `MONEY10-SBX-${stamp}-3`,
        from: W,
        to: mB,
      },
      {
        label: '4. B to WAWU',
        ours: `MONEY10-SBX-${stamp}-4`,
        from: mB,
        to: W,
      },
    );
    say(`resume ${stamp}: no sends; sweeping the waiting deliveries again`);
  } else {
    // 1. WAWU to A. The feature records its receipt, reconciles it by lookup,
    //    then the webhook (response field names) arrives twice.
    const r1 = await send(
      '1. WAWU to A',
      W,
      merchant.accountNumber,
      wallet('A', A.accountNumber),
      A.accountNumber,
      1,
    );
    const own1 = await recordReceipt(W, r1);
    say(`   own record: ${own1.created ? 'written' : 'merged'}`);
    say(
      `   reconcile by lookup/history: ${JSON.stringify(await consumer.reconcileEntry(own1.entryId))}`,
    );
    const d1 = w2wDelivery(
      r1,
      merchant.accountNumber,
      A.accountNumber,
      'response',
    );
    say(
      `   webhook (response names): ${await deliver(d1)}; again: ${await deliver(d1)}`,
    );
    say(`   sweep: ${JSON.stringify(await consumer.sweep())}`);

    // 2. A to WAWU: the answer is treated as lost. The feature holds only our
    //    reference (pending); reconcile asks Fintava; the documented webhook
    //    (only `reference`) arrives.
    const lost = await ledger.record({
      wallet: wallet('A', A.accountNumber),
      direction: 'out',
      status: 'pending',
      category: 'transfer',
      amountKobo: TEN_NAIRA,
      references: { customerReference: `MONEY10-SBX-${stamp}-2` },
      source: 'send',
    });
    const r2 = await send(
      '2. A to WAWU',
      wallet('A', A.accountNumber),
      A.accountNumber,
      W,
      merchant.accountNumber,
      2,
    );
    say(
      `   reconcile of the pending row: ${JSON.stringify(await consumer.reconcileEntry(lost.entryId))}`,
    );
    say(
      `   webhook (documented, reference only): ${await deliver(w2wDelivery(r2, A.accountNumber, merchant.accountNumber, 'documented'))}`,
    );
    say(`   sweep: ${JSON.stringify(await consumer.sweep())}`);

    // 3. WAWU to B: the webhook lands before the feature records anything;
    //    the feature's receipt record comes after and folds in.
    const r3 = await send(
      '3. WAWU to B',
      W,
      merchant.accountNumber,
      wallet('B', B.accountNumber),
      B.accountNumber,
      3,
    );
    say(
      `   webhook first (documented): ${await deliver(w2wDelivery(r3, merchant.accountNumber, B.accountNumber, 'documented'))}`,
    );
    say(`   sweep: ${JSON.stringify(await consumer.sweep())}`);
    const own3 = await recordReceipt(W, r3);
    say(
      `   own record after: ${own3.created ? 'written (a second row!)' : 'merged into the webhook row'}`,
    );

    // 4. B to WAWU: webhook with the response names, confirmed by lookup;
    //    then the receipt record.
    const r4 = await send(
      '4. B to WAWU',
      wallet('B', B.accountNumber),
      B.accountNumber,
      W,
      merchant.accountNumber,
      4,
    );
    say(
      `   webhook (response names): ${await deliver(w2wDelivery(r4, B.accountNumber, merchant.accountNumber, 'response'))}`,
    );
    say(`   sweep: ${JSON.stringify(await consumer.sweep())}`);
    const own4 = await recordReceipt(wallet('B', B.accountNumber), r4);
    say(
      `   own record after: ${own4.created ? 'written (a second row!)' : 'merged'}`,
    );
  }

  // Anything still waiting gets one more pass.
  say(`final sweep: ${JSON.stringify(await consumer.sweep())}`);

  // The ledger, movement by movement.
  let ok = true;
  for (const m of movements) {
    const refs = await prisma.fintavaLedgerReference.findMany({
      where: { value: m.ours },
      select: { entryId: true },
    });
    const ids = [...new Set(refs.map((r) => r.entryId))];
    const head = await prisma.fintavaLedgerEntry.findMany({
      where: { id: { in: ids } },
    });
    const tag =
      head.find((e) => e.direction === 'out')?.tagapayTransRef ?? null;
    const all = await prisma.fintavaLedgerReference.findMany({
      where: { value: { in: [m.ours, ...(tag ? [tag] : [])] } },
      select: { entryId: true },
    });
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { id: { in: [...new Set(all.map((r) => r.entryId))] } },
      orderBy: { direction: 'asc' },
    });
    const outs = rows.filter((r) => r.direction === 'out');
    const ins = rows.filter((r) => r.direction === 'in');
    const good =
      outs.length === 1 &&
      ins.length === 1 &&
      outs[0].accountNumber === m.from.accountNumber &&
      ins[0].accountNumber === m.to.accountNumber &&
      outs[0].amountKobo === 1000n &&
      ins[0].amountKobo === 1000n &&
      outs[0].status === 'completed' &&
      ins[0].status === 'completed' &&
      !outs[0].discrepancy &&
      !ins[0].discrepancy;
    ok = ok && good;
    say(
      `${good ? 'PASS' : 'FAIL'} ${m.label} ${m.ours}: ` +
        rows
          .map(
            (r) =>
              `${r.direction} ${r.direction === 'out' ? '-' : '+'}${r.amountKobo} kobo on ${r.walletKind} ${r.accountNumber} ${r.status}` +
              ` (refs: ours ${r.customerReference ? 'yes' : 'no'}, fintava ${r.fintavaReference ? 'yes' : 'no'}, tagapay ${r.tagapayTransRef ? 'yes' : 'no'}, id ${r.fintavaTransactionId ? 'yes' : 'no'}; source ${r.source})`,
          )
          .join(' | '),
    );
  }
  const events = await prisma.fintavaWebhookEvent.findMany({
    orderBy: { receivedAt: 'asc' },
  });
  for (const e of events)
    say(`event ${e.event} ${e.processingStatus}: ${e.note}`);

  const endA = await fintava.getWalletBalance(A.walletId);
  const endB = await fintava.getWalletBalance(B.walletId);
  const endW = await fintava.getMerchantBalance();
  say(
    `end: WAWU ${endW.availableKobo} kobo, A ${endA.availableKobo}, B ${endB.availableKobo}`,
  );
  const back =
    endA.availableKobo === startA.availableKobo &&
    endB.availableKobo === startB.availableKobo &&
    endW.availableKobo === merchant.availableKobo;
  say(`balances back where they started: ${back ? 'yes' : 'NO'}`);
  say(`sandbox calls: ${calls.length} (${sends} sends)`);
  for (const c of calls)
    say(
      `  ${c.method} ${c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}')} ${c.status}`,
    );
  say(`RESULT ${ok && back ? 'PASS' : 'FAIL'}`);
  await app.close();
  process.exitCode = ok && back ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(`stopped: ${(e as Error).name}: ${(e as Error).message}`);
  process.exitCode = 1;
});

/**
 * MONEY-15: the wallet history, read through the served routes, over rows
 * that real sandbox movements put in the ledger.
 *
 *   createdb m15_live_test && DATABASE_URL=... npx prisma migrate deploy
 *   MOCK_WAWU_ID_PORT=4932 node mock-wawu-id/server.js &
 *   npx tsc scripts/fintava/history-sandbox-check.ts --outDir dist-seed \
 *     --module nodenext --moduleResolution nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --experimentalDecorators --emitDecoratorMetadata
 *   DATABASE_URL=postgresql://...m15_live_test... HISTORY_CHECK_PORT=4931 \
 *   WAWU_ID_PORT=4932 \
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     node dist-seed/scripts/fintava/history-sandbox-check.js
 *
 * Only https://dev.fintavapay.com and this machine are called: every fetch
 * goes through a guard that refuses anything else, every POST to Fintava
 * but `/transaction/wallet-to-wallet`, and a third send. The database name
 * must contain `test`. It uses OPS-02's two test customers (A and B),
 * creates none and runs no charged call: one ₦10 round trip, A to B and
 * back, so both balances end where they started.
 *
 * The two people sign in at the stand-in WAWU ID (`POST /auth/register` on
 * WAWU_ID_PORT); the history is read with those tokens over HTTP from the
 * served routes, the way the app reads it.
 *
 * Each send is recorded the way the sending feature (WALLET-07) will: its
 * receipt, with the recipient's name from Fintava's free wallet name
 * enquiry. Fintava cannot reach this machine (no tunnel, R-25), so each
 * movement's `wallet_to_wallet_transfer_v2` delivery is built in Fintava's
 * documented format from the real answer, signed with a local secret,
 * posted to MONEY-07's route and swept into the ledger by MONEY-10's
 * consumer, which writes the receiver's side.
 *
 * The key is read from the environment and never printed.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ValidationPipe, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { koboToFintavaAmount } from '../../src/fintava/fintava-amount';
import { FintavaClient } from '../../src/fintava/fintava-client';
import { FINTAVA_SANDBOX_BASE_URL } from '../../src/fintava/fintava-config';
import type { FintavaTransferReceipt } from '../../src/fintava/fintava.interface';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../src/fintava/webhook/fintava-signature';
import { FintavaWebhookModule } from '../../src/fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { LedgerConsumerService } from '../../src/money/ledger/ledger-consumer.service';
import { LedgerService } from '../../src/money/ledger/ledger.service';
import { MoneyModule } from '../../src/money/money.module';
import type {
  MonthlySummaryView,
  TransactionPage,
  TransactionView,
} from '../../src/money/money-view.type';

const A = {
  customerId: '4e8409cf-1234-40f7-963a-5c212c7a9836',
  walletId: '3b84eae9-f1d5-4c7f-b5b7-7dfc52185cf7',
  accountNumber: '1154079370',
};
const B = {
  customerId: '3c672d13-cc4f-4200-bf13-038f21aab06a',
  walletId: 'bd656a80-6984-4832-9a06-a858f249aec6',
  accountNumber: '1151496137',
};
const TEN_NAIRA = 1000;
const MAX_SENDS = 2;
const SECRET = `whsec_local_m15_${randomUUID()}`;
const PORT = Number(process.env.HISTORY_CHECK_PORT ?? '4931');
const ID_PORT = Number(process.env.WAWU_ID_PORT ?? '4932');

const say = (line: string) => console.log(line);

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
  const local =
    url.hostname === '127.0.0.1' &&
    (url.port === String(PORT) || url.port === String(ID_PORT));
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
      throw new Error('refused: no more than two ₦10 sends');
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
    console.log(`app error: ${a.map(String).join(' ')}`);
  }
  warn(...a: unknown[]) {
    console.log(`app warn: ${a.map(String).join(' ')}`);
  }
}

/** Fintava's documented `wallet_to_wallet_transfer_v2`, from the real answer. */
function w2wDelivery(r: FintavaTransferReceipt, from: string, to: string) {
  return JSON.stringify({
    event: 'wallet_to_wallet_transfer_v2',
    data: {
      amount: koboToFintavaAmount(r.amountKobo),
      reference: r.tagapayTransRef,
      total: koboToFintavaAmount(r.totalKobo),
      transaction_fee: r.feeKobo === 0 ? 0 : koboToFintavaAmount(r.feeKobo),
      source_customer_accno: from,
      source_customer_wallet: from,
      target_customer_accno: to,
      target_customer_wallet: to,
      description: 'Fund transfer between customers',
    },
  });
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
  process.env.WAWU_ID_JWKS_URL = `http://127.0.0.1:${ID_PORT}/.well-known/jwks.json`;
  process.env.WAWU_ID_BASE_URL = `http://127.0.0.1:${ID_PORT}`;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      FintavaWebhookModule,
      MoneyModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
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
  let ok = true;
  const check = (what: string, pass: boolean) => {
    ok &&= pass;
    say(`${pass ? 'PASS' : 'FAIL'} ${what}`);
  };

  try {
    // Sign up at the stand-in WAWU ID: the token is what the app holds.
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const signUp = async (who: string) => {
      const res = await fetch(`http://127.0.0.1:${ID_PORT}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: `History ${who}`,
          email: `m15-${who}-${stamp}@test.wawu.dev`,
          phone: `+23480${stamp.slice(-7)}${who === 'A' ? 1 : 2}`,
          country: 'Nigeria',
          password: 'stand-in',
        }),
      });
      const body = (await res.json()) as {
        accessToken: string;
        user: { id?: string; sub?: string };
      };
      const [, payload] = body.accessToken.split('.');
      const sub = (
        JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
          sub: string;
        }
      ).sub;
      return { sub, auth: `Bearer ${body.accessToken}` };
    };
    const a = await signUp('A');
    const b = await signUp('B');

    const nameA =
      (await fintava.walletNameEnquiry(A.accountNumber))?.accountName ?? null;
    const nameB =
      (await fintava.walletNameEnquiry(B.accountNumber))?.accountName ?? null;
    say(`names: A ${nameA}, B ${nameB}`);
    if (!nameA || !nameB)
      throw new Error('a test customer has no name at Fintava');
    for (const [p, c, n] of [
      [a, A, nameA],
      [b, B, nameB],
    ] as const) {
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: p.sub,
          customerId: c.customerId,
          walletId: c.walletId,
          accountNumber: c.accountNumber,
          accountName: n,
        },
      });
    }
    const startA = await fintava.getWalletBalance(A.walletId);
    const startB = await fintava.getWalletBalance(B.walletId);
    say(
      `start: A ${startA.availableKobo} kobo, B ${startB.availableKobo} kobo`,
    );

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

    const send = async (
      n: number,
      from: { sub: string },
      fromAcct: string,
      to: { sub: string },
      toAcct: string,
      toName: string,
      note: string,
    ) => {
      const ours = `MONEY15-SBX-${stamp}-${n}`;
      const r = await fintava.walletToWallet({
        senderAccountNumber: fromAcct,
        receiverAccountNumber: toAcct,
        amountKobo: TEN_NAIRA,
        customerReference: ours,
        narration: `MONEY-15 history check ${n}`,
      });
      say(
        `send ${n}: ${ours}: amount ${r.amountKobo} kobo, fee ${r.feeKobo}, total ${r.totalKobo}`,
      );
      // The sending feature's own record (WALLET-07), from the receipt.
      const own = await ledger.record({
        wallet: { kind: 'user', wawuUserId: from.sub, accountNumber: fromAcct },
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: r.amountKobo,
        feeKobo: r.feeKobo,
        totalKobo: r.totalKobo,
        counterparty: {
          kind: 'wawu_user',
          name: toName,
          wawuUserId: to.sub,
          accountNumber: toAcct,
        },
        note,
        references: {
          customerReference: r.customerReference,
          fintavaReference: r.fintavaReference,
          tagapayTransRef: r.tagapayTransRef,
          fintavaTransactionId: r.transactionId,
        },
        source: 'send',
      });
      say(`   own record: ${own.created ? 'written' : 'merged'}`);
      say(
        `   webhook (documented): ${await deliver(w2wDelivery(r, fromAcct, toAcct))}`,
      );
      say(`   sweep: ${JSON.stringify(await consumer.sweep())}`);
      return { ours, entryId: own.entryId };
    };

    const s1 = await send(
      1,
      a,
      A.accountNumber,
      b,
      B.accountNumber,
      nameB,
      'History check there',
    );
    const s2 = await send(
      2,
      b,
      B.accountNumber,
      a,
      A.accountNumber,
      nameA,
      'History check back',
    );

    const endA = await fintava.getWalletBalance(A.walletId);
    const endB = await fintava.getWalletBalance(B.walletId);
    say(`end: A ${endA.availableKobo} kobo, B ${endB.availableKobo} kobo`);
    check(
      'balances back where they started',
      endA.availableKobo === startA.availableKobo &&
        endB.availableKobo === startB.availableKobo,
    );

    const http = async <T>(auth: string, path: string) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/hub${path}`, {
        headers: { Authorization: auth },
      });
      const body = (await res.json()) as { data: T };
      return { status: res.status, data: body.data };
    };

    // A searches for B by name: both movements with B, nothing else.
    const firstWord = nameB.split(/\s+/)[0];
    const q = await http<TransactionPage>(
      a.auth,
      `/money/transactions?q=${encodeURIComponent(firstWord)}`,
    );
    say(`A: GET /money/transactions?q=${firstWord} -> ${q.status}`);
    for (const i of q.data.items) {
      say(
        `   ${i.direction} ${i.status} ${i.totalKobo} kobo, ${i.description}, counterparty ${i.counterparty?.name}, reference ${i.reference}, note ${i.note}`,
      );
    }
    const ids = q.data.items.map((i) => i.id).sort();
    const aRows = await prisma.fintavaLedgerEntry.findMany({
      where: { wawuUserId: a.sub },
      select: { id: true, direction: true, customerReference: true },
    });
    say(
      `A's ledger rows: ${aRows.length} (${aRows.map((r) => `${r.direction} ${r.customerReference ?? '(no ours)'}`).join(', ')})`,
    );
    check(
      `searching "${firstWord}" finds A's two movements with B`,
      q.status === 200 &&
        ids.length === 2 &&
        JSON.stringify(ids) === JSON.stringify(aRows.map((r) => r.id).sort()),
    );
    check(
      'the send to B shows B by the name recorded',
      q.data.items.some(
        (i) => i.id === s1.entryId && i.counterparty?.name === nameB,
      ),
    );
    const none = await http<TransactionPage>(
      a.auth,
      '/money/transactions?q=nobody-at-all',
    );
    check(
      'a name nobody has finds nothing',
      none.status === 200 && none.data.items.length === 0,
    );

    // The month's figures equal the month's completed rows.
    const month = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const sum = await http<MonthlySummaryView>(
      a.auth,
      `/money/transactions/summary?month=${month}`,
    );
    const list = await http<TransactionPage>(
      a.auth,
      `/money/transactions?month=${month}&limit=100`,
    );
    const done = list.data.items.filter((i) => i.status === 'completed');
    const add = (d: 'in' | 'out') =>
      done
        .filter((i) => i.direction === d)
        .reduce((s, i) => s + i.totalKobo, 0);
    say(
      `A: summary ${month} -> ${sum.status} ${JSON.stringify(sum.data)}; rows ${list.data.items.length}, completed ${done.length}`,
    );
    check(
      'In and Out equal the sums of the month’s completed rows',
      sum.status === 200 &&
        sum.data.inKobo === add('in') &&
        sum.data.outKobo === add('out'),
    );

    // One row as W27 reads it; B cannot read A's.
    const one = await http<TransactionView>(
      a.auth,
      `/money/transactions/${s1.entryId}`,
    );
    say(
      `A: GET /money/transactions/<send 1> -> ${one.status} ${JSON.stringify(one.data)}`,
    );
    check(
      'the receipt carries our reference',
      one.status === 200 && one.data.reference === s1.ours,
    );
    const notB = await fetch(
      `http://127.0.0.1:${PORT}/api/hub/money/transactions/${s1.entryId}`,
      { headers: { Authorization: b.auth } },
    );
    check("B gets 404 for A's row", notB.status === 404);
    const bQ = await http<TransactionPage>(
      b.auth,
      `/money/transactions?q=${encodeURIComponent(nameA.split(/\s+/)[0])}`,
    );
    check(
      `B searching "${nameA.split(/\s+/)[0]}" finds B's two movements with A`,
      bQ.status === 200 && bQ.data.items.length === 2,
    );
    void s2;
  } finally {
    say(`fintava calls: ${calls.length}`);
    for (const c of calls) say(`   ${c.method} ${c.path} ${c.status}`);
    await app.close();
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((e: unknown) => {
  console.log(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});

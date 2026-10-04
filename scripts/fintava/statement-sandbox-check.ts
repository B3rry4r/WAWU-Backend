/**
 * WALLET-27: a statement, read through the served route, over rows that
 * real sandbox movements put in the ledger, checked against Fintava's own
 * record of the same send.
 *
 *   createdb w27_live_test && DATABASE_URL=... npx prisma migrate deploy
 *   MOCK_WAWU_ID_PORT=4992 node mock-wawu-id/server.js &
 *   npx tsc scripts/fintava/statement-sandbox-check.ts --outDir dist-seed \
 *     --module nodenext --moduleResolution nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --experimentalDecorators --emitDecoratorMetadata
 *   DATABASE_URL=postgresql://...w27_live_test... STATEMENT_CHECK_PORT=4991 \
 *   WAWU_ID_PORT=4992 \
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     node dist-seed/scripts/fintava/statement-sandbox-check.js
 *
 * Only https://dev.fintavapay.com and this machine are called: every fetch
 * goes through a guard that refuses anything else, every POST to Fintava
 * but `/transaction/wallet-to-wallet`, and a third send. The database name
 * must contain `test`. It uses OPS-02's two test customers (A and B),
 * creates none and runs no charged call: one ₦10 round trip, A to B and
 * back, so both balances end where they started.
 *
 * The two people sign in at the stand-in WAWU ID (`POST /auth/register` on
 * WAWU_ID_PORT); the statement is read with those tokens over HTTP from
 * the served route, the way the app reads it.
 *
 * Each send is recorded the way the sending feature (WALLET-07) will: its
 * receipt, with the recipient's name from Fintava's free wallet name
 * enquiry. Fintava cannot reach this machine (no tunnel, R-25), so each
 * movement's `wallet_to_wallet_transfer_v2` delivery is built in Fintava's
 * documented format from the real answer, signed with a local secret,
 * posted to MONEY-07's route and swept into the ledger by MONEY-10's
 * consumer, which writes the receiver's side. Then A's own history at
 * Fintava (`GET /txn`, documented, debits only) is read once, and A's
 * send there must carry the statement line's reference and amount.
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
import type { StatementView } from '../../src/money/statements/statement-view.type';
import { lagosToday } from '../../src/money/statements/statement-csv';

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
const SECRET = `whsec_local_w27_${randomUUID()}`;
const PORT = Number(process.env.STATEMENT_CHECK_PORT ?? '4991');
const ID_PORT = Number(process.env.WAWU_ID_PORT ?? '4992');

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
          fullName: `Statement ${who}`,
          email: `w27-${who}-${stamp}@test.wawu.dev`,
          phone: `+23481${stamp.slice(-7)}${who === 'A' ? 1 : 2}`,
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
      const ours = `WALLET27-SBX-${stamp}-${n}`;
      const r = await fintava.walletToWallet({
        senderAccountNumber: fromAcct,
        receiverAccountNumber: toAcct,
        amountKobo: TEN_NAIRA,
        customerReference: ours,
        narration: `WALLET-27 statement check ${n}`,
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
      'Statement check there',
    );
    const s2 = await send(
      2,
      b,
      B.accountNumber,
      a,
      A.accountNumber,
      nameA,
      'Statement check back',
    );

    const endA = await fintava.getWalletBalance(A.walletId);
    const endB = await fintava.getWalletBalance(B.walletId);
    say(`end: A ${endA.availableKobo} kobo, B ${endB.availableKobo} kobo`);
    check(
      'balances back where they started',
      endA.availableKobo === startA.availableKobo &&
        endB.availableKobo === startB.availableKobo,
    );

    const today = lagosToday(new Date());
    const read = async (auth: string, from: string, to: string) => {
      const res = await fetch(
        `http://127.0.0.1:${PORT}/api/hub/money/statements?from=${from}&to=${to}&format=csv`,
        { headers: { Authorization: auth } },
      );
      const body = (await res.json()) as { data: StatementView | null };
      return { status: res.status, data: body.data };
    };
    /** The CSV's lines after the header, split on commas (these cells hold none). */
    const linesOf = (v: StatementView) =>
      v.content
        .replace(/^\uFEFF/, '')
        .split('\r\n')
        .filter((l) => l !== '')
        .map((l) => l.split(','));

    const sa = await read(a.auth, today, today);
    say(
      `A: GET /money/statements?from=${today}&to=${today}&format=csv -> ${sa.status}, ${sa.data?.rowCount} rows, ${sa.data?.fileName}`,
    );
    const aLines = sa.data ? linesOf(sa.data) : [];
    for (const l of aLines) say(`   ${l.join(' | ')}`);
    check(
      "A's statement for today lists exactly A's two movements, oldest first",
      sa.status === 200 &&
        aLines.length === 3 &&
        aLines[1][4] === s1.ours &&
        aLines[1][7] === '10.00' &&
        aLines[1][3] === nameB &&
        aLines[2][6] === '10.00' &&
        aLines[2][3] === nameB,
    );
    const sb = await read(b.auth, today, today);
    const bLines = sb.data ? linesOf(sb.data) : [];
    say(`B: same day -> ${sb.status}, ${sb.data?.rowCount} rows`);
    for (const l of bLines) say(`   ${l.join(' | ')}`);
    check(
      "B's statement lists B's two movements and none of A's references as A's",
      sb.status === 200 &&
        bLines.length === 3 &&
        bLines[2][4] === s2.ours &&
        bLines[2][7] === '10.00' &&
        bLines[1][6] === '10.00',
    );

    // Fintava's own record of A's send (documented `GET /txn`, debits only).
    const page = await fintava.getCustomerHistory({
      customerId: A.customerId,
      take: 10,
    });
    const atFintava = page.items.find((t) => t.customerReference === s1.ours);
    say(
      `Fintava GET /txn for A: ${page.items.length} rows; send 1 there: ${atFintava ? `${atFintava.amountKobo} kobo, status ${atFintava.status}, reference ${atFintava.customerReference}` : 'not found'}`,
    );
    check(
      "the statement's line for send 1 matches Fintava's record: same reference, same amount",
      atFintava !== undefined &&
        atFintava.amountKobo === TEN_NAIRA &&
        aLines[1][4] === atFintava.customerReference,
    );

    const tomorrow = await read(a.auth, today, '2999-01-01');
    check(
      'a period ending after today is refused (400)',
      tomorrow.status === 400,
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

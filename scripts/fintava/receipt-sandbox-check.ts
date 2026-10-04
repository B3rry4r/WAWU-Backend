/**
 * WALLET-18: receipts, over rows that real sandbox movements put in the
 * ledger. A receipt's code opens a page that matches Fintava's own record
 * of the movement; a made-up code is a plain miss.
 *
 *   createdb w18_live_test && DATABASE_URL=... npx prisma migrate deploy
 *   MOCK_WAWU_ID_PORT=4972 node mock-wawu-id/server.js &
 *   npx tsc scripts/fintava/receipt-sandbox-check.ts --outDir dist-seed \
 *     --module nodenext --moduleResolution nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --experimentalDecorators --emitDecoratorMetadata
 *   DATABASE_URL=postgresql://...w18_live_test... RECEIPT_CHECK_PORT=4971 \
 *   WAWU_ID_PORT=4972 RECEIPT_CHECK_OUT=<folder for the image and the PDF> \
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     node dist-seed/scripts/fintava/receipt-sandbox-check.js
 *
 * Only https://dev.fintavapay.com and this machine are called: every fetch
 * goes through a guard that refuses anything else, every POST to Fintava
 * but `/transaction/wallet-to-wallet`, and a third send. The database name
 * must contain `test`. It uses OPS-02's two test customers (A and B),
 * creates none and runs no charged call: one ₦10 round trip, A to B and
 * back, so both balances end where they started.
 *
 * Each send is recorded the way the sending feature (WALLET-07) will, from
 * its answer, with the recipient's name from Fintava's free wallet name
 * enquiry; the receiver's side comes from Fintava's documented
 * `wallet_to_wallet_transfer_v2` delivery, signed locally (no tunnel, R-25)
 * and swept into the ledger by MONEY-10's consumer. The receipts are then
 * read over HTTP: the owner's routes with the stand-in WAWU ID's tokens,
 * the public page with none.
 *
 * The key is read from the environment and never printed.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { newReceiptCode } from '../../src/money/receipts/receipt-code';
import { receiptDate } from '../../src/money/receipts/receipt-document';
import type { ReceiptView } from '../../src/money/receipts/receipt-view.type';

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
const SECRET = `whsec_local_w18_${randomUUID()}`;
const PORT = Number(process.env.RECEIPT_CHECK_PORT ?? '4971');
const ID_PORT = Number(process.env.WAWU_ID_PORT ?? '4972');
const OUT = process.env.RECEIPT_CHECK_OUT ?? '';

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
  process.env.RECEIPT_VERIFY_BASE_URL = `http://127.0.0.1:${PORT}/api/hub/r`;

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
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const signUp = async (who: string) => {
      const res = await fetch(`http://127.0.0.1:${ID_PORT}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: `Receipt ${who}`,
          email: `w18-${who}-${stamp}@test.wawu.dev`,
          phone: `+23481${stamp.slice(-7)}${who === 'A' ? 1 : 2}`,
          country: 'Nigeria',
          password: 'stand-in',
        }),
      });
      const body = (await res.json()) as { accessToken: string };
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
    ) => {
      const ours = `WALLET18-SBX-${stamp}-${n}`;
      const r = await fintava.walletToWallet({
        senderAccountNumber: fromAcct,
        receiverAccountNumber: toAcct,
        amountKobo: TEN_NAIRA,
        customerReference: ours,
        narration: `WALLET-18 receipt check ${n}`,
      });
      say(
        `send ${n}: ${ours}: amount ${r.amountKobo} kobo, fee ${r.feeKobo}, total ${r.totalKobo}`,
      );
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
        note: `Receipt check ${n}`,
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

    const s1 = await send(1, a, A.accountNumber, b, B.accountNumber, nameB);
    const s2 = await send(2, b, B.accountNumber, a, A.accountNumber, nameA);

    const endA = await fintava.getWalletBalance(A.walletId);
    const endB = await fintava.getWalletBalance(B.walletId);
    say(`end: A ${endA.availableKobo} kobo, B ${endB.availableKobo} kobo`);
    check(
      'balances back where they started',
      endA.availableKobo === startA.availableKobo &&
        endB.availableKobo === startB.availableKobo,
    );

    // Fintava's own record of send 1: what the receipt must match.
    const found = await fintava.getTransactionByReference(s1.ours);
    if (found.state !== 'found')
      throw new Error(`Fintava has no record of ${s1.ours} (${found.state})`);
    const rec = found.transaction;
    say(
      `Fintava's record of send 1: ${rec.status}, ${rec.amountKobo} kobo, customerReference ${rec.customerReference}, createdAt ${rec.createdAt}`,
    );

    const api = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${PORT}/api/hub${path}`, init);
    const issue = async (auth: string, id: string) => {
      const res = await api(`/money/transactions/${id}/receipt`, {
        method: 'POST',
        headers: { Authorization: auth },
      });
      return {
        status: res.status,
        data: ((await res.json()) as { data: ReceiptView }).data,
      };
    };

    // A's receipt for send 1, and its public page with no token.
    const ra = await issue(a.auth, s1.entryId);
    say(
      `A: POST /money/transactions/<send 1>/receipt -> ${ra.status}, code ${ra.data.code}, link ${ra.data.link}, url ${ra.data.url}`,
    );
    say(`   lines: ${JSON.stringify(ra.data.lines)}`);
    const pageRes = await fetch(ra.data.url!);
    const html = await pageRes.text();
    say(`GET ${ra.data.url} (no token) -> ${pageRes.status}`);
    const statusWord: Record<string, string> = {
      SUCCESSFUL: 'Completed',
      SUCCESS: 'Completed',
      COMPLETED: 'Completed',
    };
    const date = receiptDate(ra.data.transaction.createdAt);
    const fintavaDate = receiptDate(rec.createdAt);
    say(
      `   page date ${date}; Fintava's time as the page writes it ${fintavaDate}`,
    );
    check(
      "the page's amount is Fintava's (₦10.00)",
      pageRes.status === 200 &&
        rec.amountKobo === TEN_NAIRA &&
        html.includes('₦10.00'),
    );
    check(
      "the page's reference is the one Fintava finds the movement by",
      html.includes(s1.ours) && rec.customerReference === s1.ours,
    );
    check(
      `the page's status matches Fintava's (${rec.status})`,
      html.includes(
        statusWord[rec.status.toUpperCase()] ?? `no word for ${rec.status}`,
      ),
    );
    check(
      "the page's date is the movement's, within a minute of Fintava's own time",
      html.includes(date) &&
        Math.abs(
          Date.parse(ra.data.transaction.createdAt) - Date.parse(rec.createdAt),
        ) < 60_000,
    );
    const masked = (n: string) => {
      const [first, ...rest] = n.trim().split(/\s+/);
      return [first, ...rest.map((w) => `${w.charAt(0).toUpperCase()}.`)].join(
        ' ',
      );
    };
    // A WAWU user on the other side is named, never numbered: the history
    // gives an account's last 4 only for a bank account (MONEY-15).
    check(
      `both sides masked: "${masked(nameA)}" with A's account by its last 4, and "${masked(nameB)}"`,
      html.includes(masked(nameA)) &&
        html.includes(masked(nameB)) &&
        html.includes(`Loma Bank •••• ${A.accountNumber.slice(-4)}`),
    );
    check(
      'never a full account number, a full name, the note or a person id',
      ![
        A.accountNumber,
        B.accountNumber,
        nameA,
        nameB,
        'Receipt check 1',
        a.sub,
        b.sub,
      ].some((s) => html.includes(s)),
    );

    // B's side of the same movement has its own receipt.
    const bRow = await prisma.fintavaLedgerEntry.findFirst({
      where: { wawuUserId: b.sub, direction: 'in' },
      orderBy: { occurredAt: 'asc' },
    });
    const rb = await issue(b.auth, bRow!.id);
    const bHtml = await (await fetch(rb.data.url!)).text();
    say(
      `B: receipt for the money in from A -> ${rb.status}, code ${rb.data.code}`,
    );
    check(
      "B's receipt is B's own, with its own code, showing +₦10.00 from A",
      rb.status === 200 &&
        rb.data.code !== ra.data.code &&
        bHtml.includes('+₦10.00') &&
        bHtml.includes(masked(nameA)),
    );
    const notB = await issue(b.auth, s1.entryId);
    check("B cannot make a receipt of A's row (404)", notB.status === 404);

    // A made-up code.
    const made = await fetch(
      `http://127.0.0.1:${PORT}/api/hub/r/${newReceiptCode()}`,
    );
    const madeText = await made.text();
    check(
      "a made-up code is 404 'Receipt not found' and shows nothing of anyone",
      made.status === 404 &&
        madeText.includes('Receipt not found') &&
        !madeText.includes('₦'),
    );

    // The image and the PDF of A's receipt.
    for (const kind of ['image', 'pdf'] as const) {
      const res = await api(
        `/money/transactions/${s1.entryId}/receipt/${kind}`,
        {
          headers: { Authorization: a.auth },
        },
      );
      const bytes = Buffer.from(await res.arrayBuffer());
      say(
        `A: GET .../receipt/${kind} -> ${res.status} ${res.headers.get('content-type')}, ${bytes.length} bytes`,
      );
      check(
        `the ${kind} is served`,
        res.status === 200 &&
          (kind === 'image'
            ? bytes.subarray(1, 4).toString() === 'PNG'
            : bytes.subarray(0, 5).toString() === '%PDF-'),
      );
      if (OUT) {
        const file = join(
          OUT,
          `wallet18-receipt.${kind === 'image' ? 'png' : 'pdf'}`,
        );
        writeFileSync(file, bytes);
        writeFileSync(join(OUT, 'wallet18-page.html'), html);
        say(`   saved ${file}`);
      }
    }
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

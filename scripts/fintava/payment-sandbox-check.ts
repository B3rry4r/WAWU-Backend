/**
 * MONEY-17: pay from wallet, through the served routes, against the real
 * Fintava sandbox.
 *
 *   createdb m17_live_test && DATABASE_URL=... npx prisma migrate deploy
 *   MOCK_WAWU_ID_PORT=4966 node mock-wawu-id/server.js &
 *   npx tsc scripts/fintava/payment-sandbox-check.ts --outDir dist-seed \
 *     --module nodenext --moduleResolution nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --experimentalDecorators --emitDecoratorMetadata
 *   DATABASE_URL=postgresql://...m17_live_test... PAY_CHECK_PORT=4965 \
 *   WAWU_ID_PORT=4966 \
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     node dist-seed/scripts/fintava/payment-sandbox-check.js
 *
 * Only https://dev.fintavapay.com and this machine are called: every fetch
 * goes through a guard that refuses any other host, any POST to Fintava but
 * `/transaction/wallet-to-wallet`, and a third send. The database name must
 * contain `test`. It uses OPS-02's test customer A only, creates no
 * customer and runs no charged call: one ₦10 payment from A to WAWU's
 * merchant wallet through `POST /money/payments`, the same request again
 * (which must not reach Fintava), then ₦10 from WAWU's wallet back to A, so
 * A's balance ends where it started.
 *
 * What is bought is a ₦10 test item registered here the way a selling
 * feature registers its kind (PayableRegistry); no real kind is registered
 * on main yet. The person signs up and in at the stand-in WAWU ID; every
 * request goes over HTTP with that token. The key is never printed.
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
import { FintavaClient } from '../../src/fintava/fintava-client';
import { FINTAVA_SANDBOX_BASE_URL } from '../../src/fintava/fintava-config';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { MoneyModule } from '../../src/money/money.module';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../src/money/money-view.type';
import { PayableRegistry } from '../../src/money/payments/payable-registry';

const A = {
  customerId: '4e8409cf-1234-40f7-963a-5c212c7a9836',
  walletId: '3b84eae9-f1d5-4c7f-b5b7-7dfc52185cf7',
  accountNumber: '1154079370',
};
const TEN_NAIRA = 1000;
const MAX_SENDS = 2;
const PIN = '5170';
const PORT = Number(process.env.PAY_CHECK_PORT ?? '4965');
const ID_PORT = Number(process.env.WAWU_ID_PORT ?? '4966');

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
    if (sends >= MAX_SENDS) throw new Error('refused: no more than two sends');
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
  process.env.FINTAVA_MONEY_TIMEOUT_MS = '15000';
  process.env.WAWU_ID_JWKS_URL = `http://127.0.0.1:${ID_PORT}/.well-known/jwks.json`;
  process.env.WAWU_ID_BASE_URL = `http://127.0.0.1:${ID_PORT}`;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
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
  const fintava = moduleRef.get(FintavaClient);
  const creator = randomUUID();
  moduleRef.get(PayableRegistry).register({
    kind: 'content_unlock',
    resolve: ({ targetId }) =>
      Promise.resolve({
        title: `Sandbox check ${targetId}`,
        priceKobo: TEN_NAIRA,
        payee: {
          wawuUserId: creator,
          displayName: 'Sandbox Creator',
          handle: null,
          avatarUrl: null,
          tick: 'creator',
        },
      }),
  });
  let ok = true;
  const check = (what: string, pass: boolean) => {
    ok &&= pass;
    say(`${pass ? 'PASS' : 'FAIL'} ${what}`);
  };
  const hub = (path: string, auth: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${PORT}/api/hub${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        ...(init.headers ?? {}),
      },
    });

  try {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const email = `m17-${stamp}@test.wawu.dev`;
    await fetch(`http://127.0.0.1:${ID_PORT}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Payment Check',
        email,
        phone: `+23480${stamp.slice(-8)}`,
        country: 'Nigeria',
        password: 'stand-in',
      }),
    });
    const login = (await (
      await fetch(`http://127.0.0.1:${ID_PORT}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'stand-in' }),
      })
    ).json()) as { accessToken: string };
    const auth = `Bearer ${login.accessToken}`;
    const sub = (
      JSON.parse(
        Buffer.from(login.accessToken.split('.')[1], 'base64url').toString(),
      ) as { sub: string }
    ).sub;
    say(`signed in at the stand-in WAWU ID (/auth/login)`);

    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: sub,
        customerId: A.customerId,
        walletId: A.walletId,
        accountNumber: A.accountNumber,
      },
    });
    const pinSet = await hub('/money/pin', auth, {
      method: 'POST',
      body: JSON.stringify({ pin: PIN, pinConfirmation: PIN }),
    });
    check('PIN set (201)', pinSet.status === 201);

    const startA = await fintava.getWalletBalance(A.walletId);
    const startM = await fintava.getMerchantBalance();
    say(
      `start: A ${startA.availableKobo} kobo, merchant ${startM.accountNumber} ${startM.availableKobo} kobo`,
    );

    const qRes = await hub(
      '/money/payments/quote?kind=content_unlock&targetId=sbx-item',
      auth,
    );
    const q = ((await qRes.json()) as { data: PaymentQuoteView }).data;
    say(
      `quote ${qRes.status}: price ${q.priceKobo}, fee ${q.fee.providerFeeKobo}, total ${q.totalKobo}, balance ${q.balanceKobo}`,
    );
    check(
      'the quote reads Fintava balance and adds the dashboard charge',
      qRes.status === 200 &&
        q.priceKobo === TEN_NAIRA &&
        q.fee.providerFeeKobo === 2325 &&
        q.balanceKobo === startA.availableKobo,
    );

    const idem = randomUUID();
    const payload = JSON.stringify({
      kind: 'content_unlock',
      targetId: 'sbx-item',
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
    });
    const pay = () =>
      hub('/money/payments', auth, {
        method: 'POST',
        headers: { 'Idempotency-Key': idem, 'X-Transaction-Pin': PIN },
        body: payload,
      });
    const first = await pay();
    const firstText = await first.text();
    const paid = (JSON.parse(firstText) as { data: PaymentView }).data;
    say(
      `pay ${first.status}: ${paid.status}, reference ${paid.reference}, total ${paid.totalKobo}`,
    );
    check(
      'POST /money/payments 201 completed',
      first.status === 201 && paid.status === 'completed',
    );

    const again = await pay();
    const againText = await again.text();
    check(
      'the same key and body again: the same bytes, Idempotent-Replayed, no second send',
      again.status === 201 &&
        againText === firstText &&
        again.headers.get('idempotent-replayed') === 'true' &&
        sends === 1,
    );

    const lookup = await fintava.getTransactionByReference(paid.reference);
    say(
      `lookup by our reference: ${lookup.state}${lookup.state === 'found' ? ` ${lookup.transaction.status} ${lookup.transaction.amountKobo} kobo` : ''}`,
    );
    const midA = await fintava.getWalletBalance(A.walletId);
    say(
      `A after paying: ${midA.availableKobo} kobo (moved ${startA.availableKobo - midA.availableKobo})`,
    );
    check(
      'A was debited once',
      startA.availableKobo - midA.availableKobo >= TEN_NAIRA &&
        startA.availableKobo - midA.availableKobo <= q.totalKobo,
    );

    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    say(
      `split: payee ${row.payeeShareKobo}, WAWU ${row.wawuShareKobo}; discrepancy: ${row.discrepancy ?? 'none'}`,
    );
    const ledger = await prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: paid.reference },
      orderBy: { direction: 'asc' },
    });
    for (const r of ledger) {
      say(
        `ledger ${r.walletKind} ${r.direction} ${r.status}: amount ${r.amountKobo}, fee ${r.feeKobo}, total ${r.totalKobo}, discrepancy ${r.discrepancy ?? 'none'}`,
      );
    }

    // Put A back where it started: WAWU's wallet returns the ₦10.
    const back = await fintava.walletToWallet({
      senderAccountNumber: startM.accountNumber,
      receiverAccountNumber: A.accountNumber,
      amountKobo: TEN_NAIRA,
      customerReference: `MONEY17-SBX-${stamp}-back`,
      narration: 'MONEY-17 sandbox check return',
    });
    say(`returned ${back.amountKobo} kobo to A`);
    const endA = await fintava.getWalletBalance(A.walletId);
    say(`end: A ${endA.availableKobo} kobo`);
  } finally {
    await prisma.walletPayment.deleteMany({});
    await app.close();
  }
  say(`calls to Fintava: ${calls.length}`);
  for (const c of calls) say(`  ${c.method} ${c.path} ${c.status}`);
  say(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exitCode = ok ? 0 : 1;
}

void main();

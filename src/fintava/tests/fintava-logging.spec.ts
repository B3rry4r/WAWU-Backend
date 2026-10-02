import { inspect } from 'node:util';
import { ConsoleLogger, Logger } from '@nestjs/common';
import {
  CUSTOMER_A,
  FintavaDouble,
  fintavaConfig,
  fintavaError,
  MERCHANT_ACCOUNT,
  MERCHANT_BALANCE,
  RECORD_BY_ID,
  W2W_200,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';

/**
 * MONEY-06 capability check: "No Fintava secret appears in logs."
 *
 * Every channel a log line can leave by is captured: Nest's Logger (through
 * a ConsoleLogger whose output is captured), process.stdout and
 * process.stderr, and console.*. A double that ECHOES the key and a BVN back
 * in its error messages (the worst case) answers a run of calls covering
 * every path through the client: success, refusals, auth errors, a 5xx, a
 * timeout, a dropped connection, a body we cannot read. Then no captured
 * line, no error and no serialised client may contain the key, any 8
 * characters of it in a row, the Authorization header, or the BVN.
 */

const KEY = 'live_sk_Zq9Xw7Vb5Nm3Lk1Jh8Gf6Ds4Ap2';
const BVN = '22212345678';
const PHONE_LOCAL = '08035556677';
const double = new FintavaDouble();

const captured: string[] = [];
const restores: Array<() => void> = [];

function capture(target: object, method: string): void {
  const t = target as Record<string, (...a: unknown[]) => unknown>;
  const original = t[method];
  t[method] = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join(' '),
    );
    return true;
  };
  restores.push(() => {
    t[method] = original;
  });
}

beforeAll(async () => {
  await double.start();
  capture(process.stdout, 'write');
  capture(process.stderr, 'write');
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
    capture(console, m);
  // Every level on, timestamps off: whatever the client logs is printed.
  Logger.overrideLogger(
    new ConsoleLogger({
      logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
    }),
  );
});

afterAll(async () => {
  Logger.overrideLogger(new ConsoleLogger());
  for (const restore of restores.reverse()) restore();
  await double.stop();
});

function windows(secret: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i += 1)
    out.push(secret.slice(i, i + size));
  return out;
}

/** An echo of the request's own credentials and identity, as a careless provider might. */
function echo(status: number, lead = 'Invalid API key') {
  return (req: {
    headers: Record<string, unknown>;
    query: Record<string, string>;
  }) => ({
    status,
    body: fintavaError(
      status,
      `${lead} ${String(req.headers.authorization)}`,
      `bvn ${req.query.bvn ?? BVN} phone ${req.query.phone_number ?? PHONE_LOCAL}`,
      // Part of the key with no "Bearer" in front of it.
      `fragment ${String(req.headers.authorization).slice(10, 30)} and ${KEY.slice(20, 29)}`,
    ),
  });
}

it('no Fintava secret, header or BVN reaches any log, error or serialised client', async () => {
  const c = new FintavaClient(
    fintavaConfig({
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: KEY,
      FINTAVA_TIMEOUT_MS: '150',
      FINTAVA_MONEY_TIMEOUT_MS: '150',
      FINTAVA_CHECK_TIMEOUT_MS: '150',
    }),
  );
  const errors: unknown[] = [];
  const attempt = async (p: Promise<unknown>) => {
    try {
      return await p;
    } catch (e) {
      errors.push(e);
      return null;
    }
  };

  double.on('GET', '/merchant/balance', {
    status: 200,
    body: MERCHANT_BALANCE,
  });
  double.on('POST', '/transaction/wallet-to-wallet', {
    status: 200,
    body: W2W_200,
  });
  double.on('GET', /^\/transaction\/id\//, { status: 200, body: RECORD_BY_ID });
  double.on('GET', '/compliance/verify/bvn', echo(400));
  double.on('GET', '/compliance/verify/phone-number', echo(400));
  double.on('GET', /^\/customer\/wallet\/balance\//, echo(404));
  double.on('POST', '/bank/credit', echo(400));
  double.on('POST', '/bank/credit/merchant', echo(500, 'upstream rejected'));
  double.on('GET', '/banks', { status: 200, body: `not json ${KEY}` });
  double.on('GET', '/billing/discos', {
    status: 200,
    body: MERCHANT_BALANCE,
    delayMs: 600,
  });
  double.on('GET', /^\/transaction\/reference\//, { status: 0, hangUp: true });

  await attempt(c.getMerchantBalance());
  await attempt(
    c.walletToWallet({
      senderAccountNumber: MERCHANT_ACCOUNT,
      receiverAccountNumber: CUSTOMER_A.accountNumber,
      amountKobo: 1000,
      customerReference: 'MONEY06-LOG-1',
    }),
  );
  await attempt(c.getTransactionById('02271ab1-413f-45d0-905b-c6c62a16d77a'));
  await attempt(c.verifyBvn(BVN));
  await attempt(c.verifyPhone(PHONE_LOCAL));
  await attempt(c.getWalletBalance(CUSTOMER_A.walletId));
  await attempt(
    c.bankTransfer({
      sourceCustomerId: CUSTOMER_A.customerId,
      accountNumber: '0123456789',
      sortCode: '000013',
      amountKobo: 10000,
      customerReference: 'MONEY06-LOG-2',
    }),
  );
  await attempt(
    c.merchantBankTransfer({
      accountNumber: '0123456789',
      accountName: 'SIMI MICHELLE',
      sortCode: '000013',
      amountKobo: 10000,
      customerReference: 'MONEY06-LOG-3',
    }),
  );
  await attempt(c.listBanks());
  await attempt(c.listDiscos());
  await attempt(c.reconcile('MONEY06-LOG-4', { kind: 'merchant' }));

  // The run really logged, and really failed in the ways it should.
  const logged = captured.join('\n');
  expect(logged).toMatch(/wallet to wallet: HTTP 200/);
  expect(logged).toMatch(/verify BVN: auth HTTP 400/);
  expect(logged).toMatch(
    /merchant bank transfer: outcome_unknown HTTP 500 ref MONEY06-LOG-3/,
  );
  expect(logged).toMatch(/list discos: unavailable "timed out"/);
  expect(errors.length).toBeGreaterThanOrEqual(7);
  // The double did receive the key: it was sent, only never written down.
  expect(
    double.seen.every((r) => r.headers.authorization === `Bearer ${KEY}`),
  ).toBe(true);

  const everything = [
    logged,
    ...errors.map((e) => inspect(e, { depth: 8 })),
    ...errors.map((e) => JSON.stringify(e)),
    ...errors.map((e) =>
      e instanceof FintavaError
        ? `${e.message} ${e.messages.join(' ')} ${e.stack}`
        : '',
    ),
    inspect(c, { depth: 8 }),
    JSON.stringify(c),
    `${inspect(c)}`,
  ].join('\n');

  expect(everything).not.toContain(KEY);
  for (const w of windows(KEY)) expect(everything).not.toContain(w);
  expect(everything).not.toMatch(/Bearer\s+\S/);
  expect(everything).not.toContain(BVN);
  expect(everything).not.toContain(PHONE_LOCAL);
  for (const leaked of ['22299998888', '33399998888', '08099998888']) {
    expect(everything).not.toContain(leaked);
  }
});

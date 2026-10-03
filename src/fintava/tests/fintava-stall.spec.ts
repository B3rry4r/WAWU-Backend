import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
  CUSTOMER_A,
  MERCHANT_ACCOUNT,
  fintavaConfig,
} from '../../../test/fintava/fintava-double';
import {
  FintavaStallServer,
  type StallMode,
} from '../../../test/fintava/fintava-stall-server';

import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';

/**
 * FIX-01: every Fintava call's deadline covers the whole exchange, the
 * headers AND the body, and survives garbage collection.
 *
 * Before FIX-01 the client passed `AbortSignal.timeout(...)` to `fetch` and
 * kept no reference to it. Once the headers had arrived nothing held the
 * signal (or undici's own controller that follows it), so a collection took
 * the timer with it, and a body that stalled after the headers was held
 * until undici's 300 s body timeout instead of the configured timeout.
 *
 * Each call below is made against a raw TCP server that sends headers and
 * then stalls the body. Garbage collection is forced from the moment the
 * headers are out until the call ends. Every call must end within its
 * timeout plus a small margin, exactly as the same call ends against a
 * server that sends no headers at all (the client's existing timeout path:
 * `unavailable` on a read or a check, `outcome_unknown` on a send, and a
 * reconcile that says `unreachable`).
 */

const TIMEOUT_MS = 300;
/** How late past the timeout a call may end and still pass. */
const MARGIN_MS = 700;
/** A call still going at this point is reported as hanging. */
const WATCHDOG_MS = 3000;

/**
 * `global.gc`, without needing `node --expose-gc`: the flag is set at run
 * time and read from a fresh context, which gets the `gc` global.
 */
function forcedGc(): () => void {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing) return existing;
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}
const gc = forcedGc();

const server = new FintavaStallServer();
beforeAll(() => server.start());
afterAll(() => server.stop());

function client(mode: StallMode): FintavaClient {
  return new FintavaClient(
    fintavaConfig({
      FINTAVA_BASE_URL: server.baseUrl(mode),
      FINTAVA_API_KEY: 'stall_test_FAKEKEY_0123456789',
      FINTAVA_TIMEOUT_MS: String(TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(TIMEOUT_MS),
    }),
  );
}

/** How a call ended, as one comparable string. */
function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    (value) => `resolved ${JSON.stringify(value)}`,
    (e: unknown) =>
      e instanceof FintavaError
        ? `${e.kind} ${JSON.stringify(e.messages)} status ${e.httpStatus} ` +
          `ref ${e.reference} recordMayExist ${e.recordMayExist}`
        : `threw ${String(e)}`,
  );
}

interface Run {
  result: string;
  ms: number;
}

/**
 * Makes the call against `mode`; with `collect`, forces garbage collection
 * from the moment the headers are sent (from the start, for a server that
 * sends none) until the call ends. A call still
 * running at the watchdog is reported as hanging (and left to the server's
 * teardown).
 */
async function run(
  mode: StallMode,
  call: (c: FintavaClient) => Promise<unknown>,
  collect: boolean,
): Promise<Run> {
  let collector: NodeJS.Timeout | null = null;
  let done = false;
  const collectNow = () => {
    if (done || collector) return;
    gc();
    collector = setInterval(gc, 20);
  };
  if (collect && mode === 'silent') collectNow();
  else if (collect) void server.headersSent().then(collectNow);
  const started = Date.now();
  let watchdog: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    outcome(call(client(mode))),
    new Promise<string>((resolve) => {
      watchdog = setTimeout(
        () => resolve(`STILL WAITING at ${WATCHDOG_MS} ms`),
        WATCHDOG_MS,
      );
    }),
  ]);
  const ms = Date.now() - started;
  done = true;
  clearTimeout(watchdog);
  if (collector) clearInterval(collector);
  return { result, ms };
}

// Inputs as the MONEY-06 contract tests send them.
const send = {
  senderAccountNumber: MERCHANT_ACCOUNT,
  receiverAccountNumber: CUSTOMER_A.accountNumber,
  amountKobo: 1000,
  customerReference: 'FIX01-W-1',
};
const bank = {
  sourceCustomerId: CUSTOMER_A.customerId,
  accountNumber: '0123456789',
  accountName: 'SIMI MICHELLE',
  sortCode: '000013',
  amountKobo: 10000,
  customerReference: 'FIX01-B-2',
  narration: 'A to bank',
};
const merchantBank = {
  accountNumber: '0123456789',
  accountName: 'SIMI MICHELLE',
  sortCode: '000013',
  amountKobo: 10000,
  customerReference: 'FIX01-MB-2',
};
const longAgo = new Date(Date.now() - 15 * 60_000);
const IMAGE = Buffer.alloc(3000, 7).toString('base64');

/** Every public method of the client that talks to Fintava. */
const CALLS: Array<[string, (c: FintavaClient) => Promise<unknown>]> = [
  ['verifyBvn', (c) => c.verifyBvn('12345678901')],
  [
    'verifyBvnSelfie',
    (c) => c.verifyBvnSelfie({ bvn: '12345678901', imageBase64: IMAGE }),
  ],
  ['verifyPhone', (c) => c.verifyPhone('+2348031230101')],
  [
    'createCustomer',
    (c) =>
      c.createCustomer({
        firstName: 'Ada',
        lastName: 'Sandbox',
        phone: '+234 803 123 0101',
        email: 'ada@example.com',
        address: '1 Test Street, Ikeja, Lagos',
        dateOfBirth: '1992-10-04',
        bvn: '12345678901',
        nin: '12345670003',
      }),
  ],
  ['getCustomer', (c) => c.getCustomer(CUSTOMER_A.customerId)],
  ['findCustomerByPhone', (c) => c.findCustomerByPhone('08031230101')],
  ['listCustomers', (c) => c.listCustomers({ page: 1, take: 10 })],
  // MONEY-12: the lookups account opening reconciles with.
  [
    'lookupCustomerByPhone',
    (c) => c.lookupCustomerByPhone('+2348031230101', (bvn) => bvn.slice(-4)),
  ],
  [
    'getCustomerMatch',
    (c) => c.getCustomerMatch(CUSTOMER_A.customerId, (bvn) => bvn.slice(-4)),
  ],
  [
    'listCustomerSightings',
    (c) => c.listCustomerSightings({ page: 1, take: 10 }),
  ],
  ['getWalletBalance', (c) => c.getWalletBalance(CUSTOMER_A.walletId)],
  ['getMerchantBalance', (c) => c.getMerchantBalance()],
  [
    'getCustomerHistory',
    (c) =>
      c.getCustomerHistory({ customerId: CUSTOMER_A.customerId, take: 10 }),
  ],
  ['getMerchantHistory', (c) => c.getMerchantHistory({ take: 20 })],
  ['listBanks', (c) => c.listBanks()],
  ['bankNameEnquiry', (c) => c.bankNameEnquiry('0123456789', '000013')],
  ['walletNameEnquiry', (c) => c.walletNameEnquiry(CUSTOMER_A.accountNumber)],
  [
    'getTransactionByReference',
    (c) => c.getTransactionByReference('FIX01-L-1'),
  ],
  [
    'getTransactionById',
    (c) => c.getTransactionById('02271ab1-413f-45d0-905b-c6c62a16d77a'),
  ],
  ['walletToWallet', (c) => c.walletToWallet(send)],
  ['bankTransfer', (c) => c.bankTransfer(bank)],
  ['merchantBankTransfer', (c) => c.merchantBankTransfer(merchantBank)],
  ['reconcile', (c) => c.reconcile('FIX01-W-1', { kind: 'merchant' }, longAgo)],
  [
    'retryWalletToWallet',
    (c) =>
      c.retryWalletToWallet(send, {
        sender: { kind: 'merchant' },
        attemptedAt: longAgo,
      }),
  ],
  [
    'retryBankTransfer',
    (c) =>
      c.retryBankTransfer(bank, {
        previousReference: 'FIX01-B-1',
        attemptedAt: longAgo,
      }),
  ],
  [
    'retryMerchantBankTransfer',
    (c) =>
      c.retryMerchantBankTransfer(merchantBank, {
        previousReference: 'FIX01-MB-1',
        attemptedAt: longAgo,
      }),
  ],
  ['freezeWallet', (c) => c.freezeWallet(CUSTOMER_A.walletId, 'fraud hold')],
  ['unfreezeWallet', (c) => c.unfreezeWallet(CUSTOMER_A.walletId)],
  ['listDiscos', (c) => c.listDiscos()],
  [
    'previewMeter',
    (c) =>
      c.previewMeter({
        meterNumber: '1111111111111',
        disco: 'AEDC',
        planType: 'prepaid',
      }),
  ],
  ['listDataBundles', (c) => c.listDataBundles('MTN')],
  ['listCableProviders', (c) => c.listCableProviders()],
  ['listCablePlans', (c) => c.listCablePlans('GOTV')],
  [
    'buyElectricity',
    (c) =>
      c.buyElectricity({
        meterNumber: '1111111111111',
        disco: 'AEDC',
        planType: 'prepaid',
        amountKobo: 50000,
      }),
  ],
  [
    'buyAirtime',
    (c) =>
      c.buyAirtime({ network: 'MTN', amountKobo: 10000, phone: '08031230101' }),
  ],
  [
    'buyDataBundle',
    (c) =>
      c.buyDataBundle({
        network: 'MTN',
        bundleCode: '30',
        phone: '08031230101',
      }),
  ],
  [
    'buyCable',
    (c) =>
      c.buyCable({
        provider: 'DSTV',
        smartcardNumber: '1212121212',
        planCode: '97',
      }),
  ],
];

/** What the existing timeout path says, per call: the no-headers outcome. */
const timeoutPath = new Map<string, string>();

function expectOnTime(r: Run, expected: string): void {
  expect(r.result).toBe(expected);
  expect(r.ms).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
  expect(r.ms).toBeLessThan(TIMEOUT_MS + MARGIN_MS);
}

describe('the existing timeout path: a server that sends no headers', () => {
  it.each(CALLS)('%s times out on time', async (name, call) => {
    const r = await run('silent', call, true);
    // A timeout and nothing else: a read or check is unavailable, a send is
    // outcome_unknown, a reconcile or retry says the lookup was unreachable.
    expect(r.result).toMatch(
      /^(unavailable \["timed out"\]|outcome_unknown \["timed out"\]|resolved .*"unreachable")/,
    );
    expect(r.ms).toBeLessThan(TIMEOUT_MS + MARGIN_MS);
    timeoutPath.set(name, r.result);
  });
});

describe('headers, then a body that stalls, with garbage collection forced', () => {
  it.each(CALLS)(
    '%s ends at its timeout, as the timeout path',
    async (name, call) => {
      const r = await run('stall-200', call, true);
      expectOnTime(r, timeoutPath.get(name)!);
    },
  );
});

describe('headers, then a body that stalls, without forced garbage collection', () => {
  it.each(CALLS)(
    '%s ends at its timeout, as the timeout path',
    async (name, call) => {
      const r = await run('stall-200', call, false);
      expectOnTime(r, timeoutPath.get(name)!);
    },
  );
});

describe('the stalled body is dropped, not left open', () => {
  it('the client closes the connection when the deadline passes mid-body', async () => {
    const closedBefore = server.closed;
    const openedBefore = server.opened;
    const r = await run('stall-200', (c) => c.getMerchantBalance(), true);
    expect(r.result).toBe(timeoutPath.get('getMerchantBalance'));
    expect(server.opened - openedBefore).toBe(1);
    const until = Date.now() + 1000;
    while (server.closed - closedBefore < 1 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(server.closed - closedBefore).toBe(1);
  });
});

describe('a refusal or a trickle never outlives the deadline', () => {
  it('a 400 whose body stalls is a timeout (unavailable), never a failed match', async () => {
    for (const [name, call] of CALLS.filter(([n]) =>
      ['verifyBvn', 'verifyBvnSelfie', 'verifyPhone'].includes(n),
    )) {
      const r = await run('stall-400', call, true);
      expectOnTime(r, timeoutPath.get(name)!);
      expect(r.result).toMatch(/^unavailable /);
    }
  });

  it('a send refused with a 400 whose body stalls is outcome_unknown, never a refusal', async () => {
    const r = await run('stall-400', (c) => c.walletToWallet(send), true);
    expectOnTime(r, timeoutPath.get('walletToWallet')!);
  });

  it('a body that keeps dripping ends at the deadline (selfie and balance)', async () => {
    for (const name of ['verifyBvnSelfie', 'getMerchantBalance']) {
      const call = CALLS.find(([n]) => n === name)![1];
      const r = await run('drip-200', call, true);
      expectOnTime(r, timeoutPath.get(name)!);
    }
  });
});

describe('a slow body that finishes in time is read as before', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a balance whose body lands at half the timeout is read, and the deadline is cleared', async () => {
    const set = jest.spyOn(global, 'setTimeout');
    const clear = jest.spyOn(global, 'clearTimeout');
    const c = client(`late-${TIMEOUT_MS / 2}`);
    const collector = setInterval(gc, 20);
    try {
      const balance = await c.getMerchantBalance();
      expect(balance).toMatchObject({
        availableKobo: 4965000,
        bookedKobo: 4965000,
      });
    } finally {
      clearInterval(collector);
    }
    // The deadline's timer: one, for the configured timeout, cleared once
    // the body was read.
    const deadlines = set.mock.calls
      .map((args, i) => ({
        ms: args[1],
        timer: set.mock.results[i].value as unknown,
      }))
      .filter((t) => t.ms === TIMEOUT_MS);
    expect(deadlines).toHaveLength(1);
    expect(clear).toHaveBeenCalledWith(deadlines[0].timer);
  });
});

describe('a fetch that ignores the abort', () => {
  afterEach(() => jest.restoreAllMocks());

  it('still ends at the deadline: a read is unavailable, a send outcome_unknown', async () => {
    // A fetch that never settles, whatever happens to its signal.
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => new Promise<Response>(() => undefined));
    const c = client('silent');
    const read = await run('silent', () => c.getMerchantBalance(), true);
    expectOnTime(read, timeoutPath.get('getMerchantBalance')!);
    const write = await run('silent', () => c.walletToWallet(send), true);
    expectOnTime(write, timeoutPath.get('walletToWallet')!);
  });
});

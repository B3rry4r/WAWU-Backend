import { createHash, randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  barrier,
  body,
  mintToken,
  PHONE_SHAPE,
  PIN,
  QuietLogger,
  until,
  WRONG_PIN,
} from '../../../../test/transfers/harness';
import {
  customerHistory,
  FintavaDouble,
  fintavaError,
  MERCHANT_BALANCE,
  recordByReference,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FintavaWebhookModule } from '../../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { BALANCE_CHANGED_MESSAGE } from '../../insufficient-funds';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { LedgerStatusService } from '../../ledger/ledger-status.service';
import { LedgerService } from '../../ledger/ledger.service';
import type { LedgerMovementInput } from '../../ledger/ledger.interface';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyService,
} from '../../payments/idempotency';
import { MoneyModule } from '../../money.module';
import type {
  FeeQuoteView,
  PinStateView,
  RecipientView,
  TransactionPage,
  TransferView,
} from '../../money-view.type';
import {
  RECIPIENT_BLOCKED_MESSAGE,
  RECIPIENT_CLOSED_MESSAGE,
  RECIPIENT_NO_WALLET_MESSAGE,
  RECIPIENT_NOT_FOUND_MESSAGE,
  SELF_TRANSFER_MESSAGE,
} from '../transfer-recipient';
import {
  SEND_STILL_CONFIRMING_MESSAGE,
  TRANSFER_FAILED_REASON,
  TRANSFER_NARRATION,
  WalletTransferService,
} from '../wallet-transfer.service';

/**
 * Send money to a WAWU user (task WALLET-07) over HTTP: the real MoneyModule,
 * a real database, real RS256 tokens checked against the stand-in WAWU ID's
 * JWKS (WAWU_ID_JWKS_URL), and the real MONEY-06 Fintava client over a socket
 * to FintavaDouble.
 *
 * The double plays Fintava's wallets: it holds a balance per wallet, answers
 * `GET /customer/wallet/balance/{walletId}` with the sandbox's body
 * (`sandbox/08-`) and `POST /transaction/wallet-to-wallet` with the sandbox's
 * body (`sandbox/13-`), refusing a repeated reference and a send above the
 * balance with the sandbox's own messages. It charges the dashboard's
 * balance-transfer rate (`docs/fintava/fees.md`: ₦23.25 below ₦5,000, ₦15.75
 * from ₦5,000) AND the ₦10 "Merchant charge" WAWU's fee is set to in the same
 * dashboard (R-10), both taken from the sender in the one transfer, as the
 * live account will; one test switches it to the sandbox's ₦0.
 *
 * One server for the file, listening (FIX-02); a second Hub on the same
 * database for the "two Hubs at once" test. The client's timeouts are only a
 * hang guard (a lost answer is a dropped connection, not a timer).
 */

const BASE = '/api/hub/money/transfers';
const MONEY_TIMEOUT_MS = 120_000;
/** WAWU's ₦10 and Fintava's ₦23.25 below ₦5,000 (fees.md, R-10). */
const WAWU_FEE = 1000;
const liveFee = (amountKobo: number) => (amountKobo < 500_000 ? 2325 : 1575);

/**
 * Whether any log line carries `pin` as a number of its own. Not a plain
 * substring search: a PIN is four digits, and a random reference such as
 * "wawu-send-e1397f65-..." holds the same four digits by chance, with nothing
 * leaked (it failed a CI run on 16 Oct). What can hold digits by chance is
 * taken out first (ids, stack frames, durations); the PIN must then stand
 * alone, with no letter or digit touching it.
 */
function logsCarryPin(lines: string[], pin: string): boolean {
  const text = lines
    .join('\n')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      'ID',
    )
    .replace(/\.[cm]?[jt]s:\d+(?::\d+)?/g, 'FRAME')
    .replace(/\d+ ?ms\b/g, 'DURATION');
  return new RegExp(`(?<![0-9A-Za-z])${pin}(?![0-9A-Za-z])`).test(text);
}

jest.setTimeout(300_000);

/** Fintava's record by our reference, with ids that belong to ONE transfer. */
function recordFor(ourReference: string, status: string, amount: string) {
  const record = recordByReference(ourReference, status, amount);
  const h = createHash('sha256').update(ourReference).digest('hex');
  const uuid = (o: number) =>
    `${h.slice(o, o + 8)}-${h.slice(o + 8, o + 12)}-4${h.slice(o + 12, o + 15)}-8${h.slice(o + 15, o + 18)}-${h.slice(o + 18, o + 30)}`;
  return {
    ...record,
    data: {
      ...record.data,
      id: uuid(0),
      reference: uuid(2),
      sessionId: `09062026${BigInt(`0x${h.slice(0, 15)}`)
        .toString()
        .slice(0, 22)}`,
    },
  };
}

/** Fintava's wallets, as the double keeps them. */
class Wallets {
  readonly kobo = new Map<string, number>();
  readonly byId = new Map<string, string>();
  readonly references = new Set<string>();
  readonly sends: Array<{
    from: string;
    to: string;
    amountKobo: number;
    feeKobo: number;
    reference: string;
  }> = [];
  mode:
    | 'live'
    | 'sandbox'
    | 'timeout'
    | 'error500'
    | 'refuse'
    | 'insufficient'
    | 'wrongamount' = 'live';
  /** What the dashboard's "Merchant charge" is set to: WAWU's fee, taken in the same transfer. */
  merchantCharge = WAWU_FEE;
  /** Fintava's total charge when set, whatever the band. */
  feeOverride: number | null = null;
  /** References Fintava's lookup does not show yet (its record lags). */
  readonly hidden = new Set<string>();
  /** References Fintava reports as FAILURE. */
  readonly failures = new Set<string>();
  /** Held before a transfer is taken (a barrier for requests at once). */
  sendGate: (() => Promise<void>) | null = null;
}

describe('Send to a WAWU user (WALLET-07) over HTTP', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transfers: WalletTransferService;
  let statusChecks: LedgerStatusService;
  let ledger: LedgerService;
  let fees: FeeQuoteService;
  let provider: WalletProvider;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  /** Every answer text the file saw, scanned for phone numbers at the end. */
  const seenTexts: string[] = [];
  let accountSeq = 0;

  type Person = {
    id: string;
    auth: string;
    walletId: string;
    accountNumber: string;
    customerId: string;
    name: string;
    handle: string;
  };

  /** A person with an open wallet holding `kobo`, a profile, and the PIN set (unless told). */
  async function person(
    kobo: number,
    opts: { pin?: boolean; name?: string; profile?: boolean } = {},
  ): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `18${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const walletId = randomUUID();
    const customerId = randomUUID();
    const name = opts.name ?? `Tester ${accountSeq}`;
    const handle = `w07-${id.slice(0, 8)}`;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId,
        walletId,
        accountNumber,
        accountName: name,
      },
    });
    if (opts.profile !== false) {
      await prisma.userProfile.create({
        data: { wawuUserId: id, accountType: 'user', handle },
      });
    }
    wallets.kobo.set(accountNumber, kobo);
    wallets.byId.set(walletId, accountNumber);
    if (opts.pin !== false) {
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
    }
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      walletId,
      accountNumber,
      customerId,
      name,
      handle,
    };
  }

  function track(res: Response): Response {
    seenTexts.push(res.text);
    return res;
  }

  async function quoted(p: Person, amountKobo: number): Promise<FeeQuoteView> {
    const res = track(
      await request(app.getHttpServer())
        .get(
          `/api/hub/money/fees/quote?kind=wawu_transfer&amountKobo=${amountKobo}`,
        )
        .set('Authorization', p.auth),
    );
    expect(res.status).toBe(200);
    return body<FeeQuoteView>(res).data!;
  }

  function send(
    p: Person,
    payload: Record<string, unknown>,
    key: string | null = randomUUID(),
    pin: string | null = PIN,
    on: INestApplication<App> = app,
  ) {
    let req = request(on.getHttpServer())
      .post(`${BASE}/wawu`)
      .set('Authorization', p.auth);
    if (key !== null) req = req.set('Idempotency-Key', key);
    if (pin !== null) req = req.set('X-Transaction-Pin', pin);
    return req.send(payload).then(track);
  }

  function sendBody(
    to: Person | { id: string },
    q: FeeQuoteView,
    extra: Record<string, unknown> = {},
  ) {
    return {
      recipientWawuUserId: to.id,
      amountKobo: q.amountKobo,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
      ...extra,
    };
  }

  /** A quote and a body for a send of `amountKobo` to `to`. */
  async function ready(
    p: Person,
    to: Person | { id: string },
    amountKobo: number,
    extra: Record<string, unknown> = {},
  ) {
    return sendBody(to, await quoted(p, amountKobo), extra);
  }

  const sendsFrom = (p: Person) =>
    wallets.sends.filter((s) => s.from === p.accountNumber);
  const w2wSeen = () =>
    double.seen.filter((r) => r.path === '/transaction/wallet-to-wallet');
  const balance = (p: Person) => wallets.kobo.get(p.accountNumber);

  async function pinState(p: Person): Promise<PinStateView> {
    const res = track(
      await request(app.getHttpServer())
        .get('/api/hub/money/pin')
        .set('Authorization', p.auth),
    );
    return body<PinStateView>(res).data!;
  }

  async function ledgerRows(reference: string) {
    return prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  }

  function read(p: Person, id: string) {
    return request(app.getHttpServer())
      .get(`${BASE}/${id}`)
      .set('Authorization', p.auth)
      .then(track);
  }

  const transferRows = (p: Person) =>
    prisma.walletTransfer.findMany({ where: { payerWawuUserId: p.id } });

  function installFintava() {
    double.reset();
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    double.on('GET', /^\/customer\/wallet\/balance\//, (req: SeenRequest) => {
      const id = req.path.split('/').pop()!;
      const account = wallets.byId.get(id);
      if (!account) {
        return { status: 400, body: fintavaError(400, 'Wallet not found') };
      }
      const naira = (wallets.kobo.get(account) ?? 0) / 100;
      return {
        status: 200,
        body: {
          data: {
            balance: { bookedBalance: naira, availableBalance: naira },
            tier: 'TIER_2',
          },
          status: 200,
          message: 'Wallet details fetched',
        },
      };
    });
    double.on('GET', /^\/transaction\/reference\//, (req: SeenRequest) => {
      const ref = decodeURIComponent(
        req.path.replace('/transaction/reference/', ''),
      );
      const send = wallets.sends.find((x) => x.reference === ref);
      if (!send || wallets.hidden.has(ref)) {
        return {
          status: 404,
          body: fintavaError(404, 'Transaction not found!'),
        };
      }
      return {
        status: 200,
        body: recordFor(
          ref,
          wallets.failures.has(ref) ? 'FAILURE' : 'SUCCESS',
          (send.amountKobo / 100).toFixed(2),
        ),
      };
    });
    double.on('GET', '/txn', { status: 200, body: customerHistory([]) });
    double.on(
      'POST',
      '/transaction/wallet-to-wallet',
      async (req: SeenRequest) => {
        if (wallets.sendGate) await wallets.sendGate();
        const b = req.body as {
          senderAccount: string;
          receiverAccount: string;
          amount: number;
          CustomerReference: string;
        };
        const mode = wallets.mode;
        if (mode === 'error500') {
          return { status: 500, body: fintavaError(500, 'read ECONNRESET') };
        }
        if (mode === 'refuse') {
          return {
            status: 400,
            body: fintavaError(400, 'Transfer could not be processed'),
          };
        }
        if (mode === 'insufficient') {
          return {
            status: 400,
            body: fintavaError(
              400,
              'Insufficient balance on source wallet to complete this transfer.',
            ),
          };
        }
        if (wallets.references.has(b.CustomerReference)) {
          return {
            status: 400,
            body: fintavaError(400, 'customerReference already exists'),
          };
        }
        const amountKobo =
          Math.round(b.amount * 100) + (mode === 'wrongamount' ? 100 : 0);
        const feeKobo =
          wallets.feeOverride ??
          (mode === 'sandbox'
            ? 0
            : liveFee(amountKobo) + wallets.merchantCharge);
        const have = wallets.kobo.get(b.senderAccount) ?? 0;
        if (have < amountKobo + feeKobo) {
          return {
            status: 400,
            body: fintavaError(
              400,
              'Insufficient balance on source wallet to complete this transfer.',
            ),
          };
        }
        // The money moves when Fintava takes the request, whether or not the
        // answer reaches the caller in time.
        wallets.references.add(b.CustomerReference);
        wallets.kobo.set(b.senderAccount, have - amountKobo - feeKobo);
        wallets.kobo.set(
          b.receiverAccount,
          (wallets.kobo.get(b.receiverAccount) ?? 0) + amountKobo,
        );
        wallets.sends.push({
          from: b.senderAccount,
          to: b.receiverAccount,
          amountKobo,
          feeKobo,
          reference: b.CustomerReference,
        });
        const after = (have - amountKobo - feeKobo) / 100;
        return {
          status: 200,
          // A lost answer: the transfer is taken and the connection is
          // dropped, which the client reads as it reads a timeout.
          hangUp: mode === 'timeout',
          body: {
            data: {
              amount: amountKobo / 100,
              reference: `tagapay${randomUUID().replace(/-/g, '')}`,
              customerReference: randomUUID(),
              total: (amountKobo + feeKobo) / 100,
              transaction_fee: feeKobo / 100,
              source_customer_id: randomUUID(),
              source_customer_accname: 'Send Tester',
              source_customer_accno: b.senderAccount,
              source_customer_wallet: b.senderAccount,
              source_availableBalance: after,
              source_bookedBalance: after,
              description: 'Fund transfer between customers',
            },
            status: 200,
            message: 'successful',
          },
        };
      },
    );
  }

  async function boot(): Promise<{
    app: INestApplication<App>;
    moduleRef: TestingModule;
  }> {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        FintavaWebhookModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .setLogger(logger)
      .compile();
    const hub = ref.createNestApplication<INestApplication<App>>({
      ...HUB_APP_OPTIONS,
      logger,
    });
    hub.useLogger(logger);
    hub.setGlobalPrefix('api/hub');
    hub.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    hub.useGlobalFilters(new AllExceptionsFilter());
    hub.useGlobalInterceptors(new ResponseInterceptor());
    await hub.init();
    await hub.listen(0, '127.0.0.1');
    return { app: hub, moduleRef: ref };
  }

  beforeAll(async () => {
    cheapPinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    await double.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_w07_send_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'w07-test-fee-quote-key-0123456789abcdef0123',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    installFintava();
    const hub = await boot();
    app = hub.app;
    moduleRef = hub.moduleRef;
    prisma = moduleRef.get(PrismaService);
    transfers = moduleRef.get(WalletTransferService);
    statusChecks = moduleRef.get(LedgerStatusService);
    ledger = moduleRef.get(LedgerService);
    fees = moduleRef.get(FeeQuoteService);
    provider = moduleRef.get<WalletProvider>(WALLET_PROVIDER);
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletTransfer.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { recipientWawuUserId: { in: users } },
          ],
        },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: rows.map((r) => r.customerReference) } },
            { wawuUserId: { in: users } },
          ],
        },
      });
      await prisma.walletTransfer.deleteMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { recipientWawuUserId: { in: users } },
          ],
        },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: users } }, { blockedWawuId: { in: users } }],
        },
      });
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    if (app) await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    wallets.mode = 'live';
    wallets.merchantCharge = WAWU_FEE;
    wallets.feeOverride = null;
    wallets.sendGate = null;
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The task's two capability checks
  // -------------------------------------------------------------------------

  it('check 1: ₦10,000 sends ₦2,000 to @amaka: the balance drops by ₦2,033.25 (the quoted total), hers rises by exactly ₦2,000', async () => {
    const me = await person(1_000_000, { name: 'Chidi Eze' });
    const amaka = await person(0, { name: 'Amaka Obi' });
    const q = await quoted(me, 200_000);
    expect(q).toMatchObject({
      kind: 'wawu_transfer',
      amountKobo: 200_000,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 1000, totalFeeKobo: 3325 },
      totalKobo: 203_325,
    });

    const res = await send(me, sendBody(amaka, q, { note: 'For the shoot' }));
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    expect(view).toMatchObject({
      kind: 'wawu_user',
      status: 'completed',
      amountKobo: 200_000,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 1000, totalFeeKobo: 3325 },
      totalKobo: 203_325,
      note: 'For the shoot',
      toWawuUser: {
        wawuUserId: amaka.id,
        displayName: 'Amaka Obi',
        handle: amaka.handle,
      },
      toBankAccount: null,
      failureReason: null,
      reversal: null,
      statusMessage: null,
    });
    expect(view.reference).toBe(`wawu-send-${view.id}`);
    expect(view.completedAt).not.toBeNull();
    expect(view.timeline.map((t) => t.step)).toEqual([
      'requested',
      'completed',
    ]);

    // Fintava: one transfer of the amount, under our reference.
    expect(sendsFrom(me)).toEqual([
      {
        from: me.accountNumber,
        to: amaka.accountNumber,
        amountKobo: 200_000,
        feeKobo: 3325,
        reference: view.reference,
      },
    ]);
    expect(
      w2wSeen().filter(
        (r) =>
          (r.body as { CustomerReference?: string }).CustomerReference ===
          view.reference,
      ),
    ).toHaveLength(1);
    expect(balance(me)).toBe(1_000_000 - 203_325);
    expect(balance(amaka)).toBe(200_000);

    // The ledger: the sender's debit with both charges, the receiver's credit.
    const rows = await ledgerRows(view.reference);
    expect(
      rows.map((r) => ({
        who: r.wawuUserId,
        wallet: r.walletKind,
        direction: r.direction,
        status: r.status,
        category: r.category,
        amount: r.amountKobo,
        fee: r.feeKobo,
        providerFee: r.providerFeeKobo,
        wawuFee: r.wawuFeeKobo,
        total: r.totalKobo,
        transferId: r.transferId,
        counterparty: r.counterpartyWawuUserId,
        counterpartyName: r.counterpartyName,
        note: r.note,
        discrepancy: r.discrepancy,
      })),
    ).toEqual([
      {
        who: amaka.id,
        wallet: 'user',
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amount: 200_000n,
        fee: 0n,
        providerFee: 0n,
        wawuFee: 0n,
        total: 200_000n,
        transferId: view.id,
        counterparty: me.id,
        counterpartyName: 'Chidi Eze',
        note: 'For the shoot',
        discrepancy: null,
      },
      {
        who: me.id,
        wallet: 'user',
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amount: 200_000n,
        fee: 3325n,
        providerFee: 2325n,
        wawuFee: 1000n,
        total: 203_325n,
        transferId: view.id,
        counterparty: amaka.id,
        counterpartyName: 'Amaka Obi',
        note: 'For the shoot',
        discrepancy: null,
      },
    ]);
    // The receipt route's key (G-66): the sender's row.
    const out = rows.find((r) => r.direction === 'out')!;
    expect(view.transactionId).toBe(out.id);

    // The poll is the same send.
    const polled = await read(me, view.id);
    expect(polled.status).toBe(200);
    expect(body<TransferView>(polled).data).toEqual(view);
    // History: the sender's row with the fee, the receiver's without.
    const mine = body<TransactionPage>(
      track(
        await request(app.getHttpServer())
          .get('/api/hub/money/transactions')
          .set('Authorization', me.auth),
      ),
    ).data!;
    expect(mine.items[0]).toMatchObject({
      direction: 'out',
      category: 'transfer',
      status: 'completed',
      amountKobo: 200_000,
      totalKobo: 203_325,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 1000, totalFeeKobo: 3325 },
      transferId: view.id,
      counterparty: { name: 'Amaka Obi' },
    });
    const hers = body<TransactionPage>(
      track(
        await request(app.getHttpServer())
          .get('/api/hub/money/transactions')
          .set('Authorization', amaka.auth),
      ),
    ).data!;
    expect(hers.items[0]).toMatchObject({
      direction: 'in',
      category: 'transfer',
      status: 'completed',
      amountKobo: 200_000,
      totalKobo: 200_000,
      counterparty: { name: 'Chidi Eze' },
    });
    // WALLET-08's "recent": she is now someone I sent money to.
    const recent = body<RecipientView[]>(
      track(
        await request(app.getHttpServer())
          .get('/api/hub/money/recipients/recent')
          .set('Authorization', me.auth),
      ),
    ).data!;
    expect(recent.map((r) => r.wawuUserId)).toContain(amaka.id);
  });

  it('check 2: sending to a blocked user is refused, in either direction, before the PIN: no PIN try used, nothing sent, the key given back', async () => {
    const me = await person(1_000_000);
    const them = await person(0);
    const theirs = await person(1_000_000);
    await prisma.blockedAccount.create({
      data: { userWawuId: me.id, blockedWawuId: them.id },
    });
    await prisma.blockedAccount.create({
      data: { userWawuId: theirs.id, blockedWawuId: me.id },
    });
    const key = randomUUID();
    const b = await ready(me, them, 100_000);
    const triesBefore = (await pinState(me)).triesLeft;
    // Even with a wrong PIN the answer is the block: the PIN is not looked at.
    const res = await send(me, b, key, WRONG_PIN);
    expect(res.status).toBe(403);
    expect(body(res)).toMatchObject({
      statusCode: 403,
      reason: { code: 'recipient_blocked', message: RECIPIENT_BLOCKED_MESSAGE },
    });
    expect((await pinState(me)).triesLeft).toBe(triesBefore);
    // The other direction: they blocked me.
    const b2 = await ready(me, theirs, 100_000);
    const res2 = await send(me, b2, randomUUID(), WRONG_PIN);
    expect(res2.status).toBe(403);
    expect(body(res2).reason?.code).toBe('recipient_blocked');
    // And they can not send to me either.
    const b3 = await ready(theirs, me, 100_000);
    const res3 = await send(theirs, b3);
    expect(body(res3).reason?.code).toBe('recipient_blocked');

    expect(sendsFrom(me)).toHaveLength(0);
    expect(sendsFrom(theirs)).toHaveLength(0);
    expect(await transferRows(me)).toHaveLength(0);
    expect(balance(me)).toBe(1_000_000);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    // Unblocked, the same key sends it, once.
    await prisma.blockedAccount.deleteMany({ where: { userWawuId: me.id } });
    const again = await send(me, b, key);
    expect(again.status).toBe(201);
    expect(body<TransferView>(again).data!.status).toBe('completed');
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(them)).toBe(100_000);
  });

  // -------------------------------------------------------------------------
  // Who the money may go to
  // -------------------------------------------------------------------------

  it('yourself, nobody, a closed account, a wallet-less user and a wallet on another provider each get their own answer, before the PIN', async () => {
    const me = await person(1_000_000);
    const noWallet = await person(0, { profile: true });
    await prisma.fintavaWallet.delete({ where: { wawuUserId: noWallet.id } });
    const closing = await person(0);
    await prisma.pushStoppedAccount.create({
      data: { userWawuId: closing.id },
    });
    const elsewhere = await person(0);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: elsewhere.id },
      data: { provider: 'nuvion' },
    });
    const q = await quoted(me, 100_000);
    const triesBefore = (await pinState(me)).triesLeft;
    const cases: Array<[string, { id: string }, number, string, string]> = [
      ['yourself', me, 400, 'self_transfer', SELF_TRANSFER_MESSAGE],
      [
        'nobody',
        { id: randomUUID() },
        404,
        'recipient_not_found',
        RECIPIENT_NOT_FOUND_MESSAGE,
      ],
      [
        'a closed account',
        closing,
        404,
        'recipient_not_found',
        RECIPIENT_CLOSED_MESSAGE,
      ],
      [
        'no wallet',
        noWallet,
        409,
        'recipient_has_no_wallet',
        RECIPIENT_NO_WALLET_MESSAGE,
      ],
      [
        'a wallet another provider holds',
        elsewhere,
        409,
        'recipient_has_no_wallet',
        RECIPIENT_NO_WALLET_MESSAGE,
      ],
    ];
    for (const [who, to, status, code, message] of cases) {
      const res = await send(me, sendBody(to, q), randomUUID(), WRONG_PIN);
      expect({ who, status: res.status, reason: body(res).reason }).toEqual({
        who,
        status,
        reason: { code, message },
      });
    }
    expect((await pinState(me)).triesLeft).toBe(triesBefore);
    expect(
      w2wSeen().filter(
        (r) =>
          (r.body as { senderAccount: string }).senderAccount ===
          me.accountNumber,
      ),
    ).toHaveLength(0);
    expect(await transferRows(me)).toHaveLength(0);
    for (const m of [
      RECIPIENT_BLOCKED_MESSAGE,
      RECIPIENT_CLOSED_MESSAGE,
      RECIPIENT_NO_WALLET_MESSAGE,
      RECIPIENT_NOT_FOUND_MESSAGE,
      SELF_TRANSFER_MESSAGE,
      SEND_STILL_CONFIRMING_MESSAGE,
      TRANSFER_FAILED_REASON,
    ]) {
      expect(m).not.toMatch(/—/);
      expect(m).not.toMatch(/fintava|nuvion/i);
    }
  });

  it('a malformed recipient is the plain validation 400, not a recipient answer', async () => {
    const me = await person(1_000_000);
    const q = await quoted(me, 100_000);
    const res = await send(me, sendBody({ id: 'not-an-id' }, q));
    expect(res.status).toBe(400);
    expect(body(res).reason).toBeUndefined();
    expect(sendsFrom(me)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Once per key
  // -------------------------------------------------------------------------

  it('the same request sent twice moves money once; the repeat is the first answer, byte for byte, and checks no PIN', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    const first = await send(me, b, key);
    expect(first.status).toBe(201);
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      undefined,
    );
    const triesBefore = (await pinState(me)).triesLeft;
    // A wrong PIN on the repeat changes nothing: it is answered first.
    const again = await send(me, b, key, WRONG_PIN);
    expect(again.status).toBe(201);
    expect(again.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(again.text).toBe(first.text);
    expect((await pinState(me)).triesLeft).toBe(triesBefore);
    const third = await send(me, b, key, null);
    expect(third.text).toBe(first.text);
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(me)).toBe(1_000_000 - 203_325);
    expect(balance(to)).toBe(200_000);
    expect(await transferRows(me)).toHaveLength(1);
    expect(
      (await ledgerRows(body<TransferView>(first).data!.reference)).length,
    ).toBe(2);
  });

  it('even if the recipient was blocked since, a repeat of a finished send is its first answer (a replay is never re-judged)', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    const key = randomUUID();
    const first = await send(me, b, key);
    expect(first.status).toBe(201);
    await prisma.blockedAccount.create({
      data: { userWawuId: to.id, blockedWawuId: me.id },
    });
    const again = await send(me, b, key);
    expect(again.status).toBe(201);
    expect(again.text).toBe(first.text);
    expect(sendsFrom(me)).toHaveLength(1);
    // A new key is a new send, and the block now stops it.
    const fresh = await send(me, b, randomUUID());
    expect(body(fresh).reason?.code).toBe('recipient_blocked');
  });

  it('the same key with another body is idempotency_key_reused and nothing is sent; no key or a malformed one is 400 before the PIN', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    const key = randomUUID();
    expect((await send(me, b, key)).status).toBe(201);
    const q2 = await quoted(me, 150_000);
    const other = await send(me, sendBody(to, q2), key);
    expect(other.status).toBe(409);
    expect(body(other).reason?.code).toBe('idempotency_key_reused');
    expect(sendsFrom(me)).toHaveLength(1);
    const triesBefore = (await pinState(me)).triesLeft;
    for (const k of [null, 'short', 'has spaces in the key!!']) {
      const res = await send(me, b, k, WRONG_PIN);
      expect(res.status).toBe(400);
      expect(body(res).reason?.code).toBe('idempotency_key_required');
    }
    expect((await pinState(me)).triesLeft).toBe(triesBefore);
  });

  it('8 taps at once on one Hub with one key: one transfer, and every answer is that send or "still going through"', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    const gate = barrier(1);
    wallets.sendGate = async () => {
      await gate();
      // Held long enough for the other taps to reach the key.
      await new Promise((r) => setTimeout(r, 700));
    };
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => send(me, b, key)),
    );
    const view = answers.find(
      (r) => r.status === 201 && r.headers['idempotent-replayed'] === undefined,
    );
    expect(view).toBeDefined();
    for (const r of answers) {
      if (r === view) continue;
      if (r.status === 201) {
        expect(r.text).toBe(view!.text);
      } else {
        expect(r.status).toBe(409);
        expect(body(r).reason?.code).toBe('idempotency_in_progress');
      }
    }
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(me)).toBe(1_000_000 - 203_325);
    expect(await transferRows(me)).toHaveLength(1);
    expect(
      await prisma.fintavaLedgerEntry.count({
        where: { customerReference: body<TransferView>(view!).data!.reference },
      }),
    ).toBe(2);
  });

  it('two Hubs at once on one database with one key: one transfer, and the Hub that lost the race answers "in progress" or the same send', async () => {
    const hub2 = await boot();
    try {
      const me = await person(1_000_000);
      const to = await person(0);
      const b = await ready(me, to, 200_000);
      const key = randomUUID();
      wallets.sendGate = async () => {
        await new Promise((r) => setTimeout(r, 700));
      };
      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          send(me, b, key, PIN, i % 2 === 0 ? app : hub2.app),
        ),
      );
      const fresh = answers.filter(
        (r) =>
          r.status === 201 && r.headers['idempotent-replayed'] === undefined,
      );
      expect(fresh).toHaveLength(1);
      for (const r of answers) {
        if (r === fresh[0]) continue;
        if (r.status === 201) expect(r.text).toBe(fresh[0].text);
        else expect(body(r).reason?.code).toBe('idempotency_in_progress');
      }
      expect(sendsFrom(me)).toHaveLength(1);
      expect(balance(me)).toBe(1_000_000 - 203_325);
      expect(balance(to)).toBe(200_000);
      expect(await transferRows(me)).toHaveLength(1);
      // The other Hub answers the repeat from the stored answer.
      const repeat = await send(me, b, key, PIN, hub2.app);
      expect(repeat.text).toBe(fresh[0].text);
      expect(sendsFrom(me)).toHaveLength(1);
    } finally {
      await hub2.app.close();
    }
  });

  it('two different sends at once with money for one: one completes, the other is a real shortfall, and the balance is never negative', async () => {
    const me = await person(300_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const gate = barrier(2);
    wallets.sendGate = gate;
    const answers = await Promise.all([
      send(me, b, randomUUID()),
      send(me, b, randomUUID()),
    ]);
    wallets.sendGate = null;
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 402]);
    const refused = answers.find((r) => r.status === 402)!;
    const reason = body(refused).reason!;
    expect(reason.code).toBe('insufficient_funds');
    expect(reason.totalKobo).toBe(203_325);
    if (reason.shortfallKobo !== undefined) {
      expect(reason.shortfallKobo).toBeGreaterThan(0);
      expect(reason.shortfallKobo).toBe(203_325 - reason.balanceKobo!);
    }
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(me)).toBe(300_000 - 203_325);
    expect(balance(to)).toBe(200_000);
  });

  it('a wrong PIN stores nothing: the same key with the right PIN then sends, once', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    const key = randomUUID();
    const wrong = await send(me, b, key, WRONG_PIN);
    expect(wrong.status).toBe(403);
    expect(body(wrong).reason).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });
    expect(sendsFrom(me)).toHaveLength(0);
    const right = await send(me, b, key);
    expect(right.status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it('no PIN set yet: 409 pin_not_set (the app opens A9 and comes back), nothing sent, and the key still works once the PIN is set', async () => {
    const me = await person(1_000_000, { pin: false });
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    const key = randomUUID();
    const res = await send(me, b, key);
    expect(res.status).toBe(409);
    expect(body(res)).toMatchObject({ reason: { code: 'pin_not_set' } });
    expect(sendsFrom(me)).toHaveLength(0);
    expect(await transferRows(me)).toHaveLength(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    await prisma.transactionPin.create({
      data: { wawuUserId: me.id, pinHash: cheapPinHash },
    });
    const done = await send(me, b, key);
    expect(done.status).toBe(201);
    expect(body<TransferView>(done).data!.status).toBe('completed');
    expect(sendsFrom(me)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // A short balance
  // -------------------------------------------------------------------------

  it('not enough money: 402 with the balance, the total and the shortfall including both fees; nothing claimed or sent; the key works after a top-up', async () => {
    const me = await person(200_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    const res = await send(me, b, key);
    expect(res.status).toBe(402);
    expect(body(res)).toMatchObject({
      statusCode: 402,
      message: 'You need ₦33.25 more in your wallet.',
      reason: {
        code: 'insufficient_funds',
        message: 'You need ₦33.25 more in your wallet.',
        balanceKobo: 200_000,
        totalKobo: 203_325,
        shortfallKobo: 3325,
      },
    });
    expect(sendsFrom(me)).toHaveLength(0);
    expect(
      w2wSeen().filter(
        (r) =>
          (r.body as { senderAccount: string }).senderAccount ===
          me.accountNumber,
      ),
    ).toHaveLength(0);
    expect(await transferRows(me)).toHaveLength(0);
    expect(
      await prisma.fintavaLedgerEntry.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    // 1 kobo short reads ₦0.01; exactly the total sends.
    wallets.kobo.set(me.accountNumber, 203_324);
    const short = await send(me, b, key);
    expect(body(short).reason).toMatchObject({ shortfallKobo: 1 });
    expect(body(short).message).toBe('You need ₦0.01 more in your wallet.');
    wallets.kobo.set(me.accountNumber, 203_325);
    const exact = await send(me, b, key);
    expect(exact.status).toBe(201);
    expect(balance(me)).toBe(0);
  });

  it('Fintava saying there is not enough after our read passed: a fresh balance that covers it is "Your balance changed", never ₦0.00 short; the send is failed and the key given back', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    wallets.mode = 'insufficient';
    const res = await send(me, b, key);
    expect(res.status).toBe(402);
    expect(body(res).reason).toMatchObject({
      code: 'insufficient_funds',
      message: BALANCE_CHANGED_MESSAGE,
    });
    expect(body(res).reason).not.toHaveProperty('shortfallKobo');
    const [row] = await transferRows(me);
    expect(row.status).toBe('failed');
    expect(sendsFrom(me)).toHaveLength(0);
    wallets.mode = 'live';
    const ok = await send(me, b, key);
    expect(ok.status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(1);
    expect(await transferRows(me)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // The quote
  // -------------------------------------------------------------------------

  it('a different total, a token from another person, a forged one or an old one: 409 quote_changed with the quote as it stands, nothing sent', async () => {
    const me = await person(1_000_000);
    const other = await person(1_000_000);
    const to = await person(0);
    const q = await quoted(me, 200_000);
    const theirs = await quoted(other, 200_000);
    const cases: Array<Record<string, unknown>> = [
      { ...sendBody(to, q), expectedTotalKobo: q.totalKobo - 1 },
      { ...sendBody(to, q), quoteToken: theirs.quoteToken },
      { ...sendBody(to, q), quoteToken: `${q.quoteToken.slice(0, -4)}AAAA` },
      { ...sendBody(to, q), quoteToken: 'x' },
      // A quote for another amount does not pay this one.
      { ...sendBody(to, q), amountKobo: 150_000 },
    ];
    for (const c of cases) {
      const res = await send(me, c);
      expect(res.status).toBe(409);
      expect(body(res).reason).toMatchObject({
        code: 'quote_changed',
        feeQuote: { kind: 'wawu_transfer' },
      });
    }
    // An expired quote: signed ten minutes ago.
    const old = fees.quote(
      me.id,
      { kind: 'wawu_transfer', amountKobo: 200_000 },
      new Date(Date.now() - 10 * 60_000),
    );
    const expired = await send(me, {
      ...sendBody(to, q),
      quoteToken: old.quoteToken,
    });
    expect(expired.status).toBe(409);
    expect(body(expired).reason?.code).toBe('quote_changed');
    expect(sendsFrom(me)).toHaveLength(0);
    expect(await transferRows(me)).toHaveLength(0);
  });

  it('a note is trimmed and at most 100 characters; a NUL in it, a missing amount or a decimal one is a plain 400 before anything is claimed', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const q = await quoted(me, 100_000);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['too long', { ...sendBody(to, q), note: 'x'.repeat(101) }],
      ['NUL', { ...sendBody(to, q), note: 'a\u0000b' }],
      ['no amount', { ...sendBody(to, q), amountKobo: undefined }],
      ['decimal amount', { ...sendBody(to, q), amountKobo: 1000.5 }],
      ['zero amount', { ...sendBody(to, q), amountKobo: 0 }],
      ['no token', { ...sendBody(to, q), quoteToken: undefined }],
      ['unknown field', { ...sendBody(to, q), payerWawuUserId: me.id }],
    ];
    for (const [what, payload] of bad) {
      const res = await send(me, payload);
      expect({ what, status: res.status }).toEqual({ what, status: 400 });
      expect(body(res).reason).toBeUndefined();
    }
    expect(await transferRows(me)).toHaveLength(0);
    const ok = await send(me, sendBody(to, q, { note: '  thanks  ' }));
    expect(ok.status).toBe(201);
    expect(body<TransferView>(ok).data!.note).toBe('thanks');
  });

  // -------------------------------------------------------------------------
  // A lost answer, a crash between the answer and our write
  // -------------------------------------------------------------------------

  it('a lost answer is pending, never sent again: the poll says "still confirming"; the sweep finds it by OUR reference and completes it once', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    wallets.mode = 'timeout';
    const res = await send(me, b, key);
    wallets.mode = 'live';
    expect(res.status).toBe(201);
    const pending = body<TransferView>(res).data!;
    expect(pending).toMatchObject({
      status: 'pending',
      statusMessage: SEND_STILL_CONFIRMING_MESSAGE,
      failureReason: null,
      completedAt: null,
    });
    // The money moved at Fintava although the answer was lost.
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(to)).toBe(200_000);
    // Only the sender's row exists until it is confirmed: she sees nothing yet.
    const before = await ledgerRows(pending.reference);
    expect(before.map((r) => `${r.direction}:${r.status}`)).toEqual([
      'out:pending',
    ]);
    // A repeat is the same answer, and nothing is sent again.
    const again = await send(me, b, key);
    expect(again.text).toBe(res.text);
    expect(sendsFrom(me)).toHaveLength(1);
    const polled = body<TransferView>(await read(me, pending.id)).data!;
    expect(polled.status).toBe('pending');

    const swept = await transfers.sweep(new Date(Date.now() + 3 * 60_000));
    expect(swept.settled).toBeGreaterThanOrEqual(1);
    const done = body<TransferView>(await read(me, pending.id)).data!;
    expect(done).toMatchObject({ status: 'completed', statusMessage: null });
    expect(done.totalKobo).toBe(203_325);
    expect(sendsFrom(me)).toHaveLength(1);
    expect(
      w2wSeen().filter(
        (r) =>
          (r.body as { CustomerReference?: string }).CustomerReference ===
          pending.reference,
      ),
    ).toHaveLength(1);
    const rows = await ledgerRows(pending.reference);
    expect(rows.map((r) => `${r.direction}:${r.status}`)).toEqual([
      'in:completed',
      'out:completed',
    ]);
    // The sweep again changes nothing.
    await transfers.sweep(new Date(Date.now() + 6 * 60_000));
    expect(sendsFrom(me)).toHaveLength(1);
    expect((await ledgerRows(pending.reference)).length).toBe(2);
  });

  it('a 5xx is pending too, nothing is sent again, and Fintava not showing the record yet is never read as "no money moved"', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    wallets.mode = 'error500';
    const res = await send(me, b);
    wallets.mode = 'live';
    const pending = body<TransferView>(res).data!;
    expect(pending.status).toBe('pending');
    expect(sendsFrom(me)).toHaveLength(0);
    // Fintava has no record: the send stays pending, asked again later.
    await transfers.sweep(new Date(Date.now() + 3 * 60_000));
    expect((await read(me, pending.id)).status).toBe(200);
    expect(body<TransferView>(await read(me, pending.id)).data!.status).toBe(
      'pending',
    );
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(row.checks).toBe(1);
    expect(row.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(
      w2wSeen().filter(
        (r) =>
          (r.body as { CustomerReference?: string }).CustomerReference ===
          pending.reference,
      ),
    ).toHaveLength(1);
  });

  it('Fintava saying FAILURE is the only way a lost-answer send fails: failed, the sender row failed, nothing for the receiver', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    wallets.mode = 'timeout';
    const res = await send(me, b);
    wallets.mode = 'live';
    const pending = body<TransferView>(res).data!;
    wallets.failures.add(pending.reference);
    await transfers.sweep(new Date(Date.now() + 3 * 60_000));
    const failed = body<TransferView>(await read(me, pending.id)).data!;
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: TRANSFER_FAILED_REASON,
      statusMessage: null,
    });
    expect(failed.timeline.map((t) => t.step)).toEqual(['requested', 'failed']);
    const rows = await ledgerRows(pending.reference);
    expect(rows.map((r) => `${r.direction}:${r.status}`)).toEqual([
      'out:failed',
    ]);
  });

  it('no answer past PAYMENT_REVIEW_AFTER_HOURS goes to review: still pending, out of the sweep', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    wallets.mode = 'error500';
    const pending = body<TransferView>(await send(me, b)).data!;
    wallets.mode = 'live';
    expect(pending.status).toBe('pending');
    await transfers.sweep(new Date(Date.now() + 80 * 3_600_000));
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.nextCheckAt).toBeNull();
    expect(row.discrepancy).toMatch(/no answer from Fintava after 72 hours/);
  });

  it('kill A: the Hub dies right after the provider took the money, before any write of ours: the answer is pending (never a 500), the sweep completes it, one transfer', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    jest
      .spyOn(
        transfers as unknown as { completeFromRecord: () => Promise<unknown> },
        'completeFromRecord',
      )
      .mockRejectedValueOnce(new Error('killed'));
    const res = await send(me, b, key);
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    expect(view.status).toBe('pending');
    expect(sendsFrom(me)).toHaveLength(1);
    jest.restoreAllMocks();
    await transfers.sweep(new Date(Date.now() + 3 * 60_000));
    const done = body<TransferView>(await read(me, view.id)).data!;
    expect(done.status).toBe('completed');
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(me)).toBe(1_000_000 - 203_325);
    expect(balance(to)).toBe(200_000);
    expect(
      (await ledgerRows(view.reference)).map(
        (r) => `${r.direction}:${r.status}`,
      ),
    ).toEqual(['in:completed', 'out:completed']);
    // And the key's repeat is the answer it stored, with no second send.
    const again = await send(me, b, key);
    expect(again.text).toBe(res.text);
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it("kill B: the Hub dies after the sender's row was completed and before the receiver's: the sweep writes the rest from the ledger, once", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const real = ledger.record.bind(ledger);
    let killed = false;
    jest
      .spyOn(ledger, 'record')
      .mockImplementation(async (input: LedgerMovementInput, ...rest) => {
        if (
          !killed &&
          input.direction === 'in' &&
          input.status === 'completed'
        ) {
          killed = true;
          throw new Error('killed');
        }
        return real(input, ...rest);
      });
    const res = await send(me, b);
    const view = body<TransferView>(res).data!;
    expect(killed).toBe(true);
    expect(view.status).toBe('pending');
    expect(
      (await ledgerRows(view.reference)).map(
        (r) => `${r.direction}:${r.status}`,
      ),
    ).toEqual(['out:completed']);
    jest.restoreAllMocks();
    // The ledger row alone settles the send (the ledger's listener path, no provider call).
    const status = await transfers.settle(view.id);
    expect(status).toBe('completed');
    expect(
      (await ledgerRows(view.reference)).map(
        (r) => `${r.direction}:${r.status}`,
      ),
    ).toEqual(['in:completed', 'out:completed']);
    expect(sendsFrom(me)).toHaveLength(1);
    expect(balance(to)).toBe(200_000);
  });

  it('completing is once and only from pending: a path that read the send pending cannot complete one another path has already moved on (reversed)', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const real = ledger.record.bind(ledger);
    let moved = false;
    jest
      .spyOn(ledger, 'record')
      .mockImplementation(async (input: LedgerMovementInput, ...rest) => {
        if (
          !moved &&
          input.direction === 'in' &&
          input.status === 'completed'
        ) {
          moved = true;
          // Another path (the sweep, a reversal) moves the send on while this
          // one is between reading it and completing it.
          await prisma.walletTransfer.updateMany({
            where: { customerReference: input.references.customerReference! },
            data: { status: 'reversed', reversedAt: new Date() },
          });
        }
        return real(input, ...rest);
      });
    const res = await send(me, b);
    jest.restoreAllMocks();
    expect(moved).toBe(true);
    const view = body<TransferView>(res).data!;
    expect(view.status).toBe('reversed');
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.status).toBe('reversed');
    expect(row.completedAt).toBeNull();
  });

  it('kill C: the Hub dies after completing the send and before storing the answer: the key answers "in progress", then, once the request can no longer be running, the completed send; one transfer', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    const keys = moduleRef.get(IdempotencyService);
    jest.spyOn(keys, 'finish').mockRejectedValueOnce(new Error('killed'));
    const res = await send(me, b, key);
    expect(res.status).toBe(500);
    jest.restoreAllMocks();
    const [row] = await transferRows(me);
    expect(row.status).toBe('completed');
    const busy = await send(me, b, key);
    expect(body(busy).reason?.code).toBe('idempotency_in_progress');
    await prisma.$executeRaw`
      UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - interval '10 minutes'
       WHERE "wawuUserId" = ${me.id} AND "key" = ${key}`;
    const answered = await send(me, b, key);
    expect(answered.status).toBe(201);
    expect(answered.headers['idempotent-replayed']).toBe('true');
    expect(body<TransferView>(answered).data).toMatchObject({
      id: row.id,
      status: 'completed',
      totalKobo: 203_325,
    });
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it("the ledger's status check completing the sender's row settles the send at once, receiver's side included", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    wallets.mode = 'timeout';
    const pending = body<TransferView>(await send(me, b)).data!;
    wallets.mode = 'live';
    expect(pending.status).toBe('pending');
    const [out] = (await ledgerRows(pending.reference)).filter(
      (r) => r.direction === 'out',
    );
    const checked = await statusChecks.check(
      out.id,
      new Date(Date.now() + 5 * 60_000),
    );
    expect(checked.status).toBe('completed');
    await until(async () => {
      const t = await prisma.walletTransfer.findUniqueOrThrow({
        where: { id: pending.id },
      });
      return t.status === 'completed';
    });
    expect(
      (await ledgerRows(pending.reference)).map(
        (r) => `${r.direction}:${r.status}`,
      ),
    ).toEqual(['in:completed', 'out:completed']);
    expect(sendsFrom(me)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The provider refusing, the provider down
  // -------------------------------------------------------------------------

  it('Fintava refusing the transfer is a failed send with nothing moved, kept for the key', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    const key = randomUUID();
    wallets.mode = 'refuse';
    const res = await send(me, b, key);
    wallets.mode = 'live';
    expect(res.status).toBe(201);
    expect(body<TransferView>(res).data).toMatchObject({
      status: 'failed',
      failureReason: TRANSFER_FAILED_REASON,
    });
    const again = await send(me, b, key);
    expect(again.text).toBe(res.text);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(balance(me)).toBe(1_000_000);
  });

  it('Fintava unreachable and the request provably never left: 503, the send failed, the key given back, and the same key then sends it as a new send, once', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    const key = randomUUID();
    // The request provably never left (a refused connection): the typed
    // answer the Fintava client gives for it (connection-never-opened.spec.ts
    // proves the classification from real sockets, the netns rig from a real
    // route failure).
    jest.spyOn(provider, 'walletToWallet').mockRejectedValueOnce(
      new WalletProviderError({
        kind: 'unavailable',
        provider: 'fintava',
        operation: 'wallet to wallet',
        recordMayExist: true,
        requestNotSent: true,
      }),
    );
    const res = await send(me, b, key);
    jest.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(body(res).reason?.code).toBe('provider_unreachable');
    const [first] = await transferRows(me);
    expect(first.status).toBe('failed');
    expect(sendsFrom(me)).toHaveLength(0);
    const ok = await send(me, b, key);
    expect(ok.status).toBe(201);
    const second = body<TransferView>(ok).data!;
    expect(second.status).toBe('completed');
    expect(second.reference).not.toBe(first.customerReference);
    expect(sendsFrom(me)).toHaveLength(1);
    expect(await transferRows(me)).toHaveLength(2);
  });

  it('Fintava moving another amount than asked: review, still pending, no ledger row of ours completed, nothing for the receiver', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 100_000);
    wallets.mode = 'wrongamount';
    const res = await send(me, b);
    wallets.mode = 'live';
    const view = body<TransferView>(res).data!;
    expect(view.status).toBe('pending');
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toMatch(/amountKobo 100000 vs 100100/);
    expect(
      (await ledgerRows(view.reference)).map(
        (r) => `${r.direction}:${r.status}`,
      ),
    ).toEqual(['out:pending']);
  });

  // -------------------------------------------------------------------------
  // What Fintava really took
  // -------------------------------------------------------------------------

  it('the sandbox charging ₦0 instead of the quoted ₦33.25 (a debit below the quote): sent, both rows complete at what Fintava took, the send records it with the difference, nothing flagged', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    wallets.mode = 'sandbox';
    const res = await send(me, b);
    wallets.mode = 'live';
    const view = body<TransferView>(res).data!;
    expect(view).toMatchObject({
      status: 'completed',
      totalKobo: 200_000,
      fee: { providerFeeKobo: 0, wawuFeeKobo: 0, totalFeeKobo: 0 },
    });
    expect(balance(me)).toBe(800_000);
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.discrepancy).toMatch(/debit differs from the quote/);
    expect(row.debitReviewSince).toBeNull();
    const [inn, out] = await ledgerRows(view.reference);
    expect([out.feeKobo, out.totalKobo, out.status]).toEqual([
      0n,
      200_000n,
      'completed',
    ]);
    expect([inn.feeKobo, inn.totalKobo, inn.status]).toEqual([
      0n,
      200_000n,
      'completed',
    ]);
  });

  it("the dashboard's merchant charge not set (Fintava takes ₦23.25, not ₦33.25): WAWU's fee is the part not collected, recorded as ₦0 with the difference", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    wallets.merchantCharge = 0;
    const view = body<TransferView>(await send(me, b)).data!;
    expect(view).toMatchObject({
      status: 'completed',
      totalKobo: 202_325,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 0, totalFeeKobo: 2325 },
    });
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.discrepancy).toMatch(/quoted 203325/);
  });

  it('Fintava charging more than quoted (a believable excess): completed at what it took, flagged for NUV-08; a charge nobody can believe is review, not completed', async () => {
    const me = await person(2_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    wallets.feeOverride = 5000;
    const high = body<TransferView>(await send(me, b)).data!;
    wallets.feeOverride = null;
    expect(high).toMatchObject({
      status: 'completed',
      totalKobo: 205_000,
      fee: { providerFeeKobo: 4000, wawuFeeKobo: 1000, totalFeeKobo: 5000 },
    });
    const flagged = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: high.id },
    });
    expect(flagged.debitReviewSince).not.toBeNull();
    expect(flagged.discrepancy).toMatch(/debit above the quote/);

    wallets.feeOverride = 3325 + 150_000;
    const absurd = body<TransferView>(await send(me, b)).data!;
    wallets.feeOverride = null;
    expect(absurd.status).toBe('pending');
    const held = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: absurd.id },
    });
    expect(held.reviewSince).not.toBeNull();
    expect(held.discrepancy).toMatch(/charge not trusted/);
    expect(
      (await ledgerRows(absurd.reference)).map(
        (r) => `${r.direction}:${r.status}`,
      ),
    ).toEqual(['out:pending']);
  });

  // -------------------------------------------------------------------------
  // Reading one send
  // -------------------------------------------------------------------------

  it("another person's send, an unknown id and a bad id: the same 404 / a plain 400; no wallet is the gate's 409", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const other = await person(0);
    const view = body<TransferView>(
      await send(me, await ready(me, to, 100_000)),
    ).data!;
    for (const p of [to, other]) {
      const res = await read(p, view.id);
      expect(res.status).toBe(404);
      expect(body(res).reason).toMatchObject({ code: 'not_found' });
    }
    const unknown = await read(me, randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.text.replace(/\s/g, '')).toBe(
      (await read(other, view.id)).text.replace(/\s/g, ''),
    );
    expect((await read(me, 'nope')).status).toBe(400);
    const stranger = {
      id: randomUUID(),
      auth: `Bearer ${mintToken(randomUUID())}`,
    } as Person;
    const nowallet = await read(stranger, view.id);
    expect(nowallet.status).toBe(409);
    expect(body(nowallet).reason?.code).toBe('wallet_not_open');
    const gated = await send(stranger, await ready(me, to, 100_000));
    expect(gated.status).toBe(409);
    expect(body(gated).reason?.code).toBe('wallet_not_open');
    expect((await read(me, view.id)).headers['cache-control']).toBe('no-store');
  });

  // -------------------------------------------------------------------------
  // The books
  // -------------------------------------------------------------------------

  it('twenty sends in a row: every balance at Fintava equals the start minus what each send took, and the ledger rows add up to the same', async () => {
    const me = await person(5_000_000);
    const them = await Promise.all(Array.from({ length: 4 }, () => person(0)));
    for (let i = 0; i < 20; i += 1) {
      const amount = 100_000 + i * 700;
      const res = await send(me, await ready(me, them[i % 4], amount));
      expect(res.status).toBe(201);
    }
    const sent = sendsFrom(me);
    expect(sent).toHaveLength(20);
    const spent = sent.reduce((n, s) => n + s.amountKobo + s.feeKobo, 0);
    expect(balance(me)).toBe(5_000_000 - spent);
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: {
        wawuUserId: me.id,
        walletKind: 'user',
        direction: 'out',
        category: 'transfer',
      },
    });
    expect(rows).toHaveLength(20);
    expect(rows.reduce((n, r) => n + r.totalKobo, 0n)).toBe(BigInt(spent));
    for (const p of them) {
      const inRows = await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: p.id, direction: 'in', status: 'completed' },
      });
      expect(inRows.reduce((n, r) => n + r.totalKobo, 0n)).toBe(
        BigInt(balance(p)!),
      );
    }
  });

  it("deleting either person keeps the send for the other, with the deleted side anonymised (the sender's note goes with the sender)", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const view = body<TransferView>(
      await send(me, await ready(me, to, 100_000, { note: 'private words' })),
    ).data!;
    const purge = new AccountPurgeService(prisma);
    await purge.purge(me.id);
    const afterPayer = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(afterPayer).toMatchObject({
      payerWawuUserId: null,
      payerAccountNumber: null,
      payerName: null,
      note: null,
      recipientWawuUserId: to.id,
      recipientAccountNumber: to.accountNumber,
    });
    await purge.purge(to.id);
    const afterBoth = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(afterBoth).toMatchObject({
      payerWawuUserId: null,
      recipientWawuUserId: null,
      recipientAccountNumber: null,
      recipientName: null,
      amountKobo: 100_000n,
    });
  });

  it('no answer of any send route carried a phone number, and the provider only ever saw our reference and a neutral narration', () => {
    expect(seenTexts.length).toBeGreaterThan(20);
    for (const t of seenTexts) expect(t).not.toMatch(PHONE_SHAPE);
    const narrations = new Set(
      w2wSeen().map(
        (r) =>
          (r.body as { narration?: string; description?: string }).narration ??
          (r.body as { description?: string }).description,
      ),
    );
    for (const n of narrations) {
      expect([TRANSFER_NARRATION, undefined]).toContain(n);
    }
    // No log line carries a PIN.
    expect(logsCarryPin(logger.lines, WRONG_PIN)).toBe(false);
  });
});

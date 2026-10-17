import { randomUUID } from 'node:crypto';
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
  NAME_ENQUIRY,
  recordByReference,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FintavaWebhookModule } from '../../../fintava/webhook/fintava-webhook.module';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../../fintava/webhook/fintava-signature';
import { LedgerConsumerService } from '../../ledger/ledger-consumer.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { LedgerService } from '../../ledger/ledger.service';
import { IDEMPOTENT_REPLAYED_HEADER } from '../../payments/idempotency';
import { MoneyModule } from '../../money.module';
import type {
  AccountNameView,
  BankView,
  BeneficiaryView,
  FeeQuoteView,
  PinStateView,
  TransferView,
} from '../../money-view.type';
import { bvnNameKeys } from '../../identity/bvn-name';
import { IdentityHasher } from '../../identity/identity-config';
import { BankAccountCheckService } from '../../saved-accounts/bank-account-check.service';
import { NameCheckBudget } from '../../saved-accounts/name-check-budget';
import { NameCheckTokenService } from '../../saved-accounts/name-check-token.service';
import { MoneyError } from '../../money-error';
import { ACCOUNT_CHANGED_MESSAGE } from '../bank-send-target';
import {
  SEND_STILL_CONFIRMING_MESSAGE,
  TRANSFER_NARRATION,
  WalletTransferService,
} from '../wallet-transfer.service';

/**
 * Send money to a bank account (task WALLET-09) over HTTP: the real
 * MoneyModule, a real database, real RS256 tokens against the stand-in WAWU
 * ID, and the real MONEY-06 Fintava client over a socket to FintavaDouble,
 * which plays Fintava's bank list, name enquiry, `POST /bank/credit` and
 * record by reference with the sandbox's bodies. Payouts do not work in the
 * live sandbox yet (docs/fintava/sandbox/README.md, "The blocker"), so the
 * double stands in for what they will answer; nothing here reaches the
 * internet.
 *
 * It charges the dashboard's ₦40 for a bank send AND the ₦25 "Merchant
 * charge" WAWU's fee is set to (R-10), both taken from the sender in the one
 * transfer.
 */

const BASE = '/api/hub/money';
const MONEY_TIMEOUT_MS = 120_000;
const PROVIDER_FEE = 4000;
const WAWU_FEE = 2500;
const FEE = PROVIDER_FEE + WAWU_FEE;
/** WAWU's own per transaction limit for a bank send, a spec value (₦100,000). */
const PER_TXN_LIMIT_KOBO = 10_000_000;
const DAILY_LIMIT_KOBO = 4_000_000;

/** Signs the stand-in webhook deliveries of the FIX-41 cases (a spec value). */
const WEBHOOK_SECRET = 'whsec_local_fix41_Hk4Rz8Wq2Np6Ty1Lb';

const GTB = { code: '000013', name: 'GUARANTY TRUST BANK' };
const ACCESS = { code: '000014', name: 'ACCESS BANK' };

jest.setTimeout(300_000);

class Bank {
  /** The bank's holders: `code:number` to the name the bank gives. */
  readonly holders = new Map<string, string>();
  readonly sends: Array<{
    from: string;
    accountNumber: string;
    accountName: string;
    sortCode: string;
    amountKobo: number;
    feeKobo: number;
    reference: string;
  }> = [];
  readonly references = new Set<string>();
  readonly kobo = new Map<string, number>();
  readonly byId = new Map<string, string>();
  readonly byCustomer = new Map<string, string>();
  readonly failures = new Set<string>();
  readonly hidden = new Set<string>();
  mode: 'live' | 'timeout' | 'refuse' = 'live';
  /** Fintava's refusal text for every send, when set (a business 400). */
  refuseWith: string | null = null;
}

describe('Send to a bank account (WALLET-09) over HTTP', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transfers: WalletTransferService;
  let ledger: LedgerService;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const bank = new Bank();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let seq = 0;

  type Person = {
    id: string;
    auth: string;
    walletId: string;
    accountNumber: string;
    customerId: string;
  };

  const holderKey = (code: string, number: string) => `${code}:${number}`;
  let accountSeq = 0;
  /** A bank account number nobody else in the file uses, known to the bank under `name`. */
  function account(name: string, code = GTB.code): string {
    accountSeq += 1;
    const number = `22${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    bank.holders.set(holderKey(code, number), name);
    return number;
  }

  async function person(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    seq += 1;
    const accountNumber = `19${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
    const walletId = randomUUID();
    const customerId = randomUUID();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId,
        walletId,
        accountNumber,
        accountName: `Sender ${seq}`,
      },
    });
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `w09-${id.slice(0, 8)}`,
      },
    });
    await prisma.transactionPin.create({
      data: { wawuUserId: id, pinHash: cheapPinHash },
    });
    bank.kobo.set(accountNumber, kobo);
    bank.byId.set(walletId, accountNumber);
    bank.byCustomer.set(customerId, accountNumber);
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      walletId,
      accountNumber,
      customerId,
    };
  }

  async function quoted(p: Person, amountKobo: number): Promise<FeeQuoteView> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/fees/quote?kind=bank_transfer&amountKobo=${amountKobo}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return body<FeeQuoteView>(res).data!;
  }

  /**
   * FIX-41: a send to an account that is not saved must carry the `nameToken`
   * of the name check the person saw, so the helper does what the app does:
   * it checks the name first and sends the token with the body. A test that
   * wants another token, or none, puts the key `nameToken` in the body
   * itself (`nameToken: undefined` is "none").
   */
  const tokenOfBody = new WeakMap<object, string>();
  async function send(
    p: Person,
    payload: Record<string, unknown>,
    key: string | null = randomUUID(),
    pin: string | null = PIN,
  ): Promise<Response> {
    let sendable = payload;
    const known = tokenOfBody.get(payload);
    if (known !== undefined) sendable = { ...payload, nameToken: known };
    else if (
      !('nameToken' in payload) &&
      typeof payload.bankCode === 'string' &&
      /^\d{3,6}$/.test(payload.bankCode) &&
      typeof payload.accountNumber === 'string' &&
      /^\d{10}$/.test(payload.accountNumber)
    ) {
      const checked = await request(app.getHttpServer())
        .post(`${BASE}/banks/name-check`)
        .set('Authorization', p.auth)
        .send({
          bankCode: payload.bankCode,
          accountNumber: payload.accountNumber,
        });
      if (checked.status === 200) {
        const nameToken = body<AccountNameView>(checked).data!.nameToken;
        // The same body object is the same send: a repeat carries the same token.
        tokenOfBody.set(payload, nameToken);
        sendable = { ...payload, nameToken };
      }
    }
    let req = request(app.getHttpServer())
      .post(`${BASE}/transfers/bank`)
      .set('Authorization', p.auth);
    if (key !== null) req = req.set('Idempotency-Key', key);
    if (pin !== null) req = req.set('X-Transaction-Pin', pin);
    return req.send(sendable);
  }

  function sendBody(
    q: FeeQuoteView,
    to: { code?: string; number: string },
    extra: Record<string, unknown> = {},
  ) {
    return {
      bankCode: to.code ?? GTB.code,
      accountNumber: to.number,
      amountKobo: q.amountKobo,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
      ...extra,
    };
  }

  async function ready(
    p: Person,
    to: { code?: string; number: string },
    amountKobo: number,
    extra: Record<string, unknown> = {},
  ) {
    return sendBody(await quoted(p, amountKobo), to, extra);
  }

  const read = (p: Person, id: string) =>
    request(app.getHttpServer())
      .get(`${BASE}/transfers/${id}`)
      .set('Authorization', p.auth);
  const sendsFrom = (p: Person) =>
    bank.sends.filter((s) => s.from === p.accountNumber);
  const creditCalls = () =>
    double.seen.filter((r) => r.path === '/bank/credit');
  const balance = (p: Person) => bank.kobo.get(p.accountNumber);
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });

  async function triesLeft(p: Person): Promise<number> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/pin`)
      .set('Authorization', p.auth);
    return body<PinStateView>(res).data!.triesLeft;
  }

  function recordFor(ref: string, status: string, amount: string) {
    const r = recordByReference(ref, status, amount);
    return { ...r, data: { ...r.data, transType: 'AATRANSFER' } };
  }

  function installFintava() {
    double.reset();
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    double.on('GET', '/banks', {
      status: 200,
      body: {
        status: 200,
        message: 'bank lists fetched successfully',
        data: [GTB, ACCESS, { code: '090620', name: 'LOMA BANK' }].map((b) => ({
          id: b.code,
          createdAt: 'x',
          updatedAt: 'x',
          code: b.code,
          name: b.name,
        })),
      },
    });
    double.on('GET', '/name/enquiry', (req: SeenRequest) => {
      const name = bank.holders.get(
        holderKey(req.query.sortCode, req.query.accountNumber),
      );
      if (!name) {
        return {
          status: 200,
          body: {
            ...NAME_ENQUIRY,
            data: {
              status: false,
              account: {
                bankCode: req.query.sortCode,
                accountName: null,
                accountNumber: req.query.accountNumber,
                responseCode: '07',
              },
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          ...NAME_ENQUIRY,
          data: {
            status: true,
            account: {
              bankCode: req.query.sortCode,
              accountName: name,
              accountNumber: req.query.accountNumber,
              responseCode: '00',
            },
          },
        },
      };
    });
    double.on('GET', /^\/customer\/wallet\/balance\//, (req: SeenRequest) => {
      const account = bank.byId.get(req.path.split('/').pop()!);
      if (!account) {
        return { status: 400, body: fintavaError(400, 'Wallet not found') };
      }
      const naira = (bank.kobo.get(account) ?? 0) / 100;
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
      const found = bank.sends.find((x) => x.reference === ref);
      if (!found || bank.hidden.has(ref)) {
        return {
          status: 404,
          body: fintavaError(404, 'Transaction not found!'),
        };
      }
      return {
        status: 200,
        body: recordFor(
          ref,
          bank.failures.has(ref) ? 'FAILURE' : 'SUCCESS',
          (found.amountKobo / 100).toFixed(2),
        ),
      };
    });
    double.on('POST', '/bank/credit', (req: SeenRequest) => {
      const b = req.body as {
        sourceId: string;
        accountNumber: string;
        accountName: string;
        sortCode: string;
        amount: number;
        CustomerReference: string;
      };
      if (bank.mode === 'refuse') {
        return {
          status: 400,
          body: fintavaError(400, 'Transfer could not be processed'),
        };
      }
      if (bank.refuseWith !== null) {
        return { status: 400, body: fintavaError(400, bank.refuseWith) };
      }
      const from = bank.byCustomer.get(b.sourceId)!;
      const amountKobo = Math.round(b.amount * 100);
      const have = bank.kobo.get(from) ?? 0;
      // Fintava refuses a send the wallet cannot cover (sandbox/13-, for a
      // wallet send; the bank send reads the same balance first).
      if (have < amountKobo + FEE) {
        return {
          status: 400,
          body: fintavaError(
            400,
            'Insufficient balance on source wallet to complete this transfer.',
          ),
        };
      }
      // The money leaves when Fintava takes the request, whether or not the
      // answer reaches the caller in time.
      bank.references.add(b.CustomerReference);
      bank.kobo.set(from, have - amountKobo - FEE);
      bank.sends.push({
        from,
        accountNumber: b.accountNumber,
        accountName: b.accountName,
        sortCode: b.sortCode,
        amountKobo,
        feeKobo: FEE,
        reference: b.CustomerReference,
      });
      const after = (have - amountKobo - FEE) / 100;
      return {
        status: 200,
        hangUp: bank.mode === 'timeout',
        body: {
          data: {
            id: randomUUID(),
            amount: amountKobo / 100,
            reference: `tagapay${randomUUID().replace(/-/g, '')}`,
            customerReference: randomUUID(),
            total: (amountKobo + FEE) / 100,
            transaction_fee: FEE / 100,
            source_customer_accno: from,
            source_availableBalance: after,
            source_bookedBalance: after,
            description: 'Transfer to bank',
          },
          status: 200,
          message: 'successful',
        },
      };
    });
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
      FINTAVA_API_KEY: 'live_test_w09_bank_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'w09-test-fee-quote-key-0123456789abcdef0123',
      // WALLET-37: a person's BVN name is compared as keyed hashes.
      IDENTITY_HASH_KEY: 'w37-test-identity-hash-key-0123456789abcdef',
      WAWU_LIMIT_BANK_TRANSFER_PER_TRANSACTION_KOBO: String(PER_TXN_LIMIT_KOBO),
      // The provider's daily limit for the wallet's tier, a spec value (₦40,000).
      FINTAVA_TIER_DAILY_LIMITS_KOBO: `TIER_2:${DAILY_LIMIT_KOBO}`,
      FINTAVA_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    installFintava();
    moduleRef = await Test.createTestingModule({
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
    app = moduleRef.createNestApplication<INestApplication<App>>({
      ...HUB_APP_OPTIONS,
      logger,
    });
    app.useLogger(logger);
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
    await app.init();
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    transfers = moduleRef.get(WalletTransferService);
    ledger = moduleRef.get(LedgerService);
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletTransfer.findMany({
        where: { payerWawuUserId: { in: users } },
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
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.moneyBeneficiary.deleteMany({
        where: { ownerWawuId: { in: users } },
      });
      await prisma.moneyPayoutAccount.deleteMany({
        where: { wawuUserId: { in: users } },
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
    bank.mode = 'live';
    bank.refuseWith = null;
    double.seen.length = 0;
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The bank list and the name check
  // -------------------------------------------------------------------------

  it('serves the bank list as one unpaged array keyed on code, and the holder name the bank gives', async () => {
    const me = await person(0);
    const list = await request(app.getHttpServer())
      .get(`${BASE}/banks`)
      .set('Authorization', me.auth);
    expect(list.status).toBe(200);
    const banks = body<BankView[]>(list).data!;
    expect(banks).toEqual([
      { code: GTB.code, name: GTB.name },
      { code: ACCESS.code, name: ACCESS.name },
      { code: '090620', name: 'LOMA BANK' },
    ]);

    const number = account('SIMI MICHELLE');
    const checked = await request(app.getHttpServer())
      .post(`${BASE}/banks/name-check`)
      .set('Authorization', me.auth)
      .send({ bankCode: GTB.code, accountNumber: number });
    expect(checked.status).toBe(200);
    const shown = body<AccountNameView>(checked).data!;
    expect(shown).toMatchObject({
      bankCode: GTB.code,
      bankName: GTB.name,
      accountNumber: number,
      accountName: 'SIMI MICHELLE',
    });
    expect(Object.keys(shown).sort()).toEqual([
      'accountName',
      'accountNumber',
      'bankCode',
      'bankName',
      'nameToken',
    ]);
    expect(typeof shown.nameToken).toBe('string');

    // An account the bank does not know: 422 with the contract's code; and
    // no sign-in is no answer at all.
    const missing = await request(app.getHttpServer())
      .post(`${BASE}/banks/name-check`)
      .set('Authorization', me.auth)
      .send({ bankCode: GTB.code, accountNumber: '0000000001' });
    expect(missing.status).toBe(422);
    expect(body(missing).reason?.code).toBe('name_check_failed');
    const anonymous = await request(app.getHttpServer())
      .post(`${BASE}/banks/name-check`)
      .send({ bankCode: GTB.code, accountNumber: number });
    expect(anonymous.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // The task's capability checks
  // -------------------------------------------------------------------------

  it('check 3: a ₦25,000 bank send shows ₦40 + ₦25 = ₦65 and debits ₦25,065; Fintava holds the same, and the send is to the name the bank gave', async () => {
    const me = await person(5_000_000);
    const number = account('SIMI MICHELLE');
    const q = await quoted(me, 2_500_000);
    expect(q).toMatchObject({
      kind: 'bank_transfer',
      amountKobo: 2_500_000,
      fee: { providerFeeKobo: 4000, wawuFeeKobo: 2500, totalFeeKobo: 6500 },
      totalKobo: 2_506_500,
    });

    const res = await send(
      me,
      sendBody(q, { number }, { note: 'Rent for October' }),
    );
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    expect(view).toMatchObject({
      kind: 'bank_account',
      status: 'completed',
      amountKobo: 2_500_000,
      fee: { providerFeeKobo: 4000, wawuFeeKobo: 2500, totalFeeKobo: 6500 },
      totalKobo: 2_506_500,
      note: 'Rent for October',
      toWawuUser: null,
      toBankAccount: {
        bankCode: GTB.code,
        bankName: GTB.name,
        accountNumber: number,
        accountName: 'SIMI MICHELLE',
      },
      failureReason: null,
      reversal: null,
      statusMessage: null,
    });
    expect(view.reference).toBe(`wawu-bank-${view.id}`);
    expect(view.timeline.map((t) => t.step)).toEqual([
      'requested',
      'sent_to_bank',
      'completed',
    ]);

    // Fintava holds one send of the amount, to the name the bank gave, and
    // the wallet fell by exactly the quoted total.
    expect(sendsFrom(me)).toEqual([
      {
        from: me.accountNumber,
        accountNumber: number,
        accountName: 'SIMI MICHELLE',
        sortCode: GTB.code,
        amountKobo: 2_500_000,
        feeKobo: 6500,
        reference: view.reference,
      },
    ]);
    expect(balance(me)).toBe(5_000_000 - 2_506_500);
    expect((creditCalls()[0].body as { narration: string }).narration).toBe(
      TRANSFER_NARRATION,
    );

    // Our record: the sender's row only, completed at the quoted figures,
    // naming the bank account; no receiver's row exists.
    const rows = await ledgerRows(view.reference);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'out',
      status: 'completed',
      category: 'transfer',
      counterpartyKind: 'bank_account',
      counterpartyName: 'SIMI MICHELLE',
      counterpartyAccountNumber: number,
      counterpartyBankCode: GTB.code,
      counterpartyBankName: GTB.name,
      amountKobo: 2_500_000n,
      feeKobo: 6500n,
      providerFeeKobo: 4000n,
      wawuFeeKobo: 2500n,
      totalKobo: 2_506_500n,
      transferId: view.id,
    });
    expect(view.transactionId).toBe(rows[0].id);

    // The poll answers the same send.
    const polled = body<TransferView>(await read(me, view.id)).data!;
    expect(polled.status).toBe('completed');
    expect(polled.toBankAccount?.accountName).toBe('SIMI MICHELLE');
  });

  it('check 1: the account name is confirmed before the send: an account the bank does not confirm is refused before the PIN, sends nothing and gives the key back', async () => {
    const me = await person(5_000_000);
    const q = await quoted(me, 100_000);
    const key = randomUUID();
    const triesBefore = await triesLeft(me);
    const wrong = {
      bankCode: GTB.code,
      accountNumber: '0000000002',
      amountKobo: q.amountKobo,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
    };
    // A wrong PIN does not matter: the account is answered first.
    const res = await send(me, wrong, key, WRONG_PIN);
    expect(res.status).toBe(422);
    expect(body(res).reason?.code).toBe('name_check_failed');
    expect(await triesLeft(me)).toBe(triesBefore);
    expect(creditCalls()).toHaveLength(0);
    expect(
      await prisma.walletTransfer.count({ where: { payerWawuUserId: me.id } }),
    ).toBe(0);
    expect(balance(me)).toBe(5_000_000);

    // The key came back: the same key sends a real account.
    const number = account('ADA OBI');
    const ok = await send(me, { ...wrong, accountNumber: number }, key);
    expect(ok.status).toBe(201);
    expect(body<TransferView>(ok).data?.status).toBe('completed');
  });

  it('check 2: a send the provider answers as failed arrives as a reversal and the send is reversed once', async () => {
    const me = await person(5_000_000);
    const number = account('CHIDI EZE');
    bank.mode = 'refuse';
    const b = await ready(me, { number }, 100_000);
    // Fintava refuses the transfer but may still hold a pending record under
    // our reference: the send is pending, not failed, until Fintava says.
    const res = await send(me, b);
    expect(res.status).toBe(201);
    const pending = body<TransferView>(res).data!;
    expect(pending).toMatchObject({
      status: 'pending',
      statusMessage: SEND_STILL_CONFIRMING_MESSAGE,
    });
    expect(pending.timeline.map((t) => t.step)).toEqual(['requested']);
    expect(creditCalls()).toHaveLength(1);

    // Fintava's record shows the transfer, and FAILURE.
    bank.sends.push({
      from: me.accountNumber,
      accountNumber: number,
      accountName: 'CHIDI EZE',
      sortCode: GTB.code,
      amountKobo: 100_000,
      feeKobo: FEE,
      reference: pending.reference,
    });
    bank.failures.add(pending.reference);
    await transfers.sweep(new Date(Date.now() + 3_600_000));
    const failed = body<TransferView>(await read(me, pending.id)).data!;
    expect(failed).toMatchObject({ status: 'failed', reversal: null });
    // WALLET-09 round 2: a send that failed was never "sent to the bank".
    expect(failed.timeline.map((t) => t.step)).toEqual(['requested', 'failed']);

    // The reversal arrives: the debit is returned in full, the send follows
    // the ledger to `reversed`, and a second report changes nothing.
    const reversal = {
      references: [pending.reference],
      reversalReference: `r-${pending.id}`,
      amountKobo: 100_000,
      chargesKobo: FEE,
      totalKobo: 100_000 + FEE,
      at: new Date(),
    };
    const first = await ledger.applyReversal(reversal);
    expect(first).toMatchObject({ state: 'applied', changed: true });
    await until(
      async () =>
        body<TransferView>(await read(me, pending.id)).data!.status ===
        'reversed',
    );
    const reversed = body<TransferView>(await read(me, pending.id)).data!;
    expect(reversed.reversal).toMatchObject({
      returnedKobo: 100_000 + FEE,
      keptKobo: 0,
    });
    expect(reversed.timeline.map((t) => t.step)).toEqual([
      'requested',
      'reversed',
    ]);
    const again = await ledger.applyReversal(reversal);
    expect(again).toMatchObject({ state: 'applied', changed: false });
    expect(await ledgerRows(pending.reference)).toHaveLength(1);
    expect(creditCalls()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Before money moves
  // -------------------------------------------------------------------------

  it('the same key and body twice is one send (Idempotent-Replayed), and a wrong total is quote_changed with the new quote', async () => {
    const me = await person(5_000_000);
    const number = account('KEMI ADE');
    const b = await ready(me, { number }, 200_000);
    const key = randomUUID();
    const first = await send(me, b, key);
    const second = await send(me, b, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(body<TransferView>(second).data?.id).toBe(
      body<TransferView>(first).data?.id,
    );
    expect(creditCalls()).toHaveLength(1);

    const stale = await send(me, {
      ...b,
      expectedTotalKobo: b.expectedTotalKobo - 1,
    });
    expect(stale.status).toBe(409);
    expect(body(stale).reason?.code).toBe('quote_changed');
    expect(body(stale).reason?.feeQuote?.totalKobo).toBe(b.expectedTotalKobo);
    expect(creditCalls()).toHaveLength(1);
  });

  it('not enough in the wallet is 402 with the real figures; nothing is claimed or sent', async () => {
    const me = await person(200_000);
    const number = account('TUNDE BELLO');
    const b = await ready(me, { number }, 200_000);
    const res = await send(me, b);
    expect(res.status).toBe(402);
    expect(body(res).reason).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: 200_000,
      totalKobo: 200_000 + FEE,
      shortfallKobo: FEE,
    });
    expect(creditCalls()).toHaveLength(0);
    expect(
      await prisma.walletTransfer.count({ where: { payerWawuUserId: me.id } }),
    ).toBe(0);
  });

  it("WALLET-23: WAWU's per transaction limit and the provider's daily limit refuse a bank send before anything is sent", async () => {
    const me = await person(50_000_000);
    const number = account('FEMI KOLA');
    const big = await ready(me, { number }, PER_TXN_LIMIT_KOBO + 100_000);
    const over = await send(me, big);
    expect(over.status).toBe(403);
    expect(body(over).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'per_transaction',
    });

    // ₦25,000 fits the account's daily limit once; the second passes it.
    const ok = await send(me, await ready(me, { number }, 2_500_000));
    expect(ok.status).toBe(201);
    const second = await send(me, await ready(me, { number }, 2_500_000));
    expect(second.status).toBe(403);
    expect(body(second).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
    });
    expect(creditCalls()).toHaveLength(1);
  });

  it("a send to your own wallet at the provider's own bank is self_transfer", async () => {
    const me = await person(5_000_000);
    const b = await ready(
      me,
      { code: '090620', number: me.accountNumber },
      100_000,
    );
    const res = await send(me, b);
    expect(res.status).toBe(400);
    expect(body(res).reason?.code).toBe('self_transfer');
    expect(creditCalls()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // A saved account whose bank or holder is not the one kept
  // -------------------------------------------------------------------------

  it('a saved account whose holder changed is account_name_changed with both names, sends nothing, and is sent to after the person confirms it', async () => {
    const me = await person(5_000_000);
    const number = account('OLD HOLDER');
    const saved = await request(app.getHttpServer())
      .post(`${BASE}/beneficiaries`)
      .set('Authorization', me.auth)
      .send({
        kind: 'bank_account',
        bankCode: GTB.code,
        accountNumber: number,
      });
    expect(saved.status).toBe(201);
    expect(body<BeneficiaryView>(saved).data?.bankAccount?.accountName).toBe(
      'OLD HOLDER',
    );

    // Unchanged: the saved account is sent to as it is kept.
    const fine = await send(me, await ready(me, { number }, 100_000));
    expect(fine.status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(1);

    // The bank now names someone else for the number.
    bank.holders.set(holderKey(GTB.code, number), 'NEW HOLDER');
    const triesBefore = await triesLeft(me);
    const changed = await send(
      me,
      await ready(me, { number }, 100_000),
      randomUUID(),
      WRONG_PIN,
    );
    expect(changed.status).toBe(409);
    expect(body(changed).reason).toMatchObject({
      code: 'account_name_changed',
      message: ACCOUNT_CHANGED_MESSAGE,
      accountName: 'NEW HOLDER',
      bankName: GTB.name,
    });
    expect(await triesLeft(me)).toBe(triesBefore);
    expect(sendsFrom(me)).toHaveLength(1);

    // Saving it again WITHOUT the confirmation keeps the old name, as before.
    const kept = await request(app.getHttpServer())
      .post(`${BASE}/beneficiaries`)
      .set('Authorization', me.auth)
      .send({
        kind: 'bank_account',
        bankCode: GTB.code,
        accountNumber: number,
      });
    expect(body<BeneficiaryView>(kept).data?.bankAccount?.accountName).toBe(
      'OLD HOLDER',
    );
    // Confirming the name the bank gives now keeps it.
    const confirmed = await request(app.getHttpServer())
      .post(`${BASE}/beneficiaries`)
      .set('Authorization', me.auth)
      .send({
        kind: 'bank_account',
        bankCode: GTB.code,
        accountNumber: number,
        confirmCurrentName: true,
      });
    expect(confirmed.status).toBe(201);
    expect(
      body<BeneficiaryView>(confirmed).data?.bankAccount?.accountName,
    ).toBe('NEW HOLDER');

    const after = await send(me, await ready(me, { number }, 100_000));
    expect(after.status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(2);
    expect(sendsFrom(me)[1].accountName).toBe('NEW HOLDER');
  });

  // -------------------------------------------------------------------------
  // An answer that was lost
  // -------------------------------------------------------------------------

  it("a lost answer is pending, is never sent again, and is settled from Fintava's record by our reference", async () => {
    const me = await person(5_000_000);
    const number = account('LOST ANSWER');
    bank.mode = 'timeout';
    const b = await ready(me, { number }, 300_000);
    const key = randomUUID();
    const res = await send(me, b, key);
    expect(res.status).toBe(201);
    const pending = body<TransferView>(res).data!;
    expect(pending).toMatchObject({
      status: 'pending',
      completedAt: null,
      statusMessage: SEND_STILL_CONFIRMING_MESSAGE,
    });
    expect(creditCalls()).toHaveLength(1);
    expect(balance(me)).toBe(5_000_000 - 300_000 - FEE);
    const rows = await ledgerRows(pending.reference);
    expect(rows.map((r) => `${r.direction}:${r.status}`)).toEqual([
      'out:pending',
    ]);

    // The same key answers the same pending send; Fintava is not asked again.
    bank.mode = 'live';
    const again = await send(me, b, key);
    expect(body<TransferView>(again).data?.id).toBe(pending.id);
    expect(creditCalls()).toHaveLength(1);

    // Fintava's record lags: still pending. Then it shows SUCCESS.
    bank.hidden.add(pending.reference);
    await transfers.sweep(new Date(Date.now() + 3_600_000));
    expect(body<TransferView>(await read(me, pending.id)).data?.status).toBe(
      'pending',
    );
    bank.hidden.delete(pending.reference);
    await transfers.sweep(new Date(Date.now() + 2 * 3_600_000));
    const done = body<TransferView>(await read(me, pending.id)).data!;
    expect(done).toMatchObject({
      status: 'completed',
      totalKobo: 300_000 + FEE,
    });
    expect(done.timeline.map((t) => t.step)).toEqual([
      'requested',
      'sent_to_bank',
      'completed',
    ]);
    expect(creditCalls()).toHaveLength(1);
  });
  // -------------------------------------------------------------------------
  // Round 2 (the verifier's findings 1, 2, 3 and 6)
  // -------------------------------------------------------------------------

  const nameCheck = (p: Person, bankCode: string, accountNumber: string) =>
    request(app.getHttpServer())
      .post(`${BASE}/banks/name-check`)
      .set('Authorization', p.auth)
      .send({ bankCode, accountNumber });
  const providerCalls = () =>
    double.seen.filter(
      (r) => r.path === '/bank/credit' || r.path === '/name/enquiry',
    );

  it('finding 1: a malformed account number or bank code is the route 400 before anything runs: nothing sent, no PIN try used, the key given back', async () => {
    const me = await person(5_000_000);
    const number = account('MALFORMED');
    const good = await ready(me, { number }, 100_000);
    const key = randomUUID();
    const tries = await triesLeft(me);
    const forms: Array<[string, Record<string, unknown>, string[]?]> = [
      ['9 digits', { accountNumber: '123456789' }],
      ['11 digits', { accountNumber: '12345678901' }],
      ['letters', { accountNumber: '12345abcde' }],
      ['digits and a space', { accountNumber: '1234 56789' }],
      ['a number, not text', { accountNumber: 2212345678 }],
      ['null account', { accountNumber: null }],
      ['a list', { accountNumber: [number] }],
      ['an object', { accountNumber: { n: number } }],
      ['an empty bank code', { bankCode: '' }],
      ['an odd bank code', { bankCode: "000013' OR 1=1" }],
      ['a one digit bank code', { bankCode: '1' }],
      ['a bank code that is a number', { bankCode: 13 }],
      ['a null bank code', { bankCode: null }],
      ['a bank code object', { bankCode: {} }],
      ['no account number', {}, ['accountNumber']],
      ['no bank code', {}, ['bankCode']],
      ['neither', {}, ['bankCode', 'accountNumber']],
    ];
    for (const [label, patch, drop] of forms) {
      const payload: Record<string, unknown> = { ...good, ...patch };
      for (const k of drop ?? []) delete payload[k];
      // A wrong PIN: if the PIN guard ran, a try would be used.
      const res = await send(me, payload, key, WRONG_PIN);
      expect([label, res.status]).toEqual([label, 400]);
      expect(body(res).reason).toBeUndefined();
      expect(typeof body(res).message).toBe('string');
      expect(
        res.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
      ).toBeUndefined();
    }
    expect(providerCalls()).toHaveLength(0);
    expect(await triesLeft(me)).toBe(tries);
    expect(
      await prisma.walletTransfer.count({ where: { payerWawuUserId: me.id } }),
    ).toBe(0);
    // The key was given back every time: the good body under it is a send.
    const ok = await send(me, good, key);
    expect(ok.status).toBe(201);
    expect(
      ok.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
    ).toBeUndefined();
    expect(creditCalls()).toHaveLength(1);
  });

  it.each([
    [
      'insufficient funds',
      'Insufficient balance on source wallet to complete this transfer.',
      402,
      'insufficient_funds',
    ],
    [
      'a frozen wallet',
      'Kindly confirm both customer accounts are active',
      423,
      'wallet_frozen',
    ],
    [
      'payouts blocked',
      'Unable to find customers',
      503,
      'provider_unreachable',
    ],
  ])(
    'finding 2: a refusal Fintava makes before any transfer exists (%s) fails the send, voids the pending ledger row, gives the key back and answers its own error',
    async (label, text, status, code) => {
      const me = await person(5_000_000);
      const number = account(`REFUSED ${label}`);
      const b = await ready(me, { number }, 100_000);
      const key = randomUUID();
      bank.refuseWith = text;
      const res = await send(me, b, key);
      expect([label, res.status, body(res).reason?.code]).toEqual([
        label,
        status,
        code,
      ]);
      expect(creditCalls()).toHaveLength(1);
      const rows = await prisma.walletTransfer.findMany({
        where: { payerWawuUserId: me.id },
      });
      expect(rows.map((r) => r.status)).toEqual(['failed']);
      expect(
        (await ledgerRows(rows[0].customerReference)).map(
          (r) => `${r.direction}:${r.status}`,
        ),
      ).toEqual(['out:failed']);
      // Nothing waits: the sweep a week on changes nothing.
      await transfers.sweep(new Date(Date.now() + 7 * 24 * 3_600_000));
      expect(
        (
          await prisma.walletTransfer.findMany({
            where: { payerWawuUserId: me.id },
          })
        ).map((r) => `${r.status}:${r.reviewSince === null}`),
      ).toEqual(['failed:true']);
      // The key was given back: the same request is a new send, under a new reference.
      bank.refuseWith = null;
      const again = await send(me, b, key);
      expect(again.status).toBe(201);
      expect(
        again.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
      ).toBeUndefined();
      const sent = body<TransferView>(again).data!;
      expect(sent.status).toBe('completed');
      expect(sent.reference).not.toBe(rows[0].customerReference);
    },
  );

  it('finding 2: two sends under two keys with a balance for one: the second ends failed with 402 and nothing is left pending', async () => {
    const me = await person(1_000_000);
    const number = account('NOT ENOUGH FOR TWO');
    const b = await ready(me, { number }, 900_000);
    // Both balance reads happen before either send reaches Fintava.
    const together = barrier(2);
    double.on('GET', /^\/customer\/wallet\/balance\//, async (req) => {
      const held = bank.byId.get(req.path.split('/').pop()!)!;
      const naira = (bank.kobo.get(held) ?? 0) / 100;
      await together();
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
    try {
      const [one, two] = await Promise.all([
        send(me, b, randomUUID()),
        send(me, b, randomUUID()),
      ]);
      const outcomes = [one, two].map((r) => r.status).sort();
      expect(outcomes).toEqual([201, 402]);
      const refused = [one, two].find((r) => r.status === 402)!;
      expect(body(refused).reason?.code).toBe('insufficient_funds');
      const rows = await prisma.walletTransfer.findMany({
        where: { payerWawuUserId: me.id },
      });
      expect(rows.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
      const history = await request(app.getHttpServer())
        .get(`${BASE}/transactions`)
        .set('Authorization', me.auth);
      const items = body<{ items: Array<{ status: string }> }>(history).data!
        .items;
      expect(items.filter((i) => i.status === 'pending')).toEqual([]);
      expect(balance(me)).toBe(1_000_000 - 900_000 - FEE);
    } finally {
      installFintava();
    }
  });

  it('finding 2: a refusal that may have created a transfer (an unknown one) stays pending for the reconcile', async () => {
    const me = await person(5_000_000);
    const number = account('MAY EXIST');
    const b = await ready(me, { number }, 100_000);
    bank.refuseWith = 'Something else went wrong';
    const res = await send(me, b);
    expect(res.status).toBe(201);
    expect(body<TransferView>(res).data?.status).toBe('pending');
    const rows = await prisma.walletTransfer.findMany({
      where: { payerWawuUserId: me.id },
    });
    expect(rows.map((r) => r.status)).toEqual(['pending']);
  });

  it('finding 3: an unsaved account is bound to the name the person saw: a name that changed since the check is account_name_changed, nothing is sent and no PIN try is used', async () => {
    const me = await person(5_000_000);
    const number = account('FIRST HOLDER');
    const checked = await nameCheck(me, GTB.code, number);
    expect(checked.status).toBe(200);
    const token = body<AccountNameView>(checked).data!.nameToken;
    expect(typeof token).toBe('string');
    const b = await ready(me, { number }, 100_000, { nameToken: token });
    const tries = await triesLeft(me);
    const key = randomUUID();

    bank.holders.set(holderKey(GTB.code, number), 'SECOND HOLDER');
    const res = await send(me, b, key, WRONG_PIN);
    expect(res.status).toBe(409);
    expect(body(res).reason).toMatchObject({
      code: 'account_name_changed',
      accountName: 'SECOND HOLDER',
      bankName: GTB.name,
    });
    expect(creditCalls()).toHaveLength(0);
    expect(await triesLeft(me)).toBe(tries);

    // The name the person saw is back: the same key and body send, to it.
    bank.holders.set(holderKey(GTB.code, number), 'FIRST HOLDER');
    const ok = await send(me, b, key);
    expect(ok.status).toBe(201);
    expect(
      ok.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
    ).toBeUndefined();
    expect(sendsFrom(me).map((s) => s.accountName)).toEqual(['FIRST HOLDER']);

    // A new check names the new holder, and a send with that token goes to it.
    bank.holders.set(holderKey(GTB.code, number), 'SECOND HOLDER');
    const recheck = body<AccountNameView>(
      await nameCheck(me, GTB.code, number),
    ).data!;
    const q2 = await quoted(me, 100_000);
    const next = await send(
      me,
      sendBody(q2, { number }, { nameToken: recheck.nameToken }),
    );
    expect(next.status).toBe(201);
    expect(sendsFrom(me).map((s) => s.accountName)).toEqual([
      'FIRST HOLDER',
      'SECOND HOLDER',
    ]);
  });

  it('finding 3: a name token for another account, another person, a made up one or an old one is the same account_name_changed', async () => {
    const me = await person(5_000_000);
    const other = await person(5_000_000);
    const number = account('BOUND HOLDER');
    const elsewhere = account('SOMEONE ELSE');
    const tokens = moduleRef.get(NameCheckTokenService, { strict: false });
    const view = (n: string, name: string) => ({
      bankCode: GTB.code,
      bankName: GTB.name,
      accountNumber: n,
      accountName: name,
    });
    const good = tokens.issue(me.id, view(number, 'BOUND HOLDER'));
    const cases: Array<[string, string]> = [
      ['garbage', 'abc.def'],
      ['tampered', good + 'x'],
      ['another person', tokens.issue(other.id, view(number, 'BOUND HOLDER'))],
      ['another account', tokens.issue(me.id, view(elsewhere, 'SOMEONE ELSE'))],
      [
        'another holder',
        tokens.issue(me.id, view(number, 'A DIFFERENT HOLDER')),
      ],
      [
        'an old one',
        tokens.issue(
          me.id,
          view(number, 'BOUND HOLDER'),
          new Date(Date.now() - 24 * 3_600_000),
        ),
      ],
    ];
    const b = await ready(me, { number }, 100_000);
    const tries = await triesLeft(me);
    for (const [label, nameToken] of cases) {
      const res = await send(me, { ...b, nameToken }, randomUUID(), WRONG_PIN);
      expect([label, res.status, body(res).reason?.code]).toEqual([
        label,
        409,
        'account_name_changed',
      ]);
    }
    expect(creditCalls()).toHaveLength(0);
    expect(await triesLeft(me)).toBe(tries);
    // The good one sends.
    expect((await send(me, { ...b, nameToken: good })).status).toBe(201);
    expect(creditCalls()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // FIX-41 (the verifier's round 2 findings 1 and 3)
  // -------------------------------------------------------------------------

  const NO_TOKEN = { nameToken: undefined };

  it('FIX-41 N3: a send to an account that is not saved needs the name token: without it the route answers 400 with a plain sentence, sends nothing and gives the key back', async () => {
    const me = await person(5_000_000);
    const number = account('ALICE SEEN');
    const shown = body<AccountNameView>(
      await nameCheck(me, GTB.code, number),
    ).data!;
    // The holder changes after the check.
    bank.holders.set(holderKey(GTB.code, number), 'MALLORY NEW');
    const q = await quoted(me, 100_000);
    const tries = await triesLeft(me);
    const key = randomUUID();
    const calls = providerCalls().length;

    const bare = await send(
      me,
      sendBody(q, { number }, NO_TOKEN),
      key,
      WRONG_PIN,
    );
    expect(bare.status).toBe(400);
    expect(typeof body(bare).message).toBe('string');
    expect(body(bare).message).toMatch(/name/i);
    expect(body(bare).message).not.toMatch(/\u2014/);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(creditCalls()).toHaveLength(0);
    expect(await triesLeft(me)).toBe(tries);
    expect(providerCalls().length - calls).toBeLessThanOrEqual(1);

    // The key was given back: the token of the name the person saw is
    // refused for the new holder, and the same key then sends to the new
    // holder once a new check names it.
    const old = await send(
      me,
      sendBody(q, { number }, { nameToken: shown.nameToken }),
      key,
    );
    expect(old.status).toBe(409);
    expect(body(old).reason?.code).toBe('account_name_changed');
    expect(sendsFrom(me)).toHaveLength(0);
    const again = body<AccountNameView>(
      await nameCheck(me, GTB.code, number),
    ).data!;
    expect(again.accountName).toBe('MALLORY NEW');
    const ok = await send(
      me,
      sendBody(q, { number }, { nameToken: again.nameToken }),
      key,
    );
    expect(ok.status).toBe(201);
    expect(sendsFrom(me).map((x) => x.accountName)).toEqual(['MALLORY NEW']);
  });

  it('FIX-41 N3: a saved account and the payout account still send without a name token', async () => {
    const me = await person(5_000_000);
    const saved = account('SAVED ONE');
    const savedRes = await request(app.getHttpServer())
      .post(`${BASE}/beneficiaries`)
      .set('Authorization', me.auth)
      .send({ kind: 'bank_account', bankCode: GTB.code, accountNumber: saved });
    expect(savedRes.status).toBe(201);
    const q = await quoted(me, 100_000);
    const toSaved = await send(me, sendBody(q, { number: saved }, NO_TOKEN));
    expect(toSaved.status).toBe(201);

    const payout = account('PAYOUT ONE');
    // No BVN name is kept for this person: the wallet's own name is the
    // verified name a payout account must be in (R-51).
    await prisma.fintavaWallet.update({
      where: { wawuUserId: me.id },
      data: { accountName: 'Payout One' },
    });
    const put = await request(app.getHttpServer())
      .put(`${BASE}/payout-account`)
      .set('Authorization', me.auth)
      .send({ bankCode: GTB.code, accountNumber: payout });
    expect(put.status).toBe(200);
    const q2 = await quoted(me, 100_000);
    const toPayout = await send(me, sendBody(q2, { number: payout }, NO_TOKEN));
    expect(toPayout.status).toBe(201);
    expect(sendsFrom(me).map((x) => x.accountName)).toEqual([
      'SAVED ONE',
      'PAYOUT ONE',
    ]);
  });

  // -------------------------------------------------------------------------
  // WALLET-37 (R-51, G-765): a withdrawal goes only to the person's own name
  // -------------------------------------------------------------------------

  /** The BVN name of a person, kept as the real BVN check keeps it: keyed hashes only. */
  async function withBvnName(p: Person, first: string, last: string) {
    const hasher = app.get(IdentityHasher, { strict: false });
    const verifiedAt = new Date();
    const keys = bvnNameKeys(
      { firstName: first, lastName: last },
      (v) => hasher.hash('name', v),
      { wawuUserId: p.id, verifiedAt },
    );
    await prisma.walletIdentity.create({
      data: {
        wawuUserId: p.id,
        bvnHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        bvnLast4: '1234',
        bvnVerifiedAt: verifiedAt,
        bvnNameKeys: { ...keys! },
      },
    });
  }

  const putPayoutTo = (p: Person, number: string) =>
    request(app.getHttpServer())
      .put(`${BASE}/payout-account`)
      .set('Authorization', p.auth)
      .send({ bankCode: GTB.code, accountNumber: number });

  it('WALLET-37: a payout account is saved only in the verified name: another name is 409 with both names and nothing is stored', async () => {
    const me = await person(5_000_000);
    await withBvnName(me, 'Ada', 'Sandbox');
    const own = account('SANDBOX ADA');
    const saved = await putPayoutTo(me, own);
    expect(saved.status).toBe(200);
    expect(body<{ matchesBvnName: boolean }>(saved).data?.matchesBvnName).toBe(
      true,
    );

    const other = account('MALLORY NEW');
    const refused = await putPayoutTo(me, other);
    expect(refused.status).toBe(409);
    const reason = body(refused).reason!;
    expect(reason).toMatchObject({
      code: 'account_not_in_your_name',
      accountName: 'MALLORY NEW',
      bankName: GTB.name,
      verifiedName: expect.stringMatching(/^Sender \d+$/) as string,
    });
    expect(reason.message).toContain('MALLORY NEW');
    expect(reason.message).toContain(reason.verifiedName!);
    expect(reason.message).not.toContain('—');
    // Nothing was stored: the earlier account is still the payout account.
    const row = await prisma.moneyPayoutAccount.findUniqueOrThrow({
      where: { wawuUserId: me.id },
    });
    expect(row.accountNumber).toBe(own);
    expect(row.accountName).toBe('SANDBOX ADA');
  });

  it('WALLET-37: a withdrawal to a payout account that is no longer in the verified name is refused before the PIN, and the key comes back', async () => {
    const me = await person(5_000_000);
    await withBvnName(me, 'Ada', 'Sandbox');
    const number = account('SANDBOX ADA');
    expect((await putPayoutTo(me, number)).status).toBe(200);

    // The account as it was saved before the rule: another person's name,
    // kept and still what the bank says.
    bank.holders.set(holderKey(GTB.code, number), 'MALLORY NEW');
    await prisma.moneyPayoutAccount.update({
      where: { wawuUserId: me.id },
      data: { accountName: 'MALLORY NEW' },
    });
    const triesBefore = await triesLeft(me);
    const key = randomUUID();
    const body0 = await ready(me, { number }, 100_000, {
      nameToken: undefined,
    });
    const refused = await send(me, body0, key, WRONG_PIN);
    expect(refused.status).toBe(409);
    expect(body(refused).reason).toMatchObject({
      code: 'account_not_in_your_name',
      accountName: 'MALLORY NEW',
      bankName: GTB.name,
    });
    // No PIN try was used, nothing was sent, nothing was taken.
    expect(await triesLeft(me)).toBe(triesBefore);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(balance(me)).toBe(5_000_000);
    expect(
      await prisma.walletTransfer.count({ where: { payerWawuUserId: me.id } }),
    ).toBe(0);

    // The same account typed in full while also saved as a beneficiary is
    // still the person's payout account: the same refusal.
    await prisma.moneyBeneficiary.create({
      data: {
        ownerWawuId: me.id,
        kind: 'bank_account',
        bankCode: GTB.code,
        bankName: GTB.name,
        accountNumber: number,
        accountName: 'MALLORY NEW',
      },
    });
    const viaBeneficiary = await send(me, body0, randomUUID(), WRONG_PIN);
    expect(viaBeneficiary.status).toBe(409);
    expect(body(viaBeneficiary).reason?.code).toBe('account_not_in_your_name');
    await prisma.moneyBeneficiary.deleteMany({
      where: { ownerWawuId: me.id },
    });

    // The bank names the person again: the key that was refused sends it.
    bank.holders.set(holderKey(GTB.code, number), 'SANDBOX ADA');
    await prisma.moneyPayoutAccount.update({
      where: { wawuUserId: me.id },
      data: { accountName: 'SANDBOX ADA' },
    });
    const ok = await send(me, body0, key);
    expect(ok.status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(1);
    expect(sendsFrom(me)[0].accountName).toBe('SANDBOX ADA');
  });

  it('WALLET-37: a payout account the bank now names differently is refused before the PIN with the key given back', async () => {
    const me = await person(5_000_000);
    await withBvnName(me, 'Ada', 'Sandbox');
    const number = account('SANDBOX ADA');
    expect((await putPayoutTo(me, number)).status).toBe(200);

    bank.holders.set(holderKey(GTB.code, number), 'MALLORY NEW');
    const triesBefore = await triesLeft(me);
    const key = randomUUID();
    const body0 = await ready(me, { number }, 100_000, {
      nameToken: undefined,
    });
    const refused = await send(me, body0, key, WRONG_PIN);
    expect(refused.status).toBe(409);
    expect(body(refused).reason).toMatchObject({
      code: 'account_name_changed',
      accountName: 'MALLORY NEW',
    });
    expect(await triesLeft(me)).toBe(triesBefore);
    expect(sendsFrom(me)).toHaveLength(0);

    // Saving it again is the person's confirmation, and it is refused as
    // not theirs: nothing changes, and the key still works once the bank
    // names them again.
    const resave = await putPayoutTo(me, number);
    expect(resave.status).toBe(409);
    expect(body(resave).reason?.code).toBe('account_not_in_your_name');
    bank.holders.set(holderKey(GTB.code, number), 'SANDBOX ADA');
    expect((await send(me, body0, key)).status).toBe(201);
  });

  it('WALLET-37: a bank send to someone else still works and still confirms the name', async () => {
    const me = await person(5_000_000);
    await withBvnName(me, 'Ada', 'Sandbox');
    const own = account('SANDBOX ADA');
    expect((await putPayoutTo(me, own)).status).toBe(200);

    // A friend's account, typed: needs the name check, sends to the name shown.
    const friend = account('CHIDI OKORO');
    const q = await quoted(me, 100_000);
    const ok = await send(me, sendBody(q, { number: friend }));
    expect(ok.status).toBe(201);
    expect(sendsFrom(me)[0].accountName).toBe('CHIDI OKORO');
    // Without the name token it is still refused, as before.
    const q2 = await quoted(me, 100_000);
    const noToken = await send(
      me,
      sendBody(q2, { number: account('CHIDI TWO') }, { nameToken: undefined }),
    );
    expect(noToken.status).toBe(400);
  });

  // Round 2 (R-51): with no BVN name kept (every wallet opened under Nuvion),
  // the verified name is the wallet's own account name as the provider gave
  // it; with neither, there is no withdrawal.
  it('WALLET-37: with no BVN name kept, a withdrawal goes only to the wallet account name: saved in it, sent to it, refused before the PIN once the bank names another', async () => {
    const me = await person(5_000_000);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: me.id },
      data: { accountName: 'Okoro Chidinma' },
    });
    const number = account('CHIDINMA ADAEZE OKORO');
    const saved = await putPayoutTo(me, number);
    expect(saved.status).toBe(200);
    expect(
      body<{ matchesBvnName: null }>(saved).data?.matchesBvnName,
    ).toBeNull();

    // Another name is not saved.
    const other = account('MALLORY NEW');
    const refusedSave = await putPayoutTo(me, other);
    expect(refusedSave.status).toBe(409);
    expect(body(refusedSave).reason).toMatchObject({
      code: 'account_not_in_your_name',
      accountName: 'MALLORY NEW',
      bankName: GTB.name,
      verifiedName: 'Okoro Chidinma',
    });

    // The saved account, once the bank names someone else: refused before
    // the PIN, no PIN try used, the key comes back.
    bank.holders.set(holderKey(GTB.code, number), 'MALLORY NEW');
    await prisma.moneyPayoutAccount.update({
      where: { wawuUserId: me.id },
      data: { accountName: 'MALLORY NEW' },
    });
    const triesBefore = await triesLeft(me);
    const key = randomUUID();
    const body0 = await ready(me, { number }, 100_000, {
      nameToken: undefined,
    });
    const refused = await send(me, body0, key, WRONG_PIN);
    expect(refused.status).toBe(409);
    expect(body(refused).reason).toMatchObject({
      code: 'account_not_in_your_name',
      accountName: 'MALLORY NEW',
      verifiedName: 'Okoro Chidinma',
    });
    expect(await triesLeft(me)).toBe(triesBefore);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(balance(me)).toBe(5_000_000);

    // The bank names the person again: the key that was refused sends it.
    bank.holders.set(holderKey(GTB.code, number), 'CHIDINMA ADAEZE OKORO');
    await prisma.moneyPayoutAccount.update({
      where: { wawuUserId: me.id },
      data: { accountName: 'CHIDINMA ADAEZE OKORO' },
    });
    expect((await send(me, body0, key)).status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it('WALLET-37: with neither a BVN name nor a wallet account name, a withdrawal to a payout account is refused before the PIN and the key comes back', async () => {
    const me = await person(5_000_000);
    const number = account('ANY NAME AT ALL');
    // The save is refused in plain words.
    await prisma.fintavaWallet.update({
      where: { wawuUserId: me.id },
      data: { accountName: null },
    });
    const refusedSave = await putPayoutTo(me, number);
    expect(refusedSave.status).toBe(409);
    expect(body(refusedSave).reason?.code).toBe('account_not_in_your_name');
    expect(body(refusedSave).reason?.message).not.toContain('—');
    expect(
      await prisma.moneyPayoutAccount.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);

    // An account kept from before: the withdrawal is refused the same way.
    await prisma.moneyPayoutAccount.create({
      data: {
        wawuUserId: me.id,
        bankCode: GTB.code,
        bankName: GTB.name,
        accountNumber: number,
        accountName: 'ANY NAME AT ALL',
      },
    });
    const triesBefore = await triesLeft(me);
    const key = randomUUID();
    const body0 = await ready(me, { number }, 100_000, {
      nameToken: undefined,
    });
    const refused = await send(me, body0, key, WRONG_PIN);
    expect(refused.status).toBe(409);
    expect(body(refused).reason?.code).toBe('account_not_in_your_name');
    expect(await triesLeft(me)).toBe(triesBefore);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(balance(me)).toBe(5_000_000);

    // Sends to someone else's account are unchanged for this person.
    const friend = account('CHIDI OKORO');
    expect(
      (await send(me, sendBody(await quoted(me, 100_000), { number: friend })))
        .status,
    ).toBe(201);
  });

  it('WALLET-37: the name check answers 429 after 30 an hour for one person with the minutes left, and a second person is not blocked', async () => {
    const a = await person(1_000_000);
    const b = await person(1_000_000);
    const number = account('SANDBOX ADA');
    const check = (p: Person) =>
      request(app.getHttpServer())
        .post(`${BASE}/banks/name-check`)
        .set('Authorization', p.auth)
        .send({ bankCode: GTB.code, accountNumber: number });
    for (let i = 0; i < 30; i += 1) {
      expect((await check(a)).status).toBe(200);
    }
    const nameEnquiries = () =>
      double.seen.filter((r) => r.path === '/name/enquiry').length;
    const asked = nameEnquiries();
    const over = await check(a);
    expect(over.status).toBe(429);
    expect(body(over).reason).toMatchObject({
      code: 'name_check_rate_limited',
      retryAfterSeconds: expect.any(Number) as number,
    });
    expect(body(over).reason?.message).toMatch(/Try again in \d+ minutes?\.$/);
    expect(over.headers['retry-after']).toBe(
      String(body(over).reason?.retryAfterSeconds),
    );
    // No check was made for the 31st.
    expect(nameEnquiries()).toBe(asked);
    // A payout save by the same person spends the same budget.
    expect((await putPayoutTo(a, number)).status).toBe(429);
    expect(nameEnquiries()).toBe(asked);
    // Another person, from the same address, has all of their own.
    expect((await check(b)).status).toBe(200);
  });

  // ---- Round 5 (verifier finding 1): a bank send is not a way round the name
  // check limit. The send asks the bank for the holder of the typed account
  // before the PIN and, when the name token does not fit, answers with the
  // name. That enquiry is a name check: it spends the same 30 an hour, and
  // past them nothing is asked. A send with a token the person got for this
  // account, or to a saved account, is the send's own check and is not counted.

  const nameEnquiries = () =>
    double.seen.filter((r) => r.path === '/name/enquiry').length;
  let probeSeq = 0;
  /** A ten digit account number of its own, known to the bank under `name`. */
  function holder(name: string): string {
    probeSeq += 1;
    const number = `3${String(Date.now()).slice(-6)}${String(probeSeq).padStart(3, '0')}`;
    bank.holders.set(holderKey(GTB.code, number), name);
    return number;
  }
  const nameCheckOf = (p: Person, number: string) =>
    request(app.getHttpServer())
      .post(`${BASE}/banks/name-check`)
      .set('Authorization', p.auth)
      .send({ bankCode: GTB.code, accountNumber: number });
  async function spendChecks(p: Person, count: number): Promise<void> {
    const number = holder('SPENT ON CHECKS');
    for (let i = 0; i < count; i += 1) {
      expect((await nameCheckOf(p, number)).status).toBe(200);
    }
  }
  async function tokenFor(p: Person, number: string): Promise<string> {
    const checked = await nameCheckOf(p, number);
    expect(checked.status).toBe(200);
    return body<AccountNameView>(checked).data!.nameToken;
  }

  it('WALLET-37 round 5: at the limit, 40 sends with a name token that does not fit answer 429, ask the bank nothing and name no holder', async () => {
    const me = await person(5_000_000);
    await spendChecks(me, 30);
    expect((await nameCheckOf(me, holder('ONE MORE'))).status).toBe(429);
    const q = await quoted(me, 100_000);
    const targets = Array.from({ length: 40 }, (_, i) =>
      holder(`SECRET HOLDER ${i}`),
    );
    const asked = nameEnquiries();
    const tries = await triesLeft(me);
    const answers = await Promise.all(
      targets.map((number) =>
        send(me, sendBody(q, { number }, { nameToken: 'x' })),
      ),
    );
    for (const r of answers) {
      expect(r.status).toBe(429);
      expect(body(r).reason).toMatchObject({
        code: 'name_check_rate_limited',
        retryAfterSeconds: expect.any(Number) as number,
      });
      expect(body(r).reason?.message).toMatch(/Try again in \d+ minutes?\.$/);
      expect(r.headers['retry-after']).toBe(
        String(body(r).reason?.retryAfterSeconds),
      );
      expect(JSON.stringify(r.body)).not.toMatch(/SECRET HOLDER/);
    }
    expect(nameEnquiries()).toBe(asked);
    expect(sendsFrom(me)).toHaveLength(0);
    expect(await triesLeft(me)).toBe(tries);
  });

  it('WALLET-37 round 5: below the limit a send with a name token that does not fit is a name check: it spends one of the 30', async () => {
    const me = await person(5_000_000);
    await spendChecks(me, 28);
    const q = await quoted(me, 100_000);
    const target = holder('SOMEONE ELSE');
    const asked = nameEnquiries();
    const miss = await send(
      me,
      sendBody(q, { number: target }, { nameToken: 'x' }),
    );
    expect(miss.status).toBe(409);
    expect(body(miss).reason).toMatchObject({
      code: 'account_name_changed',
      accountName: 'SOMEONE ELSE',
    });
    expect(nameEnquiries()).toBe(asked + 1);
    // 29 used; a send with no token at all is also an enquiry (it answers 400 with no name).
    const none = await send(
      me,
      sendBody(q, { number: holder('NO TOKEN') }, { nameToken: undefined }),
    );
    expect(none.status).toBe(400);
    // That was the 30th: the next enquiry of any kind is refused.
    expect((await nameCheckOf(me, holder('LAST'))).status).toBe(429);
    const again = await send(
      me,
      sendBody(q, { number: holder('AGAIN') }, { nameToken: 'x' }),
    );
    expect(again.status).toBe(429);
  });

  it('WALLET-37 round 5: at the limit a send with the token of this person for this account, or to a saved account, is not counted and still goes', async () => {
    const me = await person(5_000_000);
    const friend = holder('CHIDI OKORO');
    const savedNumber = holder('SAVED FRIEND');
    const saved = await request(app.getHttpServer())
      .post(`${BASE}/beneficiaries`)
      .set('Authorization', me.auth)
      .send({
        kind: 'bank_account',
        bankCode: GTB.code,
        accountNumber: savedNumber,
      });
    expect(saved.status).toBe(201);
    const token = await tokenFor(me, friend);
    await spendChecks(me, 28);
    expect((await nameCheckOf(me, holder('PAST'))).status).toBe(429);

    const asked = nameEnquiries();
    const q = await quoted(me, 100_000);
    const toFriend = await send(
      me,
      sendBody(q, { number: friend }, { nameToken: token }),
    );
    expect(toFriend.status).toBe(201);
    expect(sendsFrom(me)[0].accountName).toBe('CHIDI OKORO');
    const toSaved = await send(
      me,
      sendBody(q, { number: savedNumber }, { nameToken: undefined }),
    );
    expect(toSaved.status).toBe(201);
    // Each send made its own check of the bank, and none of them was counted.
    expect(nameEnquiries()).toBe(asked + 2);

    // The bank renames the holder after the person saw the name: still the
    // send's own check (the person did check this account), so 409, not 429.
    bank.holders.set(holderKey(GTB.code, friend), 'CHIDI RENAMED');
    const renamed = await send(
      me,
      sendBody(q, { number: friend }, { nameToken: token }),
    );
    expect(renamed.status).toBe(409);
    expect(body(renamed).reason?.code).toBe('account_name_changed');
    expect((await nameCheckOf(me, holder('STILL PAST'))).status).toBe(429);
  });

  it("WALLET-37 round 5: a token that is another person's, for another account, or none is not this person's check: at the limit it is 429 and nothing is asked", async () => {
    const me = await person(5_000_000);
    const other = await person(0);
    const friend = holder('CHIDI OKORO');
    const stranger = holder('STRANGER HOLDER');
    const othersToken = await tokenFor(other, friend);
    const mineForFriend = await tokenFor(me, friend);
    await spendChecks(me, 29);
    expect((await nameCheckOf(me, holder('PAST'))).status).toBe(429);
    const q = await quoted(me, 100_000);
    const asked = nameEnquiries();
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["another person's token", friend, { nameToken: othersToken }],
      ['a token for another account', stranger, { nameToken: mineForFriend }],
      [
        'a token for another bank',
        friend,
        { nameToken: mineForFriend, bankCode: ACCESS.code },
      ],
      ['no token', stranger, { nameToken: undefined }],
      ['text that is not a token', stranger, { nameToken: 'a.b' }],
    ];
    for (const [label, number, extra] of cases) {
      const r = await send(me, sendBody(q, { number }, extra));
      expect([label, r.status]).toEqual([label, 429]);
      expect(JSON.stringify(r.body)).not.toMatch(/STRANGER HOLDER|CHIDI/);
    }
    expect(nameEnquiries()).toBe(asked);
  });

  it('WALLET-37 round 5: a bank that cannot answer gives the place back, and a send refused for the limit gives its key and PIN try back', async () => {
    const me = await person(5_000_000);
    await spendChecks(me, 29);
    const q = await quoted(me, 100_000);
    const target = holder('NOT ASKED');
    const budget = moduleRef.get(NameCheckBudget, { strict: false });
    jest
      .spyOn(moduleRef.get(BankAccountCheckService, { strict: false }), 'check')
      .mockRejectedValueOnce(
        new MoneyError('provider_unreachable', 'The bank is not answering.'),
      );
    const down = await send(
      me,
      sendBody(q, { number: target }, { nameToken: 'x' }),
    );
    expect(down.status).toBe(503);
    // The place came back: this is the 30th, and the one after is refused.
    expect((await nameCheckOf(me, holder('THIRTIETH'))).status).toBe(200);

    const key = randomUUID();
    const tries = await triesLeft(me);
    const refused = await send(
      me,
      sendBody(q, { number: target }, { nameToken: 'x' }),
      key,
      WRONG_PIN,
    );
    expect(refused.status).toBe(429);
    expect(await triesLeft(me)).toBe(tries);
    // An hour on, the same key sends: it was given back, not kept as an answer.
    const friend = holder('CHIDI OKORO');
    budget.now = () => Date.now() + 61 * 60_000;
    try {
      const token = await tokenFor(me, friend);
      const sent = await send(
        me,
        sendBody(q, { number: friend }, { nameToken: token }),
        key,
      );
      expect(sent.status).toBe(201);
      expect(sent.headers['idempotent-replayed']).toBeUndefined();
    } finally {
      budget.now = () => Date.now();
    }
  });

  // ---- A success seen after the send was failed (SWEEP-MONEY F8) ----------

  const transferRow = (id: string) =>
    prisma.walletTransfer.findUniqueOrThrow({ where: { id } });
  const rowsFor = (p: Person) =>
    prisma.walletTransfer.findMany({
      where: { payerWawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
    });
  /** The log lines that say a failed send was seen completed, for one send. */
  const lateLines = (id: string) =>
    logger.lines.filter(
      (l) => l.includes(id) && /completed after it was failed/.test(l),
    );
  /** The provider lookups made for one of our references. */
  const lookupsOf = (ref: string) =>
    double.seen.filter(
      (r) =>
        r.path.startsWith('/transaction/reference/') && r.path.includes(ref),
    );
  const refusals: Array<[string, string, number]> = [
    ['payouts_blocked', 'Unable to find customers', 503],
    [
      'wallet_inactive',
      'Kindly confirm both customer accounts are active',
      423,
    ],
    ['insufficient_funds', 'Insufficient balance', 402],
  ];

  async function deliver(text: string): Promise<void> {
    const res = await request(app.getHttpServer())
      .post('/api/hub/webhooks/fintava')
      .set('Content-Type', 'application/json')
      .set(
        FINTAVA_SIGNATURE_HEADER,
        signFintavaBody(WEBHOOK_SECRET, Buffer.from(text)),
      )
      .send(text);
    expect(res.status).toBe(200);
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "FintavaWebhookEvent"
       WHERE position(convert_to(${text}, 'UTF8') in "rawBody") > 0`;
    expect(ids.length).toBeGreaterThanOrEqual(1);
    await moduleRef
      .get(LedgerConsumerService, { strict: false })
      .consume(ids[0].id);
  }

  const bankDelivery = (o: {
    customerId: string;
    ref: string;
    fin: string;
    status: string;
    amount: number;
  }) =>
    JSON.stringify({
      event: 'customer_bank_transfer',
      data: {
        amount: o.amount / 100,
        vat: 0,
        reference: o.fin,
        customerId: o.customerId,
        availableBalance: 109.52,
        bookedBalance: 109.52,
        status: o.status,
        total: (o.amount + FEE) / 100,
        description: 'Payment',
        destination: '81450/100004',
        sessionID: `S-${o.fin}`,
        customerReference: o.ref,
        senderName: 'Bayo Sandbox',
        senderAccountNumber: '0000037726',
        charges: FEE / 100,
      },
    });

  /** A bank send the provider refused before it took the money, so it is `failed`. */
  async function refusedSend(label: string, message: string, status: number) {
    const me = await person(5_000_000);
    const number = account(`LATE ${label}`);
    const b = await ready(me, { number }, 100_000);
    const key = randomUUID();
    bank.refuseWith = message;
    const refused = await send(me, b, key);
    bank.refuseWith = null;
    expect(refused.status).toBe(status);
    const [t] = await rowsFor(me);
    expect(t.status).toBe('failed');
    expect(t.reviewSince).toBeNull();
    return { me, number, b, key, t };
  }

  it.each(refusals)(
    'FIX-41 R1 (%s): a success the webhook brings after the send was failed puts the send in front of a person once, moves no balance and sends nothing again',
    async (label, message, status) => {
      const { me, number, b, key, t } = await refusedSend(
        label,
        message,
        status,
      );
      const kobo = bank.kobo.get(me.accountNumber);
      // The provider turns out to have the transfer after all and says so.
      bank.sends.push({
        from: me.accountNumber,
        accountNumber: number,
        accountName: `LATE ${label}`,
        sortCode: GTB.code,
        amountKobo: 100_000,
        feeKobo: FEE,
        reference: t.customerReference,
      });
      const delivery = bankDelivery({
        customerId: me.customerId,
        ref: t.customerReference,
        fin: `tagapay${randomUUID().replace(/-/g, '')}`,
        status: 'SUCCESS',
        amount: 100_000,
      });
      await deliver(delivery);
      await until(async () => (await transferRow(t.id)).reviewSince !== null);
      const after = await transferRow(t.id);
      expect(after.status).toBe('failed');
      expect(after.reviewSince).not.toBeNull();
      expect(after.discrepancy).toMatch(/completed/);
      expect(bank.kobo.get(me.accountNumber)).toBe(kobo);
      expect(creditCalls()).toHaveLength(1);
      expect(lateLines(t.id)).toHaveLength(1);

      // The same word again, and the sweep, change nothing and log nothing more.
      await deliver(delivery);
      await transfers.sweep(new Date(Date.now() + 3 * 3_600_000));
      const still = await transferRow(t.id);
      expect(still.reviewSince?.getTime()).toBe(after.reviewSince?.getTime());
      expect(still.discrepancy).toBe(after.discrepancy);
      expect(lateLines(t.id)).toHaveLength(1);
      expect(creditCalls()).toHaveLength(1);

      // The retry with the same key is a new send (correct), and the first
      // one stays in front of a person.
      const retry = await send(me, b, key);
      expect(retry.status).toBe(201);
      const rows = await rowsFor(me);
      expect(rows.map((r) => r.status)).toEqual(['failed', 'completed']);
      expect((await transferRow(t.id)).reviewSince).not.toBeNull();
    },
  );

  it('FIX-41 R1: the sweep asks the provider once about a bank send failed without a provider record, and flags a success the webhook missed', async () => {
    const { me, number, t } = await refusedSend(
      'insufficient_funds',
      'Insufficient balance',
      402,
    );
    const lookups = () => lookupsOf(t.customerReference);
    const calls = creditCalls().length;

    // Too soon: the orphan record needs time, so nothing is asked yet.
    await transfers.sweep(new Date(Date.now() + 10 * 60_000));
    expect(lookups()).toHaveLength(0);

    // The provider has the transfer, and no webhook came.
    bank.sends.push({
      from: me.accountNumber,
      accountNumber: number,
      accountName: 'LATE insufficient_funds',
      sortCode: GTB.code,
      amountKobo: 100_000,
      feeKobo: FEE,
      reference: t.customerReference,
    });
    const later = new Date(Date.now() + 2 * 3_600_000);
    await transfers.sweep(later);
    const flagged = await transferRow(t.id);
    expect(flagged.status).toBe('failed');
    expect(flagged.reviewSince).not.toBeNull();
    expect(flagged.discrepancy).toMatch(/completed/);
    expect(lateLines(t.id)).toHaveLength(1);
    expect(creditCalls()).toHaveLength(calls);
    const asked = lookups().length;
    expect(asked).toBeGreaterThanOrEqual(1);

    // Once: the next sweeps do not ask again.
    await transfers.sweep(new Date(later.getTime() + 60_000));
    await transfers.sweep(new Date(later.getTime() + 3_600_000));
    expect(lookups()).toHaveLength(asked);
    expect(lateLines(t.id)).toHaveLength(1);
  });

  it('FIX-41 R1: the sweep asks once about a failed bank send with no record at the provider and flags nothing, and leaves one older than 48 hours alone', async () => {
    const none = await refusedSend(
      'payouts_blocked',
      'Unable to find customers',
      503,
    );
    const old = await refusedSend(
      'frozen',
      'Kindly confirm both customer accounts are active',
      423,
    );
    await prisma.walletTransfer.update({
      where: { id: old.t.id },
      data: { failedAt: new Date(Date.now() - 49 * 3_600_000) },
    });
    // The provider would say success about the old one if it were asked.
    bank.sends.push({
      from: old.me.accountNumber,
      accountNumber: old.number,
      accountName: 'OLD',
      sortCode: GTB.code,
      amountKobo: 100_000,
      feeKobo: FEE,
      reference: old.t.customerReference,
    });
    // The sender's history is complete and has no row for it: "no record".
    double.on('GET', '/txn', { status: 200, body: customerHistory([]) });
    await transfers.sweep(new Date(Date.now() + 2 * 3_600_000));
    expect(lookupsOf(none.t.customerReference).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(lookupsOf(old.t.customerReference)).toHaveLength(0);
    expect((await transferRow(none.t.id)).reviewSince).toBeNull();
    expect((await transferRow(old.t.id)).reviewSince).toBeNull();
    expect(lateLines(none.t.id)).toHaveLength(0);
    expect(lateLines(old.t.id)).toHaveLength(0);
    // The one with no record was asked and is not asked again.
    const asked = lookupsOf(none.t.customerReference).length;
    await transfers.sweep(new Date(Date.now() + 3 * 3_600_000));
    expect(lookupsOf(none.t.customerReference)).toHaveLength(asked);
  });
});

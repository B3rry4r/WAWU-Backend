import { createHash, randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  body,
  mintToken,
  PIN,
  QuietLogger,
  WRONG_PIN,
} from '../../../test/transfers/harness';
import {
  customerHistory,
  FintavaDouble,
  fintavaError,
  MERCHANT_BALANCE,
  recordByReference,
  type SeenRequest,
} from '../../../test/fintava/fintava-double';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../../chat/chat.module';
import type {
  ChatMessage,
  ChatMessagePage,
  ChatSummary,
} from '../../chat/chat-view.type';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaWebhookModule } from '../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { InboxModule } from '../../inbox/inbox.module';
import type { InboxPage, InboxUnread } from '../../inbox/inbox-view.type';
import { LiveModule } from '../../live/live.module';
import type { LiveCatchUp } from '../../live/live-event.type';
import { MoneyModule } from '../../money/money.module';
import type {
  FeeQuoteView,
  PinStateView,
  TransferView,
} from '../../money/money-view.type';
import { WalletTransferService } from '../../money/transfers/wallet-transfer.service';
import { IDEMPOTENT_REPLAYED_HEADER } from '../../money/payments/idempotency';
import { MoneyRequestModule } from '../money-request.module';
import { MoneyRequestService } from '../money-request.service';
import type { MoneyRequestView } from '../money-request-view.type';

/**
 * Money requests in chat (task INBOX-15, R-13) over HTTP: the real chat,
 * money, inbox and live modules, a real database, real RS256 tokens checked
 * against the stand-in WAWU ID's JWKS, and the real Fintava client over a
 * socket to FintavaDouble, which plays Fintava's wallets exactly as the
 * WALLET-07 spec's double does (₦23.25 below ₦5,000, ₦15.75 above, and the
 * ₦10 merchant charge that is WAWU's fee, R-10).
 */

const LIVE_FEE_LIMIT = 500_000;
const MONEY_TIMEOUT_MS = 120_000;
const WAWU_FEE = 1000;
const liveFee = (amountKobo: number) =>
  amountKobo < LIVE_FEE_LIMIT ? 2325 : 1575;

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

describe('Money requests in chat (INBOX-15) over HTTP', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let requests: MoneyRequestService;
  let transfers: WalletTransferService;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let accountSeq = 0;

  type Person = {
    id: string;
    auth: string;
    accountNumber: string;
    name: string;
  };

  /** A person with a profile, and (unless told) an open wallet holding `kobo` and the PIN set. */
  async function person(
    kobo: number,
    opts: { wallet?: boolean } = {},
  ): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `19${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const name = `Request Tester ${accountSeq}`;
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `i15-${id.slice(0, 8)}`,
      },
    });
    if (opts.wallet !== false) {
      const walletId = randomUUID();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: randomUUID(),
          walletId,
          accountNumber,
          accountName: name,
        },
      });
      wallets.kobo.set(accountNumber, kobo);
      wallets.byId.set(walletId, accountNumber);
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
    }
    return { id, auth: `Bearer ${mintToken(id)}`, accountNumber, name };
  }

  const balance = (p: Person) => wallets.kobo.get(p.accountNumber);
  /** The wallet-to-wallet requests Fintava's double saw from `p`'s wallet. */
  const sentBy = (p: Person) =>
    double.seen.filter(
      (r) =>
        r.path === '/transaction/wallet-to-wallet' &&
        (r.body as { senderAccount?: string }).senderAccount ===
          p.accountNumber,
    );

  const get = (p: Person, path: string) =>
    request(app.getHttpServer())
      .get(`/api/hub${path}`)
      .set('Authorization', p.auth);
  const post = (p: Person, path: string, payload: object = {}) =>
    request(app.getHttpServer())
      .post(`/api/hub${path}`)
      .set('Authorization', p.auth)
      .send(payload);

  async function chatOf(a: Person, b: Person): Promise<string> {
    const res = await post(a, '/chats', { wawuId: b.id });
    expect(res.status).toBe(200);
    return body<ChatSummary>(res).data!.id;
  }

  /** `a` asks `b` (in their chat) for `amountKobo`. */
  function ask(
    a: Person,
    chatId: string,
    amountKobo: number,
    extra: Record<string, unknown> = {},
  ) {
    return post(a, `/chats/${chatId}/money-requests`, { amountKobo, ...extra });
  }

  /** A request made, with the chat it is in. */
  async function made(
    a: Person,
    b: Person,
    amountKobo = 1_200_000,
    memo: string | undefined = 'Logo edits, round 2',
  ) {
    const chatId = await chatOf(a, b);
    const res = await ask(a, chatId, amountKobo, memo ? { memo } : {});
    expect(res.status).toBe(201);
    const message = body<ChatMessage>(res).data!;
    return { chatId, requestId: message.moneyRequest!.id, message };
  }

  async function quoted(p: Person, amountKobo: number): Promise<FeeQuoteView> {
    const res = await get(
      p,
      `/money/fees/quote?kind=wawu_transfer&amountKobo=${amountKobo}`,
    );
    expect(res.status).toBe(200);
    return body<FeeQuoteView>(res).data!;
  }

  function pay(
    p: Person,
    chatId: string,
    requestId: string,
    q: FeeQuoteView,
    key: string | null = randomUUID(),
    pin: string | null = PIN,
  ) {
    let req = request(app.getHttpServer())
      .post(`/api/hub/chats/${chatId}/money-requests/${requestId}/pay`)
      .set('Authorization', p.auth);
    if (key !== null) req = req.set('Idempotency-Key', key);
    if (pin !== null) req = req.set('X-Transaction-Pin', pin);
    return req.send({
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
    });
  }

  const view = async (p: Person, chatId: string, requestId: string) =>
    body<MoneyRequestView>(
      await get(p, `/chats/${chatId}/money-requests/${requestId}`),
    ).data!;

  const transfersFrom = (p: Person) =>
    prisma.walletTransfer.findMany({ where: { payerWawuUserId: p.id } });

  async function pinState(p: Person): Promise<PinStateView> {
    return body<PinStateView>(await get(p, '/money/pin')).data!;
  }

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
        BlockedAccountModule,
        MoneyModule,
        FintavaWebhookModule,
        ChatModule,
        MoneyRequestModule,
        InboxModule,
        LiveModule,
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
      FINTAVA_API_KEY: 'live_test_i15_request_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'i15-test-fee-quote-key-0123456789abcdef0123',
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
    requests = moduleRef.get(MoneyRequestService);
    transfers = moduleRef.get(WalletTransferService);
  });

  afterAll(async () => {
    if (prisma) {
      const chats = await prisma.chatConversation.findMany({
        where: {
          OR: [{ userAWawuId: { in: users } }, { userBWawuId: { in: users } }],
        },
        select: { id: true },
      });
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
      await prisma.moneyRequest.deleteMany({
        where: { conversationId: { in: chats.map((c) => c.id) } },
      });
      await prisma.chatConversation.deleteMany({
        where: { id: { in: chats.map((c) => c.id) } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: users } }, { blockedWawuId: { in: users } }],
        },
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
  });

  // -------------------------------------------------------------------------
  // Asking (I16, I17)
  // -------------------------------------------------------------------------

  it('a user asks for money in a chat: the request is a bubble in the thread for both, pending, and nothing moves', async () => {
    const kemi = await person(0);
    const femi = await person(500_000);
    const { chatId, message } = await made(kemi, femi);
    expect(message).toMatchObject({
      kind: 'money_request',
      mine: true,
      text: 'Logo edits, round 2',
      moneyRequest: {
        chatId,
        direction: 'outgoing',
        requesterWawuId: kemi.id,
        payerWawuId: femi.id,
        amountKobo: 1_200_000,
        memo: 'Logo edits, round 2',
        status: 'pending',
        paying: false,
        resolvedAt: null,
      },
    });
    const theirs = body<ChatMessagePage>(
      await get(femi, `/chats/${chatId}/messages`),
    ).data!;
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]).toMatchObject({
      id: message.id,
      kind: 'money_request',
      mine: false,
      moneyRequest: { direction: 'incoming', status: 'pending' },
    });
    expect(balance(femi)).toBe(500_000);
    expect(sentBy(femi)).toHaveLength(0);
  });

  it('a resend with the same clientRequestId returns the first request, not a second', async () => {
    const a = await person(0);
    const b = await person(0);
    const chatId = await chatOf(a, b);
    const id = 'i15-resend-0001';
    const first = await ask(a, chatId, 50_000, { clientRequestId: id });
    const again = await ask(a, chatId, 50_000, { clientRequestId: id });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(body<ChatMessage>(again).data!.id).toBe(
      body<ChatMessage>(first).data!.id,
    );
    expect(
      await prisma.moneyRequest.count({ where: { conversationId: chatId } }),
    ).toBe(1);
    const both = await Promise.all([
      ask(a, chatId, 70_000, { clientRequestId: 'i15-at-once-01' }),
      ask(a, chatId, 70_000, { clientRequestId: 'i15-at-once-01' }),
    ]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(
      await prisma.moneyRequest.count({ where: { conversationId: chatId } }),
    ).toBe(2);
  });

  it('refuses a request from someone with no wallet, from outside the chat, across a block, and a bad amount or reason', async () => {
    const a = await person(0);
    const noWallet = await person(0, { wallet: false });
    const b = await person(0);
    const outsider = await person(0);
    const chatId = await chatOf(a, b);
    const bare = await chatOf(noWallet, b);
    const noWalletRes = await ask(noWallet, bare, 10_000);
    expect(noWalletRes.status).toBe(409);
    expect(body(noWalletRes).reason).toMatchObject({ code: 'wallet_not_open' });
    expect((await ask(outsider, chatId, 10_000)).status).toBe(404);
    expect((await ask(a, chatId, 0)).status).toBe(400);
    expect((await ask(a, chatId, 10.5)).status).toBe(400);
    expect(
      (await ask(a, chatId, 10_000, { memo: 'x'.repeat(101) })).status,
    ).toBe(400);
    expect((await ask(a, chatId, 10_000, { memo: 'a\u0000b' })).status).toBe(
      400,
    );
    expect((await ask(a, chatId, 10_000, { payer: b.id })).status).toBe(400);
    await prisma.blockedAccount.create({
      data: { userWawuId: b.id, blockedWawuId: a.id },
    });
    const blocked = await ask(a, chatId, 10_000);
    expect(blocked.status).toBe(403);
    expect(body(blocked).reason).toMatchObject({ code: 'chat_blocked' });
    expect(
      await prisma.moneyRequest.count({ where: { conversationId: chatId } }),
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Paying (I18, I19): a send to the requester, exactly once
  // -------------------------------------------------------------------------

  it('check: a request paid once cannot be paid again; the payer pays amount + Fintava + WAWU fee, the requester gets exactly the amount', async () => {
    const kemi = await person(0);
    const femi = await person(2_000_000);
    const { chatId, requestId } = await made(kemi, femi, 1_200_000);
    const q = await quoted(femi, 1_200_000);
    expect(q).toMatchObject({
      amountKobo: 1_200_000,
      fee: { providerFeeKobo: 1575, wawuFeeKobo: 1000, totalFeeKobo: 2575 },
      totalKobo: 1_202_575,
    });

    const key = randomUUID();
    const res = await pay(femi, chatId, requestId, q, key);
    expect(res.status).toBe(201);
    expect(body<TransferView>(res).data).toMatchObject({
      kind: 'wawu_user',
      status: 'completed',
      amountKobo: 1_200_000,
      totalKobo: 1_202_575,
      note: 'Logo edits, round 2',
    });
    expect(balance(femi)).toBe(2_000_000 - 1_202_575);
    expect(balance(kemi)).toBe(1_200_000);

    const paid = await view(kemi, chatId, requestId);
    expect(paid).toMatchObject({ status: 'paid', paying: false });
    expect(paid.resolvedAt).not.toBeNull();
    const bubble = body<ChatMessagePage>(
      await get(kemi, `/chats/${chatId}/messages`),
    ).data!.items[0];
    expect(bubble.moneyRequest).toMatchObject({ status: 'paid' });

    // The same key and body: the first answer again, the PIN not looked at, nothing sent.
    const replay = await pay(femi, chatId, requestId, q, key, WRONG_PIN);
    expect(replay.status).toBe(201);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(replay.text).toBe(res.text);

    // Another key: refused before the PIN, no PIN try used, nothing sent.
    const before = await pinState(femi);
    const second = await pay(
      femi,
      chatId,
      requestId,
      q,
      randomUUID(),
      WRONG_PIN,
    );
    expect(second.status).toBe(409);
    expect(body(second).reason).toMatchObject({
      code: 'money_request_not_pending',
      status: 'paid',
    });
    expect(await pinState(femi)).toEqual(before);
    expect(sentBy(femi)).toHaveLength(1);
    expect(balance(femi)).toBe(2_000_000 - 1_202_575);
    expect(balance(kemi)).toBe(1_200_000);
    // A decline or a cancel of a paid request is refused too.
    expect(
      (await post(femi, `/chats/${chatId}/money-requests/${requestId}/decline`))
        .status,
    ).toBe(409);
    expect(
      (await post(kemi, `/chats/${chatId}/money-requests/${requestId}/cancel`))
        .status,
    ).toBe(409);
  });

  it('six taps at once with six keys pay once: one send, one debit, and a bystander is not slowed while the provider is held', async () => {
    const kemi = await person(0);
    const femi = await person(2_000_000);
    const bystander = await person(0);
    const { chatId, requestId } = await made(kemi, femi, 300_000);
    const q = await quoted(femi, 300_000);

    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    wallets.sendGate = () => held;
    const answers: Response[] = [];
    const taps = Array.from({ length: 6 }, () =>
      pay(femi, chatId, requestId, q).then((r) => {
        answers.push(r);
        return r;
      }),
    );
    // Five are refused while the sixth waits at the provider.
    for (let i = 0; i < 200 && answers.length < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(answers).toHaveLength(5);
    expect(answers.every((r) => r.status === 409)).toBe(true);
    const codes = answers.map((r) => (body(r).reason as { code: string }).code);
    expect(
      codes.every((c) =>
        [
          'money_request_being_paid',
          'idempotency_in_progress',
          'money_request_not_pending',
        ].includes(c),
      ),
    ).toBe(true);
    // Nothing is held across the provider call: another person's reads are quick.
    const t0 = Date.now();
    expect((await get(bystander, '/inbox/unread')).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    release();
    const all = await Promise.all(taps);
    expect(all.filter((r) => r.status === 201)).toHaveLength(1);
    expect(sentBy(femi)).toHaveLength(1);
    expect(await transfersFrom(femi)).toHaveLength(1);
    expect(balance(kemi)).toBe(300_000);
    expect(balance(femi)).toBe(2_000_000 - 300_000 - 2325 - 1000);
    expect((await view(femi, chatId, requestId)).status).toBe('paid');
  });

  it('a lost provider answer leaves the request paying: it cannot be paid again, declined or cancelled, and the sweep makes it paid once', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const q = await quoted(femi, 100_000);
    wallets.mode = 'timeout';
    const res = await pay(femi, chatId, requestId, q);
    wallets.mode = 'live';
    expect(res.status).toBe(201);
    expect(body<TransferView>(res).data).toMatchObject({ status: 'pending' });
    // The money moved at Fintava although the answer was lost.
    expect(balance(kemi)).toBe(100_000);

    expect(await view(femi, chatId, requestId)).toMatchObject({
      status: 'pending',
      paying: true,
    });
    const again = await pay(femi, chatId, requestId, q);
    expect(again.status).toBe(409);
    expect(body(again).reason).toMatchObject({
      code: 'money_request_being_paid',
    });
    expect(
      (await post(femi, `/chats/${chatId}/money-requests/${requestId}/decline`))
        .status,
    ).toBe(409);
    expect(
      (await post(kemi, `/chats/${chatId}/money-requests/${requestId}/cancel`))
        .status,
    ).toBe(409);
    expect(sentBy(femi)).toHaveLength(1);

    await transfers.sweep(new Date(Date.now() + 3 * 60_000));
    await requests.sweep();
    const done = await view(kemi, chatId, requestId);
    expect(done).toMatchObject({ status: 'paid', paying: false });
    expect(sentBy(femi)).toHaveLength(1);
    // The sweep again changes nothing.
    await requests.sweep();
    expect(await view(kemi, chatId, requestId)).toEqual(done);
  });

  it('a send Fintava refuses leaves the request pending and free, and the payer can pay it again', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const q = await quoted(femi, 100_000);
    wallets.mode = 'refuse';
    const refused = await pay(femi, chatId, requestId, q);
    wallets.mode = 'live';
    expect(refused.status).toBe(201);
    expect(body<TransferView>(refused).data).toMatchObject({
      status: 'failed',
    });
    expect(await view(femi, chatId, requestId)).toMatchObject({
      status: 'pending',
      paying: false,
    });
    expect(balance(femi)).toBe(1_000_000);
    const ok = await pay(femi, chatId, requestId, q);
    expect(ok.status).toBe(201);
    expect(body<TransferView>(ok).data).toMatchObject({ status: 'completed' });
    expect(balance(kemi)).toBe(100_000);
    expect((await view(kemi, chatId, requestId)).status).toBe('paid');
  });

  it('not enough in the wallet: 402 with the figures, the request stays pending and unpaid', async () => {
    const kemi = await person(0);
    const femi = await person(50_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const q = await quoted(femi, 100_000);
    const res = await pay(femi, chatId, requestId, q);
    expect(res.status).toBe(402);
    expect(body(res).reason).toMatchObject({ code: 'insufficient_funds' });
    expect(await view(femi, chatId, requestId)).toMatchObject({
      status: 'pending',
      paying: false,
    });
    expect(sentBy(femi)).toHaveLength(0);
  });

  it('who may pay: only the person asked; a wrong quote, a block, or a requester who closed the wallet is refused before the PIN', async () => {
    const kemi = await person(1_000_000);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const qFemi = await quoted(femi, 100_000);
    const qKemi = await quoted(kemi, 100_000);
    const asker = await pay(
      kemi,
      chatId,
      requestId,
      qKemi,
      randomUUID(),
      WRONG_PIN,
    );
    expect(asker.status).toBe(403);
    expect(body(asker).reason).toMatchObject({
      code: 'money_request_not_yours',
    });
    const stranger = await person(1_000_000);
    expect((await pay(stranger, chatId, requestId, qFemi)).status).toBe(404);
    const wrongQuote = await pay(femi, chatId, requestId, {
      ...qFemi,
      totalKobo: qFemi.totalKobo + 1,
    });
    expect(wrongQuote.status).toBe(409);
    expect(body(wrongQuote).reason).toMatchObject({ code: 'quote_changed' });
    expect((await pay(femi, chatId, randomUUID(), qFemi)).status).toBe(404);

    await prisma.blockedAccount.create({
      data: { userWawuId: kemi.id, blockedWawuId: femi.id },
    });
    const before = await pinState(femi);
    const blocked = await pay(
      femi,
      chatId,
      requestId,
      qFemi,
      randomUUID(),
      WRONG_PIN,
    );
    expect(blocked.status).toBe(403);
    expect(body(blocked).reason).toMatchObject({ code: 'recipient_blocked' });
    expect(await pinState(femi)).toEqual(before);
    expect(sentBy(femi)).toHaveLength(0);
    // The asker may still take it back.
    expect(
      (await post(kemi, `/chats/${chatId}/money-requests/${requestId}/cancel`))
        .status,
    ).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Declining and cancelling
  // -------------------------------------------------------------------------

  it('declining is final and exactly once: the same answer again is fine, a payment after it is refused, and only the person asked may decline', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const decline = `/chats/${chatId}/money-requests/${requestId}/decline`;
    const forbidden = await post(kemi, decline);
    expect(forbidden.status).toBe(403);
    const first = await post(femi, decline);
    expect(first.status).toBe(200);
    expect(body<MoneyRequestView>(first).data).toMatchObject({
      status: 'declined',
      direction: 'incoming',
    });
    const again = await post(femi, decline);
    expect(again.status).toBe(200);
    expect(body<MoneyRequestView>(again).data!.status).toBe('declined');
    expect((await view(kemi, chatId, requestId)).status).toBe('declined');
    const q = await quoted(femi, 100_000);
    const late = await pay(femi, chatId, requestId, q);
    expect(late.status).toBe(409);
    expect(body(late).reason).toMatchObject({
      code: 'money_request_not_pending',
      status: 'declined',
    });
    const cancel = await post(
      kemi,
      `/chats/${chatId}/money-requests/${requestId}/cancel`,
    );
    expect(cancel.status).toBe(409);
    expect(sentBy(femi)).toHaveLength(0);
  });

  it('cancelling is final: only the person who asked may cancel, and the other can no longer pay', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const cancel = `/chats/${chatId}/money-requests/${requestId}/cancel`;
    expect((await post(femi, cancel)).status).toBe(403);
    const res = await post(kemi, cancel);
    expect(res.status).toBe(200);
    expect(body<MoneyRequestView>(res).data).toMatchObject({
      status: 'cancelled',
      direction: 'outgoing',
    });
    expect((await post(kemi, cancel)).status).toBe(200);
    const q = await quoted(femi, 100_000);
    const late = await pay(femi, chatId, requestId, q);
    expect(late.status).toBe(409);
    expect(
      (await post(femi, `/chats/${chatId}/money-requests/${requestId}/decline`))
        .status,
    ).toBe(409);
  });

  it('a decline racing a payment has exactly one winner, and money moves only when the payment won', async () => {
    const kemi = await person(0);
    const femi = await person(5_000_000);
    for (let round = 0; round < 3; round += 1) {
      const { chatId, requestId } = await made(kemi, femi, 100_000 + round);
      const q = await quoted(femi, 100_000 + round);
      const decline = post(
        femi,
        `/chats/${chatId}/money-requests/${requestId}/decline`,
      );
      const paying = pay(femi, chatId, requestId, q);
      const [d, p] = await Promise.all([decline, paying]);
      const finalState = await view(kemi, chatId, requestId);
      if (finalState.status === 'paid') {
        expect(p.status).toBe(201);
        expect(d.status).toBe(409);
      } else {
        expect(finalState.status).toBe('declined');
        expect(d.status).toBe(200);
        expect(p.status).toBe(409);
      }
      const sends = await prisma.walletTransfer.count({
        where: {
          payerWawuUserId: femi.id,
          amountKobo: BigInt(100_000 + round),
        },
      });
      expect(sends).toBe(finalState.status === 'paid' ? 1 : 0);
    }
  });

  // -------------------------------------------------------------------------
  // The inbox feed and the Money filter (I1, I20), and live
  // -------------------------------------------------------------------------

  it('requests are rows in the inbox and in the Money filter; the badge counts a request once, through its chat', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 250_000, 'Poster');
    const otherChat = await person(0);
    const plain = await chatOf(femi, otherChat);
    await post(otherChat, `/chats/${plain}/messages`, { text: 'hello' });

    const unread = body<InboxUnread>(await get(femi, '/inbox/unread')).data!;
    expect(unread).toMatchObject({ total: 2, chats: 2 });
    const all = body<InboxPage>(await get(femi, '/inbox')).data!;
    const kinds = all.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['chat', 'chat', 'money_request']);
    const money = body<InboxPage>(
      await get(femi, '/inbox?kind=money_request'),
    ).data!;
    expect(money.items).toHaveLength(1);
    expect(money.items[0]).toMatchObject({
      id: `money_request:${requestId}`,
      kind: 'money_request',
      unreadCount: 0,
      preview: {
        text: 'Poster',
        mine: false,
        moneyRequest: { amountKobo: 250_000, status: 'pending' },
      },
      moneyRequest: {
        requestId,
        chatId,
        direction: 'incoming',
        amountKobo: 250_000,
        memo: 'Poster',
        status: 'pending',
        paying: false,
        canMessage: true,
      },
    });
    const chatRow = all.items.find((i) => i.id === `chat:${chatId}`)!;
    expect(chatRow.preview).toMatchObject({
      text: 'Poster',
      moneyRequest: { amountKobo: 250_000, status: 'pending' },
    });
    const sum = all.items.reduce((n, i) => n + i.unreadCount, 0);
    expect(sum).toBe(unread.total);
    // The asker sees it as outgoing.
    const hers = body<InboxPage>(
      await get(kemi, '/inbox?kind=money_request'),
    ).data!;
    expect(hers.items[0].moneyRequest).toMatchObject({ direction: 'outgoing' });
    // Opening the chat reads the request: the badge drops, the row stays.
    await post(femi, `/chats/${chatId}/read`, {});
    expect(
      body<InboxUnread>(await get(femi, '/inbox/unread')).data!.total,
    ).toBe(1);
    // Paying moves the row and shows the new status.
    const q = await quoted(femi, 250_000);
    expect((await pay(femi, chatId, requestId, q)).status).toBe(201);
    const after = body<InboxPage>(
      await get(femi, '/inbox?kind=money_request'),
    ).data!;
    expect(after.items[0].moneyRequest).toMatchObject({ status: 'paid' });
    // Paging the Money filter one row at a time loses and repeats nothing.
    const second = await made(kemi, femi, 260_000);
    const page1 = body<InboxPage>(
      await get(femi, '/inbox?kind=money_request&limit=1'),
    ).data!;
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const r2 = await get(
      femi,
      `/inbox?kind=money_request&limit=1&cursor=${page1.nextCursor}`,
    );
    const page2 = body<InboxPage>(r2).data!;
    expect([page1.items[0].id, page2.items[0].id].sort()).toEqual(
      [
        `money_request:${requestId}`,
        `money_request:${second.requestId}`,
      ].sort(),
    );
    expect(page2.nextCursor).toBeNull();
    // Someone else's inbox never lists it.
    const stranger = await person(0);
    expect(
      body<InboxPage>(await get(stranger, '/inbox?kind=money_request')).data!
        .items,
    ).toHaveLength(0);
  });

  it('a request that is paid, declined or cancelled is in the live catch-up with the bubble as the caller sees it', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const start = body<LiveCatchUp>(await get(femi, '/live/catch-up')).data!
      .cursor;
    const first = await made(kemi, femi, 100_000);
    const second = await made(kemi, femi, 110_000);
    await post(
      femi,
      `/chats/${second.chatId}/money-requests/${second.requestId}/decline`,
    );
    const q = await quoted(femi, 100_000);
    await pay(femi, first.chatId, first.requestId, q);

    const caught = body<LiveCatchUp>(
      await get(kemi, `/live/catch-up?cursor=${start}`),
    ).data!;
    const updates = caught.events.filter(
      (e) => e.type === 'money_request.updated',
    );
    expect(updates).toHaveLength(2);
    const byId = Object.fromEntries(
      updates.map((e) => [
        (e as { message: ChatMessage }).message.moneyRequest!.id,
        (e as { message: ChatMessage }).message.moneyRequest!.status,
      ]),
    );
    expect(byId).toEqual({
      [first.requestId]: 'paid',
      [second.requestId]: 'declined',
    });
    // The two new bubbles came as messages, before their updates.
    expect(caught.events.filter((e) => e.type === 'chat.message')).toHaveLength(
      2,
    );
  });

  it('what a person is shown never carries a balance or a phone number', async () => {
    const kemi = await person(0);
    const femi = await person(1_000_000);
    const { chatId, requestId } = await made(kemi, femi, 100_000);
    const text = JSON.stringify(await view(femi, chatId, requestId));
    expect(text).not.toMatch(/balance|accountNumber|\+?234[789]\d{9}/i);
  });
});

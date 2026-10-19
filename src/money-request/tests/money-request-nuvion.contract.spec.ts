import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../test/payments/nuvion-seam-standin';
import {
  body,
  mintToken,
  PIN,
  QuietLogger,
} from '../../../test/transfers/harness';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../../chat/chat.module';
import type { ChatMessage, ChatSummary } from '../../chat/chat-view.type';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { InboxModule } from '../../inbox/inbox.module';
import type { InboxPage, InboxUnread } from '../../inbox/inbox-view.type';
import { LiveModule } from '../../live/live.module';
import { LivePublisher } from '../../live/live-publisher.service';
import { MoneyModule } from '../../money/money.module';
import type { FeeQuoteView, TransferView } from '../../money/money-view.type';
import { WalletTransferService } from '../../money/transfers/wallet-transfer.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { eraseAskerRequests } from '../money-request-erase';
import { MoneyRequestModule } from '../money-request.module';
import { MoneyRequestService } from '../money-request.service';
import type { MoneyRequestView } from '../money-request-view.type';

/**
 * Money requests in chat (INBOX-15) on Nuvion: every money path of the task
 * run over HTTP against the Nuvion seam stand-in (WALLET_PROVIDER overridden,
 * no Fintava double). It holds the verifier's attacks as committed cases, and
 * round 2's two fixes:
 * - the pay Idempotency-Key is bound to the request it was first used on;
 * - an asker's erase clears their words and closes their open requests.
 *
 * A server stands in for Fintava's host only to count calls: none may arrive.
 */
jest.setTimeout(300_000);

const FEE_TOTAL = 3325n;
const MEMO = 'for the tickets last week';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlowStandIn extends NuvionSeamStandIn {
  delayMs = 0;
  async walletToWallet(
    input: Parameters<NuvionSeamStandIn['walletToWallet']>[0],
  ) {
    if (this.delayMs) await sleep(this.delayMs);
    return super.walletToWallet(input);
  }
}

describe('Money requests in chat (INBOX-15) on Nuvion', () => {
  let app: INestApplication<App>;
  let app2: INestApplication<App>;
  let moduleRef: TestingModule;
  let moduleRef2: TestingModule;
  let prisma: PrismaService;
  let requests: MoneyRequestService;
  let requests2: MoneyRequestService;
  let transfers: WalletTransferService;
  let cheapPinHash: string;
  const nuvion = new SlowStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let fintavaCounter: Server;
  const fintavaHits: string[] = [];
  let accountSeq = 0;
  let clock = Date.now();
  const sweepLater = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return transfers.sweep(new Date(clock));
  };

  type Person = { id: string; auth: string; account: NuvionAccount };

  async function person(kobo: number, wallet = true): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `83${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const account = nuvion.openAccount(BigInt(kobo), accountNumber);
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `mr-${id.slice(0, 8)}`,
      },
    });
    if (wallet) {
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: account.entityId,
          walletId: account.accountId,
          accountNumber,
          accountName: `Request Tester ${accountSeq}`,
          provider: 'nuvion',
        },
      });
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
    }
    return { id, auth: `Bearer ${mintToken(id)}`, account };
  }

  const available = (p: Person) =>
    nuvion.accounts.get(p.account.accountId)!.availableKobo;
  const sends = (p: Person) => nuvion.sendsFrom(p.account.accountId).length;
  const get = (p: Person | null, path: string, a = app) => {
    const r = request(a.getHttpServer()).get(`/api/hub${path}`);
    return p ? r.set('Authorization', p.auth) : r;
  };
  const post = (
    p: Person | null,
    path: string,
    payload: object = {},
    a = app,
  ) => {
    const r = request(a.getHttpServer()).post(`/api/hub${path}`);
    return (p ? r.set('Authorization', p.auth) : r).send(payload);
  };
  async function chatOf(a: Person, b: Person): Promise<string> {
    const res = await post(a, '/chats', { wawuId: b.id });
    expect(res.status).toBe(200);
    return body<ChatSummary>(res).data!.id;
  }
  async function made(
    a: Person,
    b: Person,
    amountKobo = 120_000,
    chatId?: string,
    memo: string = MEMO,
  ) {
    const chat = chatId ?? (await chatOf(a, b));
    const res = await post(a, `/chats/${chat}/money-requests`, {
      amountKobo,
      memo,
    });
    expect(res.status).toBe(201);
    const m = body<ChatMessage>(res).data!;
    return { chatId: chat, requestId: m.moneyRequest!.id };
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
    a = app,
  ) {
    let r = request(a.getHttpServer())
      .post(`/api/hub/chats/${chatId}/money-requests/${requestId}/pay`)
      .set('Authorization', p.auth)
      .set('X-Transaction-Pin', PIN);
    if (key !== null) r = r.set('Idempotency-Key', key);
    return r.send({ expectedTotalKobo: q.totalKobo, quoteToken: q.quoteToken });
  }
  const view = async (p: Person, chatId: string, requestId: string) =>
    body<MoneyRequestView>(
      await get(p, `/chats/${chatId}/money-requests/${requestId}`),
    ).data!;
  const row = (requestId: string) =>
    prisma.moneyRequest.findUniqueOrThrow({ where: { id: requestId } });
  const code = (r: Response) =>
    (body(r).reason as { code?: string } | undefined)?.code ?? String(r.status);
  const transferRef = async (payer: Person) =>
    (
      await prisma.walletTransfer.findFirstOrThrow({
        where: { payerWawuUserId: payer.id },
        orderBy: { createdAt: 'desc' },
      })
    ).customerReference;
  /** What the deletion sweep does for a person: mark purging, then purge. */
  async function erase(p: Person) {
    await prisma.accountDeletion.upsert({
      where: { wawuUserId: p.id },
      create: {
        wawuUserId: p.id,
        status: 'purging',
        purgeAfter: new Date(Date.now() + 86_400_000),
      },
      update: { status: 'purging' },
    });
    return new AccountPurgeService(prisma).purge(p.id);
  }

  async function boot() {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        BlockedAccountModule,
        MoneyModule,
        ChatModule,
        MoneyRequestModule,
        InboxModule,
        LiveModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(nuvion)
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
    return { app: hub, ref };
  }

  beforeAll(async () => {
    cheapPinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    fintavaCounter = createServer((req, res) => {
      fintavaHits.push(`${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      fintavaCounter.listen(0, '127.0.0.1', () => r()),
    );
    const port = (fintavaCounter.address() as AddressInfo).port;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_inbox15_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'inbox15-nuvion-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: '2325',
      NUVION_FEE_BANK_PAYOUT: '2325',
      NUVION_FEE_INFLOW: '2325',
      WAWU_LIMIT_WAWU_TRANSFER_PER_TRANSACTION_KOBO: '100000000',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const a = await boot();
    app = a.app;
    moduleRef = a.ref;
    const b = await boot();
    app2 = b.app;
    moduleRef2 = b.ref;
    prisma = moduleRef.get(PrismaService);
    requests = moduleRef.get(MoneyRequestService);
    requests2 = moduleRef2.get(MoneyRequestService);
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
      const owned = {
        OR: [
          { payerWawuUserId: { in: users } },
          { recipientWawuUserId: { in: users } },
        ],
      };
      const rows = await prisma.walletTransfer.findMany({
        where: owned,
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
      await prisma.moneyRequest.deleteMany({
        where: { conversationId: { in: chats.map((c) => c.id) } },
      });
      await prisma.walletTransfer.deleteMany({ where: owned });
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
      await prisma.accountDeletion.deleteMany({
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
    if (app2) await app2.close();
    await new Promise<void>((r) => fintavaCounter.close(() => r()));
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    nuvion.mode = 'successful';
    nuvion.extraKobo = 0n;
    nuvion.delayMs = 0;
    nuvion.feeKobo = () => FEE_TOTAL;
    jest.restoreAllMocks();
  });

  // ---- paid once ----------------------------------------------------------

  it('the same key on the same request replays the first receipt; on ANOTHER request it is refused and that request stays unpaid', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const { requestId: other } = await made(asker, payer, 120_000, chatId);
    const q = await quoted(payer, 120_000);
    const key = randomUUID();
    const first = await pay(payer, chatId, requestId, q, key);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    for (let i = 0; i < 3; i += 1) {
      const again = await pay(payer, chatId, requestId, q, key);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(body(again).data).toEqual(body(first).data);
    }
    expect(sends(payer)).toBe(1);
    expect((await view(payer, chatId, requestId)).status).toBe('paid');

    // The same key, the same amount, the same quote, ANOTHER request.
    const wrong = await pay(payer, chatId, other, q, key);
    expect(wrong.status).toBe(409);
    expect(code(wrong)).toBe('idempotency_key_reused');
    expect(wrong.headers['idempotent-replayed']).toBeUndefined();
    expect(JSON.stringify(body(wrong))).not.toContain(
      (body<TransferView>(first).data as TransferView).id,
    );
    expect(await row(other)).toMatchObject({
      status: 'pending',
      transferId: null,
    });
    expect(sends(payer)).toBe(1);

    // Refusing it did not spend the key on the first request: it still replays.
    const replay = await pay(payer, chatId, requestId, q, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // And the other request is paid with a key of its own, once.
    const paid = await pay(payer, chatId, other, q, randomUUID());
    expect(paid.status).toBe(201);
    expect(sends(payer)).toBe(2);
    expect(available(asker)).toBe(240_000n);

    // A new key on a request that is paid is refused, not sent again.
    const fresh = await pay(payer, chatId, requestId, q, randomUUID());
    expect(fresh.status).toBe(409);
    expect(code(fresh)).toBe('money_request_not_pending');
    expect(sends(payer)).toBe(2);
  });

  it.each([6, 20])(
    '%i parallel taps with new keys pay once: one send, one debit, nothing but 201 and 409',
    async (n) => {
      const asker = await person(0);
      const payer = await person(50_000_000);
      const { chatId, requestId } = await made(asker, payer);
      const q = await quoted(payer, 120_000);
      const before = available(payer);
      const rs = await Promise.all(
        Array.from({ length: n }, () => pay(payer, chatId, requestId, q)),
      );
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      for (const r of rs.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(409);
        expect([
          'money_request_being_paid',
          'money_request_not_pending',
        ]).toContain(code(r));
      }
      await requests.settleOne(requestId);
      expect(sends(payer)).toBe(1);
      expect(before - available(payer)).toBe(120_000n + FEE_TOTAL);
      expect(available(asker)).toBe(120_000n);
      expect((await row(requestId)).status).toBe('paid');
      expect(
        await prisma.walletTransfer.count({
          where: { payerWawuUserId: payer.id },
        }),
      ).toBe(1);
    },
  );

  it('6 parallel taps with the SAME key pay once: one 201 and the rest wait or replay', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(payer, 120_000);
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => pay(payer, chatId, requestId, q, key)),
    );
    expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(
      rs.filter((r) => r.status === 201 && !r.headers['idempotent-replayed']),
    ).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 201)) {
      expect(code(r)).toBe('idempotency_in_progress');
    }
    expect(sends(payer)).toBe(1);
  });

  it.each(['decline', 'cancel'] as const)(
    'a %s racing a payment has exactly one winner, 8 rounds each way, and money moves only when the payment won',
    async (who) => {
      const asker = await person(0);
      const payer = await person(500_000_000);
      const closer = who === 'decline' ? payer : asker;
      const closed = who === 'decline' ? 'declined' : 'cancelled';
      for (let i = 0; i < 8; i += 1) {
        const amt = 100_000 + i;
        const { chatId, requestId } = await made(asker, payer, amt);
        const q = await quoted(payer, amt);
        const lead = Math.floor(Math.random() * 60);
        const [p, c] = await Promise.all([
          (async () => {
            if (i % 2 === 1) await sleep(lead);
            return pay(payer, chatId, requestId, q);
          })(),
          (async () => {
            if (i % 2 === 0) await sleep(lead);
            return post(
              closer,
              `/chats/${chatId}/money-requests/${requestId}/${who}`,
            );
          })(),
        ]);
        await requests.settleOne(requestId);
        const r = await row(requestId);
        if (r.status === closed) {
          expect(r.transferId).toBeNull();
          expect(p.status).not.toBe(201);
        } else {
          expect(r.status).toBe('paid');
          expect(c.status).toBe(409);
          expect(p.status).toBe(201);
        }
      }
      const paid = await prisma.moneyRequest.count({
        where: { payerWawuId: payer.id, status: 'paid' },
      });
      expect(sends(payer)).toBe(paid);
    },
  );

  it('who may pay: a stranger, a request id from another chat and the asker are refused with no send', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const stranger = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(stranger, 120_000);
    expect((await pay(stranger, chatId, requestId, q)).status).toBe(404);
    const otherChat = await chatOf(stranger, asker);
    expect((await pay(stranger, otherChat, requestId, q)).status).toBe(404);
    expect((await pay(payer, otherChat, requestId, q)).status).toBe(404);
    const qa = await quoted(asker, 120_000);
    expect((await pay(asker, chatId, requestId, qa)).status).toBe(403);
    expect(sends(payer) + sends(stranger) + sends(asker)).toBe(0);
  });

  // ---- an answer that does not come, a send that fails --------------------

  it('a lost provider answer leaves the request paying: it cannot be paid, declined or cancelled, and it settles to paid once', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(payer, 120_000);
    nuvion.mode = 'timeout';
    const first = await pay(payer, chatId, requestId, q);
    expect(first.status).toBe(201);
    const v = await view(payer, chatId, requestId);
    expect(v.status).toBe('pending');
    expect(v.paying).toBe(true);
    const dec = await post(
      payer,
      `/chats/${chatId}/money-requests/${requestId}/decline`,
    );
    const can = await post(
      asker,
      `/chats/${chatId}/money-requests/${requestId}/cancel`,
    );
    const again = await pay(payer, chatId, requestId, q);
    expect([dec.status, can.status, again.status]).toEqual([409, 409, 409]);
    expect(sends(payer)).toBe(1);
    nuvion.settle(await transferRef(payer), 'successful');
    await sweepLater();
    await requests.sweep();
    expect((await row(requestId)).status).toBe('paid');
    expect(sends(payer)).toBe(1);
    expect(available(asker)).toBe(120_000n);
  });

  it('a send in flight that dies between the send and the request update is settled once, even by two servers sweeping at the same time', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(payer, 120_000);
    const publish = jest.spyOn(LivePublisher.prototype, 'publish');
    const dies = jest
      .spyOn(MoneyRequestService.prototype, 'settleOne')
      .mockResolvedValue(undefined);
    expect((await pay(payer, chatId, requestId, q)).status).toBe(201);
    dies.mockRestore();
    const mid = await row(requestId);
    expect(mid.status).toBe('pending');
    expect(mid.transferId).not.toBeNull();
    const updates = () =>
      publish.mock.calls.filter(
        (c) => (c[0] as { kind: string }).kind === 'money_request.updated',
      ).length;
    const before = updates();
    await Promise.all([
      requests.sweep(),
      requests2.sweep(),
      requests.sweep(),
      requests2.sweep(),
    ]);
    expect((await row(requestId)).status).toBe('paid');
    expect(updates() - before).toBe(1);
    expect(sends(payer)).toBe(1);
  });

  it('a send that fails after pending frees the request, refunds the payer, and it is paid again once; two servers sweeping act once', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(payer, 120_000);
    nuvion.mode = 'pending';
    expect((await pay(payer, chatId, requestId, q)).status).toBe(201);
    expect((await view(payer, chatId, requestId)).status).toBe('pending');
    const balanceWhilePending = available(payer);
    nuvion.settle(await transferRef(payer), 'failed');
    await sweepLater();
    await Promise.all([requests.sweep(), requests2.sweep()]);
    const freed = await row(requestId);
    expect(freed.status).toBe('pending');
    expect(freed.transferId).toBeNull();
    expect(available(payer)).toBeGreaterThan(balanceWhilePending);
    nuvion.mode = 'successful';
    const q2 = await quoted(payer, 120_000);
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => pay(payer, chatId, requestId, q2)),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    await Promise.all([requests.sweep(), requests2.sweep()]);
    expect((await row(requestId)).status).toBe('paid');
    expect(sends(payer)).toBe(2);
    expect(available(asker)).toBe(120_000n);
  });

  it('a send the provider reverses while pending frees the request', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(payer, 120_000);
    nuvion.mode = 'pending';
    await pay(payer, chatId, requestId, q);
    nuvion.settle(await transferRef(payer), 'reversed');
    await sweepLater();
    await requests.sweep();
    const r = await row(requestId);
    expect(r.status).toBe('pending');
    expect(r.transferId).toBeNull();
  });

  it('a send the provider refuses at once frees the request each time, and it is paid once afterwards', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const q = await quoted(payer, 120_000);
    for (const mode of [
      'account_not_active',
      'insufficient',
      'compliance_rejected',
      'rate_limited',
    ] as const) {
      nuvion.mode = mode;
      const r = await pay(payer, chatId, requestId, q);
      // Refused at once, or answered with a failed receipt: never completed.
      if (r.status === 201) {
        expect(body<TransferView>(r).data!.status).toBe('failed');
      }
      expect(await row(requestId)).toMatchObject({
        status: 'pending',
        transferId: null,
      });
    }
    nuvion.mode = 'successful';
    expect((await pay(payer, chatId, requestId, q)).status).toBe(201);
    expect((await row(requestId)).status).toBe('paid');
    expect(available(asker)).toBe(120_000n);
  });

  it('not enough in the wallet, a wrong quote or no key: refused before anything is claimed, and the request is still payable', async () => {
    const asker = await person(0);
    const poor = await person(50_000);
    const a = await made(asker, poor, 120_000);
    const poorQuote = await quoted(poor, 120_000);
    const broke = await pay(poor, a.chatId, a.requestId, poorQuote);
    expect(broke.status).toBe(402);
    expect(sends(poor)).toBe(0);
    expect((await row(a.requestId)).transferId).toBeNull();

    const rich = await person(50_000_000);
    const m = await made(asker, rich, 120_000);
    const wrong = await quoted(rich, 100_000);
    const w = await pay(rich, m.chatId, m.requestId, wrong);
    expect(w.status).toBe(409);
    expect(code(w)).toBe('quote_changed');
    const good = await quoted(rich, 120_000);
    expect((await pay(rich, m.chatId, m.requestId, good, null)).status).toBe(
      400,
    );
    expect(sends(rich)).toBe(0);
    expect((await pay(rich, m.chatId, m.requestId, good)).status).toBe(201);
    expect(sends(rich)).toBe(1);
  });

  // ---- nothing is held across the provider ---------------------------------

  it('with a 3 s provider, 20 parallel pays and 20 taps on one request leave a bystander under 1 s and no transaction idle', async () => {
    const asker = await person(0);
    const payer = await person(500_000_000);
    const bystander = await person(1_000);
    const friend = await person(0);
    await made(friend, bystander);
    const reqs: Array<{ chatId: string; requestId: string }> = [];
    for (let i = 0; i < 20; i += 1) {
      reqs.push(await made(asker, payer, 100_000 + i));
    }
    const one = await made(asker, payer, 777_000);
    nuvion.delayMs = 3000;
    let longestIdleMs = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const age = await prisma.$queryRawUnsafe<Array<{ ms: number | null }>>(
          `SELECT max(extract(epoch from (now() - state_change)) * 1000)::float8 AS ms FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`,
        );
        longestIdleMs = Math.max(longestIdleMs, Number(age[0]?.ms ?? 0));
        await sleep(150);
      }
    })();
    const quotes = await Promise.all(
      reqs.map((_, i) => quoted(payer, 100_000 + i)),
    );
    const burst = Promise.all(
      reqs.map((r, i) => pay(payer, r.chatId, r.requestId, quotes[i])),
    );
    const q1 = await quoted(payer, 777_000);
    const burst2 = Promise.all(
      Array.from({ length: 20 }, () =>
        pay(payer, one.chatId, one.requestId, q1),
      ),
    );
    await sleep(800);
    const times: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const t0 = Date.now();
      const u = await get(bystander, '/inbox/unread');
      times.push(Date.now() - t0);
      expect(u.status).toBe(200);
      const t1 = Date.now();
      await get(bystander, '/inbox');
      times.push(Date.now() - t1);
      await sleep(300);
    }
    const [a, b] = await Promise.all([burst, burst2]);
    polling = false;
    await poll;
    nuvion.delayMs = 0;
    expect(Math.max(...times)).toBeLessThan(1000);
    expect(a.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(b.filter((r) => r.status === 201)).toHaveLength(1);
    // The provider call holds no open transaction (a 3 s wait would show here).
    expect(longestIdleMs).toBeLessThan(1500);
    await requests.sweep();
  });

  // ---- who may do what ------------------------------------------------------

  it('roles, validation, blocks and the inbox badge', async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const stranger = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer);
    const base = `/chats/${chatId}/money-requests`;
    const noToken = [
      await post(null, base, { amountKobo: 1000 }),
      await get(null, `${base}/${requestId}`),
      await post(null, `${base}/${requestId}/pay`, {}),
      await post(null, `${base}/${requestId}/decline`),
      await post(null, `${base}/${requestId}/cancel`),
    ].map((r) => r.status);
    expect(noToken).toEqual([401, 401, 401, 401, 401]);
    const asStranger = [
      await post(stranger, base, { amountKobo: 1000 }),
      await get(stranger, `${base}/${requestId}`),
      await post(stranger, `${base}/${requestId}/decline`),
      await post(stranger, `${base}/${requestId}/cancel`),
    ].map((r) => r.status);
    expect(asStranger).toEqual([404, 404, 404, 404]);
    expect((await post(asker, `${base}/${requestId}/decline`)).status).toBe(
      403,
    );
    expect((await post(payer, `${base}/${requestId}/cancel`)).status).toBe(403);
    const bad = [
      await post(asker, base, { amountKobo: 0 }),
      await post(asker, base, { amountKobo: 10.5 }),
      await post(asker, base, { amountKobo: -5 }),
      await post(asker, base, { amountKobo: 1000, memo: 'x'.repeat(101) }),
      await post(asker, base, { amountKobo: 1000, memo: 'a\u0000b' }),
      await post(asker, base, { amountKobo: 1000, extra: 1 }),
      await post(asker, base, { amountKobo: '5000' }),
    ].map((r) => r.status);
    expect(bad).toEqual([400, 400, 400, 400, 400, 400, 400]);
    const noWallet = await person(0, false);
    const nwChat = await chatOf(noWallet, payer);
    const nw = await post(noWallet, `/chats/${nwChat}/money-requests`, {
      amountKobo: 1000,
    });
    expect(nw.status).toBe(409);
    expect(code(nw)).toBe('wallet_not_open');
    // The payer's badge counts the request once.
    const unread = body<InboxUnread>(await get(payer, '/inbox/unread')).data!;
    const all = body<InboxPage>(await get(payer, '/inbox')).data!;
    expect(all.items.reduce((n, i) => n + i.unreadCount, 0)).toBe(unread.total);
    const money = body<InboxPage>(
      await get(payer, '/inbox?kind=money_request'),
    ).data!;
    expect(money.items.every((i) => i.unreadCount === 0)).toBe(true);
    // After a block: pay is refused before the PIN, decline is allowed, a new ask is not.
    await prisma.blockedAccount.create({
      data: { userWawuId: asker.id, blockedWawuId: payer.id },
    });
    const q = await quoted(payer, 120_000);
    const pb = await pay(payer, chatId, requestId, q);
    expect(pb.status).toBe(403);
    expect(code(pb)).toBe('recipient_blocked');
    expect((await post(payer, `${base}/${requestId}/decline`)).status).toBe(
      200,
    );
    const ask = await post(payer, base, { amountKobo: 1000 });
    expect(ask.status).toBe(403);
    expect(code(ask)).toBe('chat_blocked');
    expect(
      (await get(payer, `/chats/not-a-uuid/money-requests/${requestId}`))
        .status,
    ).toBe(400);
    expect((await get(payer, `${base}/${randomUUID()}`)).status).toBe(404);
    expect(sends(payer)).toBe(0);
  });

  // ---- erasing an account (round 2) -----------------------------------------

  it("the asker's erase: the reason goes from the request, the send and the inbox, an open request is cancelled, a paid one keeps its money record", async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const open = await made(asker, payer, 111_000);
    const paid = await made(asker, payer, 222_000, open.chatId);
    const paidQuote = await quoted(payer, 222_000);
    const paidKey = randomUUID();
    const first = await pay(
      payer,
      paid.chatId,
      paid.requestId,
      paidQuote,
      paidKey,
    );
    expect(first.status).toBe(201);
    expect((body<TransferView>(first).data as TransferView).note).toBe(MEMO);
    // The words also sit on the send's ledger rows and in the payer's list.
    const sendId = (await row(paid.requestId)).transferId!;
    const ledgerNotes = () =>
      prisma.fintavaLedgerEntry.findMany({
        where: { transferId: sendId },
        select: { note: true },
      });
    expect((await ledgerNotes()).map((l) => l.note)).toContain(MEMO);
    expect(
      JSON.stringify(body(await get(payer, '/money/transactions')).data),
    ).toContain(MEMO);
    const sentNote = async () =>
      (
        await prisma.walletTransfer.findFirstOrThrow({
          where: { payerWawuUserId: payer.id },
        })
      ).note;
    expect(await sentNote()).toBe(MEMO);
    const before = body<InboxPage>(
      await get(payer, '/inbox?kind=money_request'),
    ).data!;
    expect(before.items.map((i) => i.preview?.text)).toEqual([MEMO, MEMO]);

    const done = await erase(asker);
    expect(done.failed).toEqual([]);

    // The open request is closed, the paid one is paid, neither keeps the words.
    expect(await row(open.requestId)).toMatchObject({
      status: 'cancelled',
      memo: null,
      transferId: null,
    });
    expect(await row(paid.requestId)).toMatchObject({
      status: 'paid',
      memo: null,
    });
    expect(
      await prisma.chatMessage.count({
        where: { conversationId: open.chatId, kind: 'money_request' },
      }),
    ).toBe(0);
    expect(await sentNote()).toBeNull();
    // Nor does the ledger keep them, so the payer's list has none; a repeat of
    // the paid key replays the receipt without them.
    const ledgerAfter = await ledgerNotes();
    expect(ledgerAfter.length).toBeGreaterThan(0);
    expect(ledgerAfter.every((l) => l.note === null)).toBe(true);
    const list = await get(payer, '/money/transactions');
    expect(list.status).toBe(200);
    expect(JSON.stringify(body(list).data)).not.toContain(MEMO);
    const replay = await pay(
      payer,
      paid.chatId,
      paid.requestId,
      paidQuote,
      paidKey,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(JSON.stringify(body(replay))).not.toContain(MEMO);
    expect(body<TransferView>(replay).data).toEqual({
      ...(body<TransferView>(first).data as TransferView),
      note: null,
    });
    expect(
      await prisma.moneyIdempotencyKey.count({
        where: { resourceId: sendId, responseBody: { contains: MEMO } },
      }),
    ).toBe(0);
    expect(available(asker)).toBe(222_000n);
    const after = body<InboxPage>(
      await get(payer, '/inbox?kind=money_request'),
    ).data!;
    expect(after.items.map((i) => i.moneyRequest?.status).sort()).toEqual([
      'cancelled',
      'paid',
    ]);
    for (const item of after.items) {
      expect(item.preview?.text ?? null).toBeNull();
      expect(item.moneyRequest?.memo ?? null).toBeNull();
      expect(JSON.stringify(item)).not.toContain(MEMO);
    }
    // Nothing can be paid for the erased person's request any more.
    const q = await quoted(payer, 111_000);
    const p = await pay(payer, open.chatId, open.requestId, q);
    expect(p.status).toBe(409);
    expect(code(p)).toBe('money_request_not_pending');
    expect(sends(payer)).toBe(1);
    // Running the step again changes nothing and does not fail.
    await expect(eraseAskerRequests(prisma, asker.id)).resolves.toEqual({
      closed: 0,
      memosCleared: 0,
      notesCleared: 0,
      ledgerNotesCleared: 0,
      answersBlanked: 0,
    });
  });

  it("the asker's erase while a request is being paid: the send settles first, completed makes it paid, failed closes it", async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const win = await made(asker, payer, 130_000);
    const lose = await made(asker, payer, 140_000, win.chatId);
    nuvion.mode = 'pending';
    expect(
      (
        await pay(
          payer,
          win.chatId,
          win.requestId,
          await quoted(payer, 130_000),
        )
      ).status,
    ).toBe(201);
    const winRef = await transferRef(payer);
    expect(
      (
        await pay(
          payer,
          lose.chatId,
          lose.requestId,
          await quoted(payer, 140_000),
        )
      ).status,
    ).toBe(201);
    const loseRef = await transferRef(payer);
    await erase(asker);

    // Both are still being paid; the words are gone from both and from the sends.
    for (const r of [win, lose]) {
      expect(await row(r.requestId)).toMatchObject({
        status: 'pending',
        memo: null,
      });
      expect((await row(r.requestId)).transferId).not.toBeNull();
    }
    expect(
      await prisma.walletTransfer.count({
        where: { payerWawuUserId: payer.id, note: { not: null } },
      }),
    ).toBe(0);
    // The sends' ledger rows and the answers stored for their keys are clean
    // too, while the sends are still in flight.
    const inFlight = (
      await prisma.walletTransfer.findMany({
        where: { payerWawuUserId: payer.id },
        select: { id: true },
      })
    ).map((t) => t.id);
    expect(inFlight).toHaveLength(2);
    expect(
      await prisma.fintavaLedgerEntry.count({
        where: { transferId: { in: inFlight } },
      }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.fintavaLedgerEntry.count({
        where: { transferId: { in: inFlight }, note: { not: null } },
      }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({
        where: { resourceId: { in: inFlight }, responseBody: { not: null } },
      }),
    ).toBe(2);
    expect(
      await prisma.moneyIdempotencyKey.count({
        where: {
          resourceId: { in: inFlight },
          responseBody: { contains: MEMO },
        },
      }),
    ).toBe(0);

    nuvion.settle(winRef, 'successful');
    nuvion.settle(loseRef, 'failed');
    await sweepLater();
    await Promise.all([requests.sweep(), requests2.sweep()]);
    expect(
      JSON.stringify(body(await get(payer, '/money/transactions')).data),
    ).not.toContain(MEMO);
    expect((await row(win.requestId)).status).toBe('paid');
    expect(await row(lose.requestId)).toMatchObject({
      status: 'cancelled',
      transferId: null,
      memo: null,
    });
    expect(sends(payer)).toBe(2);
  });

  it("the payer's erase: the asker's request stays theirs and open, the asker can still cancel it", async () => {
    const asker = await person(0);
    const payer = await person(50_000_000);
    const { chatId, requestId } = await made(asker, payer, 150_000);
    const done = await erase(payer);
    expect(done.failed).toEqual([]);
    expect(await row(requestId)).toMatchObject({
      status: 'pending',
      memo: MEMO,
      requesterWawuId: asker.id,
    });
    const mine = await view(asker, chatId, requestId);
    expect(mine.status).toBe('pending');
    const cancelled = await post(
      asker,
      `/chats/${chatId}/money-requests/${requestId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect((await row(requestId)).status).toBe('cancelled');
  });

  it('no Fintava host was called', () => {
    expect(fintavaHits).toEqual([]);
  });
});

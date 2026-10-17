// Contract tests for the support chat (task SUPPORT-01, R-30), end to end over
// HTTP with real tokens from the local mock WAWU ID.
//
// The capability checks the task names:
//   1. A person opens the support thread with the payment they ask about
//      already written into it (H18 passes an unlock's payment, W27 a wallet
//      transaction, W35 nothing).
//   2. A second tap reuses the same thread and the same message.
//   3. A staff reply reaches the person's chat, and the thread shows in the
//      inbox as the support thread.
//   4. Another person can never read the thread, and a reference that is not
//      theirs, or does not exist, is refused with the same 404.
//
// Every identity here is a throwaway registered by this spec, and every row it
// writes is removed in afterAll (README, test hygiene).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';
process.env.ADMIN_JWT_SECRET ??=
  'support01-admin-access-secret-0123456789abcdef';
process.env.ADMIN_JWT_REFRESH_SECRET ??=
  'support01-admin-refresh-secret-0123456789abcd';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminSupportModule } from '../../admin/support/admin-support.module';
import { AdminTokenService } from '../../admin/auth/admin-token.service';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../../chat/chat.module';
import { ChatService } from '../../chat/chat.service';
import type {
  ChatMessage,
  ChatMessagePage,
  ChatSummary,
  ChatSummaryPage,
} from '../../chat/chat-view.type';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InboxModule } from '../../inbox/inbox.module';
import type { InboxPage } from '../../inbox/inbox-view.type';
import { SUPPORT_WAWU_ID } from '../support-account';
import { SupportModule } from '../support.module';
import type { SupportThreadView } from '../support-view.type';

const data = <T>(res: Response) => (res.body as { data: T }).data;
const refusal = (res: Response) =>
  res.body as { message: string; reason?: { code?: string } };

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let nonceSeq = 0;
async function registerPerson(
  label: string,
): Promise<{ sub: string; token: string; fullName: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const fullName = `Support Spec ${label}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName,
      email: `support-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken, fullName };
}

describe('Support chat (contract, SUPPORT-01)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;

  // Ada asks for help. Chidi is another person with their own payment.
  let ada: { sub: string; token: string; fullName: string };
  let chidi: { sub: string; token: string; fullName: string };
  const adminIds: string[] = [];
  const adminTokens: Partial<Record<AdminRole, string>> = {};
  const paymentIds: string[] = [];
  const ledgerIds: string[] = [];
  let adaPayment: string;
  let adaLedger: string;
  let chidiPayment: string;
  let chatId: string;

  const http = () => request(app.getHttpServer());
  const as = (who: { token: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${who.token}`).send(body),
  });
  const staff = (role: AdminRole) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${adminTokens[role]}`),
    post: (url: string, body: object = {}) =>
      http()
        .post(url)
        .set('Authorization', `Bearer ${adminTokens[role]}`)
        .send(body),
  });

  async function payment(payer: string, title: string, reference: string) {
    const row = await prisma.walletPayment.create({
      data: {
        payerWawuUserId: payer,
        kind: 'content_unlock',
        targetId: randomUUID(),
        title,
        priceKobo: 250000n,
        providerFeeKobo: 2325n,
        wawuFeeKobo: 0n,
        totalKobo: 252325n,
        payeeShareKobo: 212500n,
        wawuShareKobo: 37500n,
        customerReference: reference,
        merchantAccountNumber: '0000000000',
        status: 'completed',
      },
    });
    paymentIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ada = await registerPerson('Ada');
    chidi = await registerPerson('Chidi');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        ChatModule,
        InboxModule,
        SupportModule,
        AdminSupportModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
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
    prisma = moduleRef.get(PrismaService);

    for (const p of [ada, chidi]) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `supspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for support.contract.spec.ts.',
          interests: [],
        },
      });
    }
    adaPayment = await payment(
      ada.sub,
      'How I light a night shoot',
      `wawu-pay-${randomUUID()}`,
    );
    chidiPayment = await payment(
      chidi.sub,
      'Chidi only',
      `wawu-pay-${randomUUID()}`,
    );
    const entry = await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: ada.sub,
        accountNumber: '0000000001',
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 200000n,
        totalKobo: 200000n,
        counterpartyKind: 'wawu_user',
        counterpartyName: 'Amaka Nwosu',
        customerReference: 'WAW-T1P9-7ZQA',
        source: 'support-spec',
        sourceEventId: randomUUID(),
        occurredAt: new Date(),
      },
    });
    adaLedger = entry.id;
    ledgerIds.push(entry.id);

    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.support,
      AdminRole.reviewer,
      AdminRole.finance,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `support01-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `SUPPORT-01 ${role}`,
          role,
        },
      });
      adminTokens[role] = issuer.issuePair(admin).accessToken;
    }
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      const ids = [ada?.sub, chidi?.sub].filter(Boolean);
      await prisma.chatConversation.deleteMany({
        where: {
          OR: [{ userAWawuId: { in: ids } }, { userBWawuId: { in: ids } }],
        },
      });
      await prisma.walletPayment.deleteMany({
        where: { id: { in: paymentIds } },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { id: { in: ledgerIds } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    if (app) await app.close();
    mockWawuId?.kill();
  });

  describe("opening the person's thread", () => {
    it('401s with no token', async () => {
      await http().post('/support/thread').send({}).expect(401);
    });

    it('W35: opens with nothing attached, and shows no row until something is said', async () => {
      const res = await as(ada).post('/support/thread', {}).expect(200);
      const opened = data<SupportThreadView>(res);
      expect(opened).toEqual({
        chatId: expect.any(String) as unknown,
        reference: null,
        messageId: null,
      });
      chatId = opened.chatId;
      const chat = data<ChatSummary>(await as(ada).get(`/chats/${chatId}`));
      expect(chat.other).toMatchObject({
        wawuId: SUPPORT_WAWU_ID,
        name: 'Who Made This?',
        support: true,
        handle: null,
        avatarUrl: null,
      });
      expect(chat.lastMessage).toBeNull();
      const inbox = data<InboxPage>(await as(ada).get('/inbox'));
      expect(inbox.items).toEqual([]);
    });

    it('H18: a payment of the caller opens the same thread with its reference as the first message', async () => {
      const row = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: adaPayment },
      });
      const res = await as(ada)
        .post('/support/thread', {
          reference: { kind: 'payment', id: adaPayment },
        })
        .expect(200);
      const opened = data<SupportThreadView>(res);
      expect(opened.chatId).toBe(chatId);
      expect(opened.reference).toEqual({
        kind: 'payment',
        id: adaPayment,
        reference: row.customerReference,
      });
      const page = data<ChatMessagePage>(
        await as(ada).get(`/chats/${chatId}/messages`),
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: opened.messageId,
        mine: true,
        kind: 'text',
        text: `Help with a payment: Payment · How I light a night shoot · ₦2,523.25 · Reference ${row.customerReference}`,
      });
      expect(page.items[0].text).not.toContain('—');
    });

    it('a second tap on the same reference reuses the thread and the message', async () => {
      const first = data<SupportThreadView>(
        await as(ada)
          .post('/support/thread', {
            reference: { kind: 'payment', id: adaPayment },
          })
          .expect(200),
      );
      const again = data<SupportThreadView>(
        await as(ada)
          .post('/support/thread', {
            reference: { kind: 'payment', id: adaPayment },
          })
          .expect(200),
      );
      expect(again).toEqual(first);
      const [a, b] = await Promise.all([
        as(ada).post('/support/thread', {
          reference: { kind: 'payment', id: adaPayment },
        }),
        as(ada).post('/support/thread', {
          reference: { kind: 'payment', id: adaPayment },
        }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(data<SupportThreadView>(a).messageId).toBe(first.messageId);
      expect(data<SupportThreadView>(b).messageId).toBe(first.messageId);
      const count = await prisma.chatMessage.count({
        where: { conversationId: chatId },
      });
      expect(count).toBe(1);
    });

    it('W27: a wallet transaction of the caller adds its own message to the same thread', async () => {
      const res = await as(ada)
        .post('/support/thread', {
          reference: { kind: 'transaction', id: adaLedger },
        })
        .expect(200);
      const opened = data<SupportThreadView>(res);
      expect(opened.chatId).toBe(chatId);
      expect(opened.reference).toEqual({
        kind: 'transaction',
        id: adaLedger,
        reference: 'WAW-T1P9-7ZQA',
      });
      const page = data<ChatMessagePage>(
        await as(ada).get(`/chats/${chatId}/messages`),
      );
      expect(page.items).toHaveLength(2);
      expect(page.items[0].text).toBe(
        'Help with a payment: Earning · Amaka Nwosu · ₦2,000.00 · Reference WAW-T1P9-7ZQA',
      );
    });

    it("someone else's reference and one that does not exist are the same 404, and write nothing", async () => {
      const theirs = await as(ada)
        .post('/support/thread', {
          reference: { kind: 'payment', id: chidiPayment },
        })
        .expect(404);
      const none = await as(ada)
        .post('/support/thread', {
          reference: { kind: 'payment', id: randomUUID() },
        })
        .expect(404);
      expect(refusal(theirs).message).toBe(refusal(none).message);
      await as(chidi)
        .post('/support/thread', {
          reference: { kind: 'transaction', id: adaLedger },
        })
        .expect(404);
      await as(chidi)
        .post('/support/thread', {
          reference: { kind: 'payment', id: adaPayment },
        })
        .expect(404);
      // Chidi asked twice and has no thread: a refused reference opens nothing.
      const conversations = await prisma.chatConversation.count({
        where: {
          OR: [{ userAWawuId: chidi.sub }, { userBWawuId: chidi.sub }],
        },
      });
      expect(conversations).toBe(0);
      expect(
        await prisma.chatMessage.count({ where: { conversationId: chatId } }),
      ).toBe(2);
    });

    it('a reference that is not well formed is 400', async () => {
      await as(ada)
        .post('/support/thread', {
          reference: { kind: 'piece', id: adaPayment },
        })
        .expect(400);
      await as(ada)
        .post('/support/thread', { reference: { kind: 'payment', id: 'nope' } })
        .expect(400);
      await as(ada).post('/support/thread', { reference: {} }).expect(400);
    });

    it('the support account cannot be opened as a person through /chats', async () => {
      await as(ada).post('/chats', { wawuId: SUPPORT_WAWU_ID }).expect(404);
    });
  });

  describe('who can read the thread', () => {
    it('another person gets 404 on it, as on a chat that does not exist', async () => {
      const ghost = await as(chidi).get(`/chats/${randomUUID()}`).expect(404);
      const theirs = await as(chidi).get(`/chats/${chatId}`).expect(404);
      expect(refusal(theirs).message).toBe(refusal(ghost).message);
      await as(chidi).get(`/chats/${chatId}/messages`).expect(404);
      await as(chidi)
        .post(`/chats/${chatId}/messages`, { text: 'hello' })
        .expect(404);
      const mine = data<ChatSummaryPage>(await as(chidi).get('/chats'));
      expect(mine.items).toEqual([]);
    });

    it('no money is asked of, or sent to, the support side', async () => {
      const chats = moduleRef.get(ChatService);
      await expect(
        chats.otherInChat(ada.sub, chatId, true),
      ).rejects.toMatchObject({
        response: { reason: { code: 'chat_support_no_money' } },
      });
      // Reading the other side is still allowed.
      await expect(chats.otherInChat(ada.sub, chatId)).resolves.toBe(
        SUPPORT_WAWU_ID,
      );
    });
  });

  describe('staff reply', () => {
    it('401s with no token and refuses reviewer and finance entirely', async () => {
      await http().get('/admin/support/threads').expect(401);
      for (const role of [AdminRole.reviewer, AdminRole.finance]) {
        await staff(role).get('/admin/support/threads').expect(403);
        await staff(role)
          .post(`/admin/support/threads/${chatId}/messages`, { text: 'hi' })
          .expect(403);
      }
    });

    it('the thread waits in the staff list with the person and their words', async () => {
      const list = data<ChatSummaryPage>(
        await staff(AdminRole.support)
          .get('/admin/support/threads')
          .expect(200),
      );
      const row = list.items.find((i) => i.id === chatId);
      expect(row).toBeDefined();
      // The name is WAWU ID's when it answers, else the handle: both name her.
      expect(row!.other).toMatchObject({
        wawuId: ada.sub,
        handle: `supspec_${ada.sub.slice(0, 8)}`,
      });
      expect([ada.fullName, row!.other.handle]).toContain(row!.other.name);
      expect(row!.unreadCount).toBe(2);
      expect(row!.lastMessage?.mine).toBe(false);
    });

    it('a reply lands in the person chat, once per clientMessageId, and shows in the inbox', async () => {
      const reply = (role: AdminRole) =>
        staff(role).post(`/admin/support/threads/${chatId}/messages`, {
          text: 'We can see it. Looking now.',
          clientMessageId: 'reply-support01-a',
        });
      const sent = data<ChatMessage>(
        await reply(AdminRole.support).expect(201),
      );
      const again = data<ChatMessage>(
        await reply(AdminRole.superadmin).expect(201),
      );
      expect(again.id).toBe(sent.id);

      const page = data<ChatMessagePage>(
        await as(ada).get(`/chats/${chatId}/messages`),
      );
      expect(page.items[0]).toMatchObject({
        id: sent.id,
        senderWawuId: SUPPORT_WAWU_ID,
        mine: false,
        text: 'We can see it. Looking now.',
      });
      expect(page.items).toHaveLength(3);

      const inbox = data<InboxPage>(await as(ada).get('/inbox'));
      const row = inbox.items.find((i) => i.id === `chat:${chatId}`);
      expect(row).toMatchObject({
        kind: 'chat',
        unreadCount: 1,
        preview: { text: 'We can see it. Looking now.', mine: false },
        chat: { chatId, other: { name: 'Who Made This?', support: true } },
      });
      const unread = data<{ total: number }>(
        await as(ada).get('/inbox/unread'),
      );
      expect(unread.total).toBe(1);

      // The reply read what came before it: the staff list no longer waits.
      const list = data<ChatSummaryPage>(
        await staff(AdminRole.support)
          .get('/admin/support/threads')
          .expect(200),
      );
      expect(list.items.find((i) => i.id === chatId)?.unreadCount).toBe(0);
    });

    it("the person answers in the same thread, and staff read the thread's messages", async () => {
      await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'Thank you.' })
        .expect(201);
      const page = data<ChatMessagePage>(
        await staff(AdminRole.support)
          .get(`/admin/support/threads/${chatId}/messages`)
          .expect(200),
      );
      expect(page.items.map((m) => [m.mine, m.text])).toEqual([
        [false, 'Thank you.'],
        [true, 'We can see it. Looking now.'],
        [false, expect.stringContaining('Earning · Amaka Nwosu') as unknown],
        [false, expect.stringContaining('Payment · How I light') as unknown],
      ]);
    });

    it('staff cannot read or write a chat between two people', async () => {
      const [a, b] = [ada.sub, chidi.sub].sort();
      const pair = await prisma.chatConversation.create({
        data: {
          userAWawuId: a,
          userBWawuId: b,
          participants: { create: [{ wawuUserId: a }, { wawuUserId: b }] },
        },
      });
      await staff(AdminRole.support)
        .get(`/admin/support/threads/${pair.id}/messages`)
        .expect(404);
      await staff(AdminRole.support)
        .post(`/admin/support/threads/${pair.id}/messages`, { text: 'hi' })
        .expect(404);
      const list = data<ChatSummaryPage>(
        await staff(AdminRole.support)
          .get('/admin/support/threads')
          .expect(200),
      );
      expect(list.items.find((i) => i.id === pair.id)).toBeUndefined();
    });
  });
});

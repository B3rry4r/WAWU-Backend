// Contract tests for the Money filter's sends (task FIX-114, G-INBOX-15-1).
//
// The capability check: a person opens the Money filter (GET /inbox?kind=money)
// and sees the sends they made and received between two WAWU people, next to
// their money requests, each opening the chat of the two. Plus what keeps it
// honest: only your own sends, none without a chat, none failed, a pending one
// only for its sender, a send that paid a request is the request's row, the
// amounts are each send's own row, and nothing else (the unfiltered list, the
// request filter, the badge) reads differently for having sends.
//
// Every identity is a throwaway registered by this spec on the local mock
// WAWU ID, and every row it writes is removed in afterAll (README, test
// hygiene). The spec never calls a wallet provider: a send is a row.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../../chat/chat.module';
import { CommunityModule } from '../../community/community.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { InboxModule } from '../inbox.module';
import type { InboxItem, InboxPage, InboxUnread } from '../inbox-view.type';

const data = <T>(res: Response): T => (res.body as { data: T }).data;

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const HOUR = 3_600_000;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

interface Person {
  sub: string;
  token: string;
  fullName: string;
}

let nonceSeq = 0;
async function registerPerson(label: string): Promise<Person> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const fullName = `Money Move Spec ${label}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName,
      email: `inbox-money-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
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

describe('Inbox Money filter: sends (contract, FIX-114)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;

  // Ana is the person. Bayo and Chi chat with her; Dee has no chat with her.
  // Eke is a bystander with a send of his own to Bayo.
  let ana: Person;
  let bayo: Person;
  let chi: Person;
  let dee: Person;
  let eke: Person;

  const createdTransfers: string[] = [];
  const createdChats: string[] = [];
  const chatIds = new Map<string, string>();
  const people = () => [ana, bayo, chi, dee, eke];

  const http = () => request(app.getHttpServer());
  const as = (who: { token: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
  });
  const inbox = async (who: Person, qs = ''): Promise<InboxPage> =>
    data<InboxPage>(await as(who).get(`/inbox${qs}`).expect(200));
  const unread = async (who: Person): Promise<InboxUnread> =>
    data<InboxUnread>(await as(who).get('/inbox/unread').expect(200));
  const moves = (page: InboxPage): InboxItem[] =>
    page.items.filter((i) => i.kind === 'money_move');

  async function chatBetween(a: Person, b: Person): Promise<string> {
    const [userAWawuId, userBWawuId] = [a.sub, b.sub].sort();
    const conv = await prisma.chatConversation.create({
      data: {
        userAWawuId,
        userBWawuId,
        participants: {
          create: [{ wawuUserId: a.sub }, { wawuUserId: b.sub }],
        },
      },
    });
    createdChats.push(conv.id);
    chatIds.set([a.sub, b.sub].sort().join('|'), conv.id);
    return conv.id;
  }
  const chatOf = (a: Person, b: Person): string =>
    chatIds.get([a.sub, b.sub].sort().join('|')) as string;

  async function send(opts: {
    from: Person;
    to: Person;
    amountKobo: number;
    at: Date;
    status?: 'pending' | 'completed' | 'failed' | 'reversed';
    kind?: 'wawu_user' | 'bank_account';
    note?: string;
  }): Promise<string> {
    const id = randomUUID();
    createdTransfers.push(id);
    await prisma.walletTransfer.create({
      data: {
        id,
        kind: opts.kind ?? 'wawu_user',
        payerWawuUserId: opts.from.sub,
        recipientWawuUserId: opts.to.sub,
        amountKobo: BigInt(opts.amountKobo),
        providerFeeKobo: 1575n,
        wawuFeeKobo: 1000n,
        totalKobo: BigInt(opts.amountKobo) + 2575n,
        note: opts.note ?? null,
        customerReference: `inbox-money-spec-${id}`,
        status: opts.status ?? 'completed',
        createdAt: opts.at,
      },
    });
    return id;
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ana = await registerPerson('Ana');
    bayo = await registerPerson('Bayo');
    chi = await registerPerson('Chi');
    dee = await registerPerson('Dee');
    eke = await registerPerson('Eke');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        ChatModule,
        CommunityModule,
        DirectMessageModule,
        InboxModule,
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

    for (const p of people()) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `mmspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for inbox-money.contract.spec.ts.',
          interests: [],
        },
      });
    }
    await chatBetween(ana, bayo);
    await chatBetween(ana, chi);
    await chatBetween(eke, bayo);
    // Ana and Dee never chatted: a send between them has nothing to open.
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      const ids = people().map((p) => p.sub);
      await prisma.walletTransfer.deleteMany({
        where: { id: { in: createdTransfers } },
      });
      await prisma.chatConversation.deleteMany({
        where: {
          OR: [
            { id: { in: createdChats } },
            { userAWawuId: { in: ids } },
            { userBWawuId: { in: ids } },
          ],
        },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: ids } }, { blockedWawuId: { in: ids } }],
        },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    if (app) await app.close();
    mock?.kill();
  });

  const t0 = Date.now() - 48 * HOUR;
  const at = (hours: number) => new Date(t0 + hours * HOUR);

  it('is empty for a person with no sends, and 401s with no token', async () => {
    await http().get('/inbox?kind=money').expect(401);
    expect(await inbox(ana, '?kind=money')).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('refuses a kind it does not serve: sends are only under money', async () => {
    await as(ana).get('/inbox?kind=money_move').expect(400);
    await as(ana).get('/inbox?kind=moneys').expect(400);
  });

  describe('the sends a person made and received', () => {
    let out: string;
    let inn: string;
    let twin: string;

    beforeAll(async () => {
      out = await send({
        from: ana,
        to: bayo,
        amountKobo: 2_500_000,
        at: at(1),
        note: 'Rent share',
      });
      inn = await send({
        from: chi,
        to: ana,
        amountKobo: 500_000,
        at: at(2),
      });
      // Two sends of the same amount are two rows, never one total.
      twin = await send({
        from: ana,
        to: bayo,
        amountKobo: 2_500_000,
        at: at(3),
      });
      // Someone else's send to Bayo: not Ana's.
      await send({ from: eke, to: bayo, amountKobo: 900_000, at: at(4) });
    });

    it("serves each send as its own row, newest first, with the row's own figures", async () => {
      const page = await inbox(ana, '?kind=money');
      const rows = moves(page);
      expect(rows.map((r) => r.id)).toEqual([
        `money_move:${twin}`,
        `money_move:${inn}`,
        `money_move:${out}`,
      ]);
      const [rTwin, rIn, rOut] = rows;
      expect(rTwin.moneyMove).toMatchObject({
        transferId: twin,
        chatId: chatOf(ana, bayo),
        direction: 'outgoing',
        amountKobo: 2_500_000,
        note: null,
        status: 'completed',
        canMessage: true,
      });
      expect(rTwin.moneyMove?.other.wawuId).toBe(bayo.sub);
      expect(rIn.moneyMove).toMatchObject({
        transferId: inn,
        chatId: chatOf(ana, chi),
        direction: 'incoming',
        amountKobo: 500_000,
      });
      expect(rIn.moneyMove?.other.wawuId).toBe(chi.sub);
      expect(rOut.moneyMove).toMatchObject({
        direction: 'outgoing',
        amountKobo: 2_500_000,
        note: 'Rent share',
      });
      // The row says what it is: a send, with the sender's note as its words.
      expect(rOut.preview).toMatchObject({
        text: 'Rent share',
        mine: true,
        moneyRequest: null,
      });
      expect(rIn.preview?.mine).toBe(false);
      for (const r of rows) {
        expect(r.unreadCount).toBe(0);
        expect(r.chat).toBeNull();
        expect(r.paidDm).toBeNull();
        expect(r.community).toBeNull();
        expect(r.moneyRequest).toBeNull();
      }
      expect(page.nextCursor).toBeNull();
      // No total is served: every figure on the page is one send's own.
      expect(JSON.stringify(page)).not.toMatch(/balance|total/i);
    });

    it('a person sees only the sends they were in', async () => {
      const bystander = moves(await inbox(eke, '?kind=money'));
      expect(bystander.map((r) => r.moneyMove?.amountKobo)).toEqual([900_000]);
      expect(bystander[0].moneyMove?.direction).toBe('outgoing');
      const bayosOwn = moves(await inbox(bayo, '?kind=money'));
      expect(bayosOwn).toHaveLength(3);
      const received = bayosOwn.filter(
        (r) => r.moneyMove?.direction === 'incoming',
      );
      expect(received.map((r) => r.moneyMove?.other.wawuId).sort()).toEqual(
        [ana.sub, ana.sub, eke.sub].sort(),
      );
      expect(moves(await inbox(dee, '?kind=money'))).toHaveLength(0);
    });

    it('the unfiltered list, the request filter and the badge read as they did', async () => {
      const all = await inbox(ana);
      expect(all.items.some((i) => i.kind === 'money_move')).toBe(false);
      expect(all.items.every((i) => i.moneyMove === undefined)).toBe(true);
      expect(moves(await inbox(ana, '?kind=money_request'))).toHaveLength(0);
      expect((await inbox(ana, '?kind=money_request')).items).toEqual([]);
      // The two chats Ana has, with no message in them, are not rows; the
      // badge counts none of the sends.
      expect(await unread(ana)).toEqual({
        total: 0,
        chats: 0,
        paidDms: 0,
        communities: 0,
      });
    });

    it('pages with the one cursor, rows never repeated or skipped', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const qs: string = `?kind=money&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
        const page: InboxPage = await inbox(ana, qs);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        guard += 1;
      } while (cursor && guard < 10);
      expect(seen).toEqual([
        `money_move:${twin}`,
        `money_move:${inn}`,
        `money_move:${out}`,
      ]);
    });
  });

  describe('which sends are rows', () => {
    it('leaves out a failed send, a bank send, and a send with no chat', async () => {
      const failed = await send({
        from: ana,
        to: chi,
        amountKobo: 111_100,
        at: at(10),
        status: 'failed',
      });
      const bank = await send({
        from: ana,
        to: chi,
        amountKobo: 222_200,
        at: at(11),
        kind: 'bank_account',
      });
      const noChat = await send({
        from: ana,
        to: dee,
        amountKobo: 333_300,
        at: at(12),
      });
      const ids = (await inbox(ana, '?kind=money')).items.map((i) => i.id);
      for (const id of [failed, bank, noChat]) {
        expect(ids).not.toContain(`money_move:${id}`);
      }
      // Dee, on the other end of the send with no chat, has none either.
      expect(moves(await inbox(dee, '?kind=money'))).toHaveLength(0);
    });

    it('shows a pending send to its sender only, and a reversed one to both', async () => {
      const pending = await send({
        from: bayo,
        to: chi,
        amountKobo: 444_400,
        at: at(13),
        status: 'pending',
      });
      await chatBetween(bayo, chi);
      const senderRows = moves(await inbox(bayo, '?kind=money'));
      const mine = senderRows.find((r) => r.id === `money_move:${pending}`);
      expect(mine?.moneyMove?.status).toBe('pending');
      expect(mine?.moneyMove?.direction).toBe('outgoing');
      const receiver = moves(await inbox(chi, '?kind=money'));
      expect(receiver.map((r) => r.id)).not.toContain(`money_move:${pending}`);

      // The provider confirms it, then reverses it.
      await prisma.walletTransfer.update({
        where: { id: pending },
        data: { status: 'completed' },
      });
      const settled = moves(await inbox(chi, '?kind=money')).find(
        (r) => r.id === `money_move:${pending}`,
      );
      expect(settled?.moneyMove).toMatchObject({
        status: 'completed',
        direction: 'incoming',
        amountKobo: 444_400,
      });
      await prisma.walletTransfer.update({
        where: { id: pending },
        data: { status: 'reversed' },
      });
      for (const who of [bayo, chi]) {
        const row = moves(await inbox(who, '?kind=money')).find(
          (r) => r.id === `money_move:${pending}`,
        );
        expect(row?.moneyMove?.status).toBe('reversed');
      }
    });

    it("a send that paid a request is the request's row, not a second one", async () => {
      const paying = await send({
        from: chi,
        to: ana,
        amountKobo: 1_200_000,
        at: at(20),
      });
      const chat = chatOf(ana, chi);
      const req = await prisma.moneyRequest.create({
        data: {
          conversationId: chat,
          requesterWawuId: ana.sub,
          payerWawuId: chi.sub,
          amountKobo: 1_200_000n,
          memo: 'Logo edits',
          status: 'paid',
          transferId: paying,
          changedAt: at(21),
        },
      });
      const items = (await inbox(ana, '?kind=money')).items;
      expect(items.map((i) => i.id)).not.toContain(`money_move:${paying}`);
      expect(items.map((i) => i.id)).toContain(`money_request:${req.id}`);
      // The Money filter holds both kinds, in one order: the request (changed
      // at 21) ranks above every send made before it.
      expect(items[0].id).toBe(`money_request:${req.id}`);
      const kinds = new Set(items.map((i) => i.kind));
      expect(kinds).toEqual(new Set(['money_request', 'money_move']));
      // `money_request` still holds requests only.
      expect(
        (await inbox(ana, '?kind=money_request')).items.map((i) => i.id),
      ).toEqual([`money_request:${req.id}`]);
    });

    it('says the chat is closed when either person blocked the other', async () => {
      await prisma.blockedAccount.create({
        data: { userWawuId: ana.sub, blockedWawuId: chi.sub },
      });
      const rows = moves(await inbox(ana, '?kind=money'));
      const toChi = rows.filter((r) => r.moneyMove?.other.wawuId === chi.sub);
      expect(toChi.length).toBeGreaterThan(0);
      for (const r of toChi) expect(r.moneyMove?.canMessage).toBe(false);
      const toBayo = rows.filter((r) => r.moneyMove?.other.wawuId === bayo.sub);
      for (const r of toBayo) expect(r.moneyMove?.canMessage).toBe(true);
    });
  });
});

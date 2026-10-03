// Contract tests for paid-question threads and the creator's waiting list
// (task INBOX-08). Real tokens from the local mock WAWU ID, a real database.
//
// Capability check: a creator sees questions ordered by deadline with the
// right total. Plus the fan's thread (one per creator, every reply bubble),
// who may see what, paging, and the state transition (first reply, further
// replies, the deadline) under parallel requests.
//
// Every identity is a throwaway registered here; every row is removed in
// afterAll.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { DirectMessageModule } from '../direct-message.module';
import type {
  PaidDmQuestion,
  PaidDmQueuePage,
  PaidDmThreadDetail,
  PaidDmThreadPage,
} from '../paid-dm-view.type';

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

let nonceSeq = 0;
async function registerPerson(label: string) {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `PaidDm Spec ${label}`,
      email: `paiddm-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
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
  return { sub: body.user.id, token: body.accessToken };
}

describe('Paid DM threads and the creator queue (contract, INBOX-08)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;

  let chidi: { sub: string; token: string }; // creator
  let bisi: { sub: string; token: string }; // creator, quiet
  let ada: { sub: string; token: string }; // fan
  let bola: { sub: string; token: string }; // fan
  let dayo: { sub: string; token: string }; // fan, no paid questions

  const http = () => request(app.getHttpServer());
  const as = (who: { token: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${who.token}`).send(body),
  });
  const everyone = () => [chidi.sub, bisi.sub, ada.sub, bola.sub, dayo.sub];
  const created: string[] = [];

  /** A paid question already settled, with a chosen deadline. */
  async function question(opts: {
    from: { sub: string };
    to: { sub: string };
    text: string;
    deadlineInMs: number;
    sentAgoMs?: number;
    status?: 'awaiting_response' | 'responded' | 'refunded';
    amount?: number;
  }) {
    const id = randomUUID();
    created.push(id);
    return prisma.directMessage.create({
      data: {
        id,
        creatorWawuId: opts.to.sub,
        senderWawuId: opts.from.sub,
        text: opts.text,
        amount: opts.amount ?? 1500,
        status: opts.status ?? 'awaiting_response',
        sentAt: new Date(Date.now() - (opts.sentAgoMs ?? 1000)),
        deadlineAt: new Date(Date.now() + opts.deadlineInMs),
        flutterwaveTxRef: `paiddm-spec-${id}`,
        responseWindowHours: 24,
      },
    });
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
    chidi = await registerPerson('Chidi');
    bisi = await registerPerson('Bisi');
    ada = await registerPerson('Ada');
    bola = await registerPerson('Bola');
    dayo = await registerPerson('Dayo');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        DirectMessageModule,
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

    for (const [p, type] of [
      [chidi, 'creator'],
      [bisi, 'creator'],
      [ada, 'user'],
      [bola, 'user'],
      [dayo, 'user'],
    ] as const) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: type,
          handle: `paiddm_${p.sub.slice(0, 8)}`,
          interests: [],
        },
      });
    }
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      await prisma.directMessage.deleteMany({ where: { id: { in: created } } });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: everyone() } },
      });
    }
    if (app) await app.close();
    mock?.kill();
  });

  describe('the creator waiting list', () => {
    it('401s with no token, 403s a plain account', async () => {
      await http().get('/paid-dm/queue').expect(401);
      await as(ada).get('/paid-dm/queue').expect(403);
    });

    it('is empty with a total of 0 when nothing waits', async () => {
      const res = await as(bisi).get('/paid-dm/queue').expect(200);
      expect(data<PaidDmQueuePage>(res)).toEqual({
        items: [],
        nextCursor: null,
        waitingTotal: 0,
      });
    });

    it('orders by deadline, soonest first, with the right total', async () => {
      const late = await question({
        from: ada,
        to: chidi,
        text: 'late',
        deadlineInMs: 20 * HOUR,
      });
      const soon = await question({
        from: bola,
        to: chidi,
        text: 'soon',
        deadlineInMs: 2 * HOUR,
      });
      const mid = await question({
        from: ada,
        to: chidi,
        text: 'mid',
        deadlineInMs: 8 * HOUR,
        amount: 3000,
      });
      // None of these may count: answered, refunded, past its deadline but
      // not yet swept, and one waiting on another creator.
      await question({
        from: ada,
        to: chidi,
        text: 'done',
        deadlineInMs: HOUR,
        status: 'responded',
      });
      await question({
        from: ada,
        to: chidi,
        text: 'refunded',
        deadlineInMs: HOUR,
        status: 'refunded',
      });
      await question({
        from: ada,
        to: chidi,
        text: 'expired not swept',
        deadlineInMs: -HOUR,
        sentAgoMs: 25 * HOUR,
      });
      await question({
        from: ada,
        to: bisi,
        text: 'not for chidi',
        deadlineInMs: HOUR,
      });

      const res = await as(chidi).get('/paid-dm/queue').expect(200);
      const page = data<PaidDmQueuePage>(res);
      expect(page.items.map((i) => i.id)).toEqual([soon.id, mid.id, late.id]);
      expect(page.waitingTotal).toBe(3);
      expect(page.nextCursor).toBeNull();
      expect(page.items[1]).toMatchObject({
        text: 'mid',
        amountKobo: 300000,
        sender: { wawuId: ada.sub },
      });
      expect(page.items[0].sender.wawuId).toBe(bola.sub);
    });

    it('pages by deadline and keeps the total across pages', async () => {
      const first = data<PaidDmQueuePage>(
        await as(chidi).get('/paid-dm/queue?limit=2').expect(200),
      );
      expect(first.items.map((i) => i.text)).toEqual(['soon', 'mid']);
      expect(first.waitingTotal).toBe(3);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = data<PaidDmQueuePage>(
        await as(chidi)
          .get(`/paid-dm/queue?limit=2&cursor=${first.nextCursor}`)
          .expect(200),
      );
      expect(second.items.map((i) => i.text)).toEqual(['late']);
      expect(second.waitingTotal).toBe(3);
      expect(second.nextCursor).toBeNull();
    });

    it('breaks a deadline tie by id so a page never skips or repeats', async () => {
      const deadline = new Date(Date.now() + 40 * HOUR);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const id = randomUUID();
        created.push(id);
        ids.push(id);
        await prisma.directMessage.create({
          data: {
            id,
            creatorWawuId: bisi.sub,
            senderWawuId: dayo.sub,
            text: `tie ${i}`,
            amount: 1500,
            deadlineAt: deadline,
            flutterwaveTxRef: `paiddm-spec-${id}`,
          },
        });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/paid-dm/queue?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
        const page = data<PaidDmQueuePage>(await as(bisi).get(url).expect(200));
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      // Bisi has one earlier-deadline question besides these three.
      expect(seen.filter((id) => ids.includes(id))).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('400s a cursor it did not give out', async () => {
      await as(chidi).get('/paid-dm/queue?cursor=garbage').expect(400);
    });

    it('drops a question from the list and the total once it is answered', async () => {
      const [target] = (
        await as(chidi).get('/paid-dm/queue').expect(200).then(data<PaidDmQueuePage>)
      ).items;
      await as(chidi)
        .post(`/paid-dm/questions/${target.id}/replies`, { text: 'On it.' })
        .expect(201);
      const after = data<PaidDmQueuePage>(
        await as(chidi).get('/paid-dm/queue').expect(200),
      );
      expect(after.waitingTotal).toBe(2);
      expect(after.items.map((i) => i.id)).not.toContain(target.id);
    });
  });

  describe('the fan thread', () => {
    let creatorFirst: string;

    it('groups every question to one creator into one thread', async () => {
      const res = await as(ada).get('/paid-dm/threads').expect(200);
      const page = data<PaidDmThreadPage>(res);
      // Ada asked Chidi four things and Bisi one: two threads, not five rows.
      expect(page.items).toHaveLength(2);
      const withChidi = page.items.find((t) => t.other.wawuId === chidi.sub);
      expect(withChidi).toMatchObject({
        side: 'fan',
        questionCount: 5,
      });
      // late and mid wait; done, refunded and the unswept expired one do not.
      expect(withChidi?.waitingCount).toBe(2);
      expect(withChidi?.nextDeadlineAt).not.toBeNull();
      const withBisi = page.items.find((t) => t.other.wawuId === bisi.sub);
      expect(withBisi).toMatchObject({ questionCount: 1, waitingCount: 1 });
      creatorFirst = page.items[0].other.wawuId;
    });

    it('lists only the creators this person asked', async () => {
      const page = data<PaidDmThreadPage>(
        await as(dayo).get('/paid-dm/threads').expect(200),
      );
      // Dayo only asked Bisi in the tie test.
      expect(page.items.map((t) => t.other.wawuId)).toEqual([bisi.sub]);
      expect(creatorFirst).toEqual(expect.any(String));
    });

    it('shows every reply bubble, oldest first, under its question', async () => {
      const q = await question({
        from: bola,
        to: chidi,
        text: 'Three bubbles please',
        deadlineInMs: 12 * HOUR,
      });
      for (const text of ['one', 'two', 'three']) {
        await as(chidi)
          .post(`/paid-dm/questions/${q.id}/replies`, { text })
          .expect(201);
      }
      const detail = data<PaidDmThreadDetail>(
        await as(bola).get(`/paid-dm/threads/${chidi.sub}`).expect(200),
      );
      const shown = detail.questions.find((x) => x.id === q.id);
      expect(shown?.status).toBe('responded');
      expect(shown?.mine).toBe(true);
      expect(shown?.replies.map((r) => r.text)).toEqual(['one', 'two', 'three']);
      expect(shown?.respondedAt).not.toBeNull();
      expect(detail.thread.lastText).toBe('three');
      expect(detail.thread.lastTextMine).toBe(false);
      // The legacy column keeps the first reply, for the web.
      const row = await prisma.directMessage.findUniqueOrThrow({
        where: { id: q.id },
      });
      expect(row.responseText).toBe('one');
    });

    it('a follow-up question sits in the same thread with its own window', async () => {
      await new Promise((r) => setTimeout(r, 20));
      const follow = await question({
        from: bola,
        to: chidi,
        text: 'Follow-up',
        deadlineInMs: 24 * HOUR,
        sentAgoMs: 0,
      });
      const detail = data<PaidDmThreadDetail>(
        await as(bola).get(`/paid-dm/threads/${chidi.sub}`).expect(200),
      );
      // 'soon' (answered in the queue test), the three-bubble one, this one.
      expect(detail.thread.questionCount).toBe(3);
      expect(detail.questions[0].id).toBe(follow.id);
      expect(detail.questions[0].replies).toEqual([]);
      expect(detail.thread.lastTextMine).toBe(true);
      expect(detail.thread.waitingCount).toBe(1);
    });

    it('lets the creator read the same thread from their side', async () => {
      const detail = data<PaidDmThreadDetail>(
        await as(chidi)
          .get(`/paid-dm/threads/${bola.sub}?as=creator`)
          .expect(200),
      );
      expect(detail.thread.side).toBe('creator');
      expect(detail.questions.every((q) => !q.mine)).toBe(true);
      const list = data<PaidDmThreadPage>(
        await as(chidi).get('/paid-dm/threads?as=creator').expect(200),
      );
      expect(list.items.map((t) => t.other.wawuId)).toEqual(
        expect.arrayContaining([ada.sub, bola.sub]),
      );
    });

    it('404s a thread with a person you have no paid questions with, and for a third party', async () => {
      await as(dayo).get(`/paid-dm/threads/${chidi.sub}`).expect(404);
      // Chidi reading as the fan has asked nobody anything.
      await as(chidi).get(`/paid-dm/threads/${bola.sub}`).expect(404);
      await as(ada).get('/paid-dm/threads/not-a-uuid').expect(400);
      await as(ada).get('/paid-dm/threads?as=admin').expect(400);
    });

    it('pages a thread by question, newest first, without repeats', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/paid-dm/threads/${chidi.sub}?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const d = data<PaidDmThreadDetail>(await as(ada).get(url).expect(200));
        seen.push(...d.questions.map((q) => q.id));
        cursor = d.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(5);
    });

    it('pages the thread list, latest activity first, one row per creator', async () => {
      const first = data<PaidDmThreadPage>(
        await as(ada).get('/paid-dm/threads?limit=1').expect(200),
      );
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = data<PaidDmThreadPage>(
        await as(ada)
          .get(`/paid-dm/threads?limit=1&cursor=${first.nextCursor}`)
          .expect(200),
      );
      expect(second.items).toHaveLength(1);
      expect(second.items[0].other.wawuId).not.toBe(first.items[0].other.wawuId);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe('replying', () => {
    it('401s with no token and 403s a plain account', async () => {
      const q = await question({
        from: ada,
        to: chidi,
        text: 'auth',
        deadlineInMs: HOUR,
      });
      await http()
        .post(`/paid-dm/questions/${q.id}/replies`)
        .send({ text: 'x' })
        .expect(401);
      await as(ada)
        .post(`/paid-dm/questions/${q.id}/replies`, { text: 'x' })
        .expect(403);
    });

    it('403s a creator it was not sent to, 404s an unknown id, 400s empty text', async () => {
      const q = await question({
        from: ada,
        to: chidi,
        text: 'mine not yours',
        deadlineInMs: HOUR,
      });
      await as(bisi)
        .post(`/paid-dm/questions/${q.id}/replies`, { text: 'x' })
        .expect(403);
      await as(chidi)
        .post(`/paid-dm/questions/${randomUUID()}/replies`, { text: 'x' })
        .expect(404);
      await as(chidi)
        .post(`/paid-dm/questions/${q.id}/replies`, { text: '   ' })
        .expect(400);
      await as(chidi)
        .post(`/paid-dm/questions/${q.id}/replies`, {})
        .expect(400);
    });

    it('409s once the window has passed, and for a refunded question', async () => {
      const late = await question({
        from: ada,
        to: chidi,
        text: 'too late',
        deadlineInMs: -HOUR,
        sentAgoMs: 25 * HOUR,
      });
      const res = await as(chidi)
        .post(`/paid-dm/questions/${late.id}/replies`, { text: 'sorry' })
        .expect(409);
      expect((res.body as { message: string }).message).toMatch(/has passed/);
      const refunded = await question({
        from: ada,
        to: chidi,
        text: 'gone',
        deadlineInMs: HOUR,
        status: 'refunded',
      });
      await as(chidi)
        .post(`/paid-dm/questions/${refunded.id}/replies`, { text: 'x' })
        .expect(409);
      expect(
        await prisma.dmReply.count({
          where: { messageId: { in: [late.id, refunded.id] } },
        }),
      ).toBe(0);
    });

    it('409s a further reply once the window closes on an answered question', async () => {
      const q = await question({
        from: ada,
        to: chidi,
        text: 'answered then closed',
        deadlineInMs: HOUR,
      });
      await as(chidi)
        .post(`/paid-dm/questions/${q.id}/replies`, { text: 'first' })
        .expect(201);
      await prisma.directMessage.update({
        where: { id: q.id },
        data: { deadlineAt: new Date(Date.now() - 1000) },
      });
      await as(chidi)
        .post(`/paid-dm/questions/${q.id}/replies`, { text: 'second' })
        .expect(409);
      expect(await prisma.dmReply.count({ where: { messageId: q.id } })).toBe(1);
    });

    it('parallel first replies: one flips the status, all land as bubbles, none is lost', async () => {
      const q = await question({
        from: ada,
        to: chidi,
        text: 'race',
        deadlineInMs: HOUR,
      });
      const results = await Promise.all(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((text) =>
          as(chidi).post(`/paid-dm/questions/${q.id}/replies`, { text }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
      const row = await prisma.directMessage.findUniqueOrThrow({
        where: { id: q.id },
        include: { replies: true },
      });
      expect(row.status).toBe('responded');
      expect(row.replies).toHaveLength(6);
      // responseText is exactly the reply that won the flip, never blank.
      expect(row.replies.map((r) => r.text)).toContain(row.responseText);
      expect(row.respondedAt).not.toBeNull();
    });

    it('parallel replies racing the deadline sweep never leave a refunded question answered', async () => {
      const q = await question({
        from: ada,
        to: chidi,
        text: 'sweep race',
        deadlineInMs: 60_000,
      });
      // The sweep's own write (scheduler.service.ts): flip only a question
      // that is still waiting and past its deadline.
      await prisma.directMessage.update({
        where: { id: q.id },
        data: { deadlineAt: new Date(Date.now() - 1) },
      });
      const sweep = prisma.directMessage.updateMany({
        where: {
          id: q.id,
          status: 'awaiting_response',
          deadlineAt: { lt: new Date() },
        },
        data: { status: 'refunded', refundStatus: 'owed' },
      });
      const replies = Promise.all(
        [1, 2, 3].map((n) =>
          as(chidi).post(`/paid-dm/questions/${q.id}/replies`, {
            text: `r${n}`,
          }),
        ),
      );
      const [, rs] = await Promise.all([sweep, replies]);
      const row = await prisma.directMessage.findUniqueOrThrow({
        where: { id: q.id },
        include: { replies: true },
      });
      // The deadline had already passed: every reply is refused and the
      // sweep wins, so there is no state with both a refund owed and a reply.
      expect(rs.map((r) => r.status)).toEqual([409, 409, 409]);
      expect(row.status).toBe('refunded');
      expect(row.replies).toHaveLength(0);
    });
  });

  describe('the live POST /dm/:messageId/respond still answers once', () => {
    it('records the reply bubble too, and refuses a second respond', async () => {
      const q = await question({
        from: ada,
        to: chidi,
        text: 'legacy',
        deadlineInMs: HOUR,
      });
      const first = await as(chidi)
        .post(`/dm/${q.id}/respond`, { text: 'legacy reply' });
      expect([200, 201]).toContain(first.status);
      expect(data<{ status: string; responseText: string }>(first)).toMatchObject({
        status: 'responded',
        responseText: 'legacy reply',
      });
      await as(chidi)
        .post(`/dm/${q.id}/respond`, { text: 'again' })
        .expect(409);
      const detail = data<PaidDmThreadDetail>(
        await as(ada).get(`/paid-dm/threads/${chidi.sub}?limit=100`).expect(200),
      );
      expect(
        detail.questions.find((x: PaidDmQuestion) => x.id === q.id)?.replies,
      ).toHaveLength(1);
    });

    it('parallel responds: exactly one wins, the rest 409', async () => {
      const q = await question({
        from: bola,
        to: chidi,
        text: 'legacy race',
        deadlineInMs: HOUR,
      });
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          as(chidi).post(`/dm/${q.id}/respond`, { text: `r${n}` }),
        ),
      );
      const ok = results.filter((r) => r.status < 300);
      expect(ok).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await prisma.dmReply.count({ where: { messageId: q.id } })).toBe(1);
    });
  });
});

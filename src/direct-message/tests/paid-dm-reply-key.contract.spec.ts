// Contract tests for the optional Idempotency-Key on the paid question reply
// route (task INBOX-18 round 2, verifier F1). Real tokens from the local mock
// WAWU ID, a real database.
//
// Capability check: a creator whose Reply was tapped twice at once, or sent
// again after a lost answer, still gives ONE bubble. Without the header the
// route behaves exactly as it did.
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
import type { PaidDmQuestion } from '../paid-dm-view.type';

const data = <T>(res: Response): T => (res.body as { data: T }).data;
const replayed = (res: Response): boolean =>
  res.headers['idempotent-replayed'] === 'true';

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
      fullName: `ReplyKey Spec ${label}`,
      email: `replykey-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
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

async function boot(): Promise<{
  app: INestApplication<App>;
  prisma: PrismaService;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      DirectMessageModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
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
  return { app, prisma: moduleRef.get(PrismaService) };
}

describe('Paid question reply Idempotency-Key (contract, INBOX-18 round 2)', () => {
  let app: INestApplication<App>;
  // A second, separate Nest application on the same database: its own
  // connection pool, as a second server would have.
  let otherApp: INestApplication<App>;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;

  let chidi: { sub: string; token: string }; // creator
  let bisi: { sub: string; token: string }; // creator
  let ada: { sub: string; token: string }; // fan
  const created: string[] = [];

  const post = (
    server: INestApplication<App>,
    who: { token: string },
    messageId: string,
    text: string,
    key?: string,
  ) => {
    const req = request(server.getHttpServer())
      .post(`/paid-dm/questions/${messageId}/replies`)
      .set('Authorization', `Bearer ${who.token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send({ text });
  };

  const newKey = () => `reply-${randomUUID()}`;

  /** A paid question, still open, from Ada to the given creator. */
  async function question(
    to: { sub: string },
    opts: {
      deadlineInMs?: number;
      status?: 'awaiting_response' | 'responded';
    } = {},
  ) {
    const id = randomUUID();
    created.push(id);
    return prisma.directMessage.create({
      data: {
        id,
        creatorWawuId: to.sub,
        senderWawuId: ada.sub,
        text: 'Which lens would you take on a trip?',
        amount: 1500,
        status: opts.status ?? 'awaiting_response',
        sentAt: new Date(Date.now() - 1000),
        deadlineAt: new Date(Date.now() + (opts.deadlineInMs ?? 6 * HOUR)),
        flutterwaveTxRef: `replykey-spec-${id}`,
        responseWindowHours: 24,
      },
    });
  }

  const bubbles = (messageId: string) =>
    prisma.dmReply.findMany({ where: { messageId } });
  const keyRows = (creatorWawuId: string) =>
    prisma.dmReplyKey.findMany({ where: { creatorWawuId } });

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
    ({ app, prisma } = await boot());
    ({ app: otherApp } = await boot());

    for (const [p, type] of [
      [chidi, 'creator'],
      [bisi, 'creator'],
      [ada, 'user'],
    ] as const) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: type,
          handle: `replykey_${p.sub.slice(0, 8)}`,
          interests: [],
        },
      });
    }
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      await prisma.directMessage.deleteMany({ where: { id: { in: created } } });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: [chidi.sub, bisi.sub, ada.sub] } },
      });
    }
    if (app) await app.close();
    if (otherApp) await otherApp.close();
    mock?.kill();
  });

  it('two taps at once with one key, then a retry: one bubble, the others answer with it', async () => {
    const q = await question(chidi);
    const key = newKey();

    const taps = await Promise.all([
      post(app, chidi, q.id, 'The 35mm. Light and sharp.', key),
      post(app, chidi, q.id, 'The 35mm. Light and sharp.', key),
    ]);
    const retry = await post(
      app,
      chidi,
      q.id,
      'The 35mm. Light and sharp.',
      key,
    );

    for (const res of [...taps, retry]) expect(res.status).toBe(201);
    // Exactly one of the three stored the bubble; the other two replayed it.
    expect([...taps, retry].filter((r) => !replayed(r))).toHaveLength(1);
    for (const res of [...taps, retry]) {
      const body = data<PaidDmQuestion>(res);
      expect(body.id).toBe(q.id);
      expect(body.replies.map((r) => r.text)).toEqual([
        'The 35mm. Light and sharp.',
      ]);
    }
    expect(await bubbles(q.id)).toHaveLength(1);
    expect(
      (await keyRows(chidi.sub)).filter((k) => k.key === key),
    ).toHaveLength(1);
    const row = await prisma.directMessage.findUniqueOrThrow({
      where: { id: q.id },
    });
    expect(row.status).toBe('responded');
  });

  it('four taps at once across two servers with one key: one bubble', async () => {
    const q = await question(chidi);
    const key = newKey();
    const sends = await Promise.all(
      [app, otherApp, app, otherApp].map((server) =>
        post(server, chidi, q.id, 'Taking the zoom.', key),
      ),
    );
    for (const res of sends) expect(res.status).toBe(201);
    expect(sends.filter((r) => !replayed(r))).toHaveLength(1);
    expect(await bubbles(q.id)).toHaveLength(1);
  });

  it('two taps at once on an already answered question: still one new bubble', async () => {
    const q = await question(chidi);
    await post(app, chidi, q.id, 'First.', newKey()).expect(201);
    const key = newKey();
    const sends = await Promise.all([
      post(app, chidi, q.id, 'And one more thing.', key),
      post(otherApp, chidi, q.id, 'And one more thing.', key),
    ]);
    for (const res of sends) expect(res.status).toBe(201);
    expect(sends.filter((r) => !replayed(r))).toHaveLength(1);
    expect((await bubbles(q.id)).map((r) => r.text).sort()).toEqual([
      'And one more thing.',
      'First.',
    ]);
  });

  it('a retry with the key returns the first answer and stores nothing again', async () => {
    const q = await question(chidi);
    const key = newKey();
    const first = await post(app, chidi, q.id, 'Sure thing.', key).expect(201);
    expect(replayed(first)).toBe(false);

    const again = await post(app, chidi, q.id, 'Sure thing.', key).expect(201);
    expect(replayed(again)).toBe(true);
    expect(data<PaidDmQuestion>(again).replies).toHaveLength(1);
    expect(data<PaidDmQuestion>(again).replies[0].id).toBe(
      data<PaidDmQuestion>(first).replies[0].id,
    );
    expect(await bubbles(q.id)).toHaveLength(1);
  });

  it('a retry after a later bubble still answers, and does not add a bubble', async () => {
    const q = await question(chidi);
    const key = newKey();
    await post(app, chidi, q.id, 'One.', key).expect(201);
    await post(app, chidi, q.id, 'Two.', newKey()).expect(201);
    const again = await post(app, chidi, q.id, 'One.', key).expect(201);
    expect(replayed(again)).toBe(true);
    expect(data<PaidDmQuestion>(again).replies.map((r) => r.text)).toEqual([
      'One.',
      'Two.',
    ]);
    expect(await bubbles(q.id)).toHaveLength(2);
  });

  it('a new reply with a new key is a new bubble', async () => {
    const q = await question(chidi);
    await post(app, chidi, q.id, 'Same words.', newKey()).expect(201);
    const second = await post(app, chidi, q.id, 'Same words.', newKey()).expect(
      201,
    );
    expect(replayed(second)).toBe(false);
    expect(await bubbles(q.id)).toHaveLength(2);
  });

  it('the same key for other words, or for another question, is 409 idempotency_key_reused and stores nothing', async () => {
    const q = await question(chidi);
    const other = await question(chidi);
    const key = newKey();
    await post(app, chidi, q.id, 'The first words.', key).expect(201);

    const words = await post(app, chidi, q.id, 'Different words.', key);
    expect(words.status).toBe(409);
    expect((words.body as { reason?: string }).reason).toBe(
      'idempotency_key_reused',
    );
    const elsewhere = await post(app, chidi, other.id, 'The first words.', key);
    expect(elsewhere.status).toBe(409);
    expect((elsewhere.body as { reason?: string }).reason).toBe(
      'idempotency_key_reused',
    );

    expect(await bubbles(q.id)).toHaveLength(1);
    expect(await bubbles(other.id)).toHaveLength(0);
  });

  it("a key is the creator's own: another creator sending the same key is not a repeat", async () => {
    const mine = await question(chidi);
    const theirs = await question(bisi);
    const key = newKey();
    const a = await post(app, chidi, mine.id, 'Hello.', key).expect(201);
    const b = await post(app, bisi, theirs.id, 'Hello.', key).expect(201);
    expect(replayed(a)).toBe(false);
    expect(replayed(b)).toBe(false);
    expect(await bubbles(mine.id)).toHaveLength(1);
    expect(await bubbles(theirs.id)).toHaveLength(1);
  });

  it('a malformed key is 400 and nothing is stored', async () => {
    const q = await question(chidi);
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(129)]) {
      await post(app, chidi, q.id, 'Words.', bad).expect(400);
    }
    expect(await bubbles(q.id)).toHaveLength(0);
  });

  it('a refused request stores no key: the same key works once the cause is fixed', async () => {
    const late = await question(chidi, { deadlineInMs: -HOUR });
    const key = newKey();
    await post(app, chidi, late.id, 'Too late.', key).expect(409);
    expect(
      (await keyRows(chidi.sub)).filter((k) => k.key === key),
    ).toHaveLength(0);
    expect(await bubbles(late.id)).toHaveLength(0);

    const open = await question(chidi);
    await post(app, chidi, open.id, 'Too late.', key).expect(201);
  });

  it('without the header it behaves as it always did: every call is a bubble', async () => {
    const q = await question(chidi);
    const sends = await Promise.all([
      post(app, chidi, q.id, 'Again.'),
      post(app, chidi, q.id, 'Again.'),
      post(otherApp, chidi, q.id, 'Again.'),
    ]);
    for (const res of sends) {
      expect(res.status).toBe(201);
      expect(replayed(res)).toBe(false);
    }
    expect(await bubbles(q.id)).toHaveLength(3);
    expect(
      await prisma.dmReplyKey.count({
        where: { reply: { messageId: q.id } },
      }),
    ).toBe(0);
  });

  it('the key goes with its bubble when the question is removed', async () => {
    const q = await question(chidi);
    const key = newKey();
    await post(app, chidi, q.id, 'Gone soon.', key).expect(201);
    await prisma.directMessage.delete({ where: { id: q.id } });
    expect(
      (await keyRows(chidi.sub)).filter((k) => k.key === key),
    ).toHaveLength(0);
  });
});

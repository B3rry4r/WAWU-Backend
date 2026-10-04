// Hardening tests for live updates (task INBOX-02, fix round 1): paging that
// loses nothing, a publisher that only warns when it really fails, requests
// with an Upgrade header that behave as they do without the live module, a
// shutdown that tells sockets 1001, a feed that proves it can hear, and the
// per-socket and per-address limits.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../../chat/chat.module';
import { LiveModule } from '../live.module';
import { LiveListener } from '../live-listener.service';
import { LiveConnections } from '../live-connections.service';
import { LIVE_LIMITS } from '../live-limits';
import type { LiveCatchUp, LiveEvent } from '../live-event.type';
import {
  Client,
  data,
  MOCK_DIR,
  MOCK_WAWU_ID_BASE,
  MOCK_WAWU_ID_PORT,
  registerPerson,
  settle,
  waitForHealth,
  type Person,
} from './live-test-kit.test';
import type { ChatSummary } from '../../chat/chat-view.type';

const bearer = (p: Person) => ({ Authorization: `Bearer ${p.token}` });

async function boot(
  withLive: boolean,
): Promise<{ app: INestApplication<App>; port: number }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      BlockedAccountModule,
      withLive ? LiveModule : ChatModule,
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
  await app.listen(0);
  const address = (app.getHttpServer() as { address(): unknown }).address();
  return { app, port: (address as net.AddressInfo).port };
}

/** One raw HTTP exchange: the status and body, or 'hang' if nothing complete came back. */
function raw(
  port: number,
  head: string,
  body = '',
): Promise<{ status: number; body: string } | 'hang'> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('hang');
    }, 4000);
    const done = (): boolean => {
      const text = buf.toString('utf8');
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return false;
      const length = /content-length:\s*(\d+)/i.exec(text.slice(0, end));
      const chunked = /transfer-encoding:\s*chunked/i.test(text.slice(0, end));
      const bodyText = text.slice(end + 4);
      if (length && Buffer.byteLength(bodyText) < Number(length[1]))
        return false;
      if (chunked && !bodyText.endsWith('0\r\n\r\n')) return false;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]),
        body: bodyText,
      });
      return true;
    };
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      done();
    });
    socket.on('close', () => {
      if (!done()) {
        clearTimeout(timer);
        resolve('hang');
      }
    });
    socket.on('error', () => undefined);
    socket.write(head + body);
  });
}

describe('Live updates, hardening (contract, INBOX-02)', () => {
  let app: INestApplication<App>;
  let port: number;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ada: Person;
  let bola: Person;
  let chatId: string;
  let communityId: string;
  const extra: INestApplication<App>[] = [];
  const sockets: Client[] = [];

  const open = async (...args: Parameters<typeof Client.open>) => {
    const c = await Client.open(...args);
    sockets.push(c);
    return c;
  };
  const as = (who: Person) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set(bearer(who)),
    post: (url: string, body: object = {}) =>
      request(app.getHttpServer()).post(url).set(bearer(who)).send(body),
  });

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: MOCK_DIR,
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ada = await registerPerson('HardAda');
    bola = await registerPerson('HardBola');
    ({ app, port } = await boot(true));
    prisma = app.get(PrismaService);
    for (const p of [ada, bola]) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `hardspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for live-hardening.contract.spec.ts.',
          interests: [],
        },
      });
    }
    chatId = data<ChatSummary>(
      await as(ada).post('/chats', { wawuId: bola.sub }).expect(200),
    ).id;
    const community = await prisma.community.create({
      data: {
        name: 'Live hardening room',
        description: 'Fixture for live-hardening.contract.spec.ts.',
        hostWawuId: ada.sub,
        kind: 'open',
      },
    });
    communityId = community.id;
    await prisma.communityMembership.create({
      data: {
        userWawuId: bola.sub,
        communityId,
        status: 'joined',
        joinedAt: new Date(),
      },
    });
  }, 60000);

  afterAll(async () => {
    for (const c of sockets) c.ws.terminate();
    if (prisma) {
      const ids = [ada?.sub, bola?.sub].filter(Boolean);
      await prisma.chatConversation.deleteMany({
        where: {
          OR: [{ userAWawuId: { in: ids } }, { userBWawuId: { in: ids } }],
        },
      });
      if (communityId) {
        await prisma.community.deleteMany({ where: { id: communityId } });
      }
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    for (const a of extra) await a.close();
    if (app) await app.close();
    mockWawuId?.kill();
  });

  describe('paging that loses nothing', () => {
    async function pageThrough(
      who: Person,
      start: string,
      limit: number,
    ): Promise<LiveEvent[]> {
      const all: LiveEvent[] = [];
      let cursor: string | undefined = start;
      for (let guard = 0; guard < 60 && cursor !== undefined; guard += 1) {
        const page: LiveCatchUp = data<LiveCatchUp>(
          await as(who)
            .get(`/live/catch-up?cursor=${cursor}&limit=${limit}`)
            .expect(200),
        );
        all.push(...page.events);
        cursor = page.hasMore ? page.cursor : undefined;
      }
      expect(cursor).toBeUndefined();
      return all;
    }

    it.each([1, 2, 3, 4, 5])(
      'returns every one of six rows stored in the same millisecond, in pages of %i',
      async (limit) => {
        const start = data<LiveCatchUp>(
          await as(bola).get('/live/catch-up').expect(200),
        );
        await settle(30);
        const at = new Date();
        const rows = await Promise.all([
          ...[0, 1, 2].map((i) =>
            prisma.chatMessage.create({
              data: {
                conversationId: chatId,
                senderWawuId: ada.sub,
                kind: 'text',
                text: `same ms chat ${limit}-${i}`,
                createdAt: at,
              },
            }),
          ),
          ...[0, 1, 2].map((i) =>
            prisma.communityMessage.create({
              data: {
                communityId,
                senderWawuId: ada.sub,
                text: `same ms room ${limit}-${i}`,
                costInCredits: 0,
                sentAt: at,
              },
            }),
          ),
        ]);
        const events = await pageThrough(bola, start.cursor, limit);
        const got = new Set(
          events.map((e) =>
            e.type === 'chat.message' || e.type === 'community.message'
              ? e.message.id
              : '',
          ),
        );
        for (const r of rows) expect(got.has(r.id)).toBe(true);
      },
    );

    it('rejects a cursor with a position that is not one the server gave out', async () => {
      const t = new Date().toISOString();
      for (const bad of [
        `${t}|1|x|abc`,
        `${t}|1|m`,
        `${t}|1|m|not-a-uuid`,
        `${t}|0|m|${'a'.repeat(36)}`,
      ]) {
        const cursor = Buffer.from(bad, 'utf8').toString('base64url');
        await as(bola).get(`/live/catch-up?cursor=${cursor}`).expect(400);
      }
    });
  });

  describe('publishing', () => {
    it('logs nothing on a normal publish, and warns only when it really fails', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        await as(ada)
          .post(`/chats/${chatId}/messages`, { text: 'quiet publish' })
          .expect(201);
        await settle(200);
        expect(
          warn.mock.calls.filter((c) =>
            String(c[0]).includes('Could not signal'),
          ),
        ).toEqual([]);

        const failing = jest
          .spyOn(
            prisma as unknown as { $executeRaw: () => Promise<number> },
            '$executeRaw',
          )
          .mockRejectedValueOnce(new Error('NOTIFY refused'));
        const sent = await as(ada)
          .post(`/chats/${chatId}/messages`, { text: 'loud publish' })
          .expect(201);
        failing.mockRestore();
        expect(
          warn.mock.calls.filter((c) =>
            String(c[0]).includes('Could not signal chat.message'),
          ),
        ).toHaveLength(1);
        expect(
          await prisma.chatMessage.count({
            where: { id: data<{ id: string }>(sent).id },
          }),
        ).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('requests that carry an Upgrade header', () => {
    it('get the answer they get without the live module, for any path and method', async () => {
      const plain = await boot(false);
      extra.push(plain.app);
      const body = JSON.stringify({ wawuId: bola.sub });
      const upgrades = [
        'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n',
        'Connection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQAoAAAAAIAAAAA\r\n',
      ];
      const cases: Array<[string, string, string, string]> = [
        ['GET', '/chats', '', ''],
        ['GET', '/no-such-path', '', ''],
        ['GET', '/api/hub/live', '', ''],
        ['GET', '/api/hub/live/other', '', ''],
        [
          'POST',
          '/chats',
          `Authorization: Bearer ${ada.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`,
          body,
        ],
        ['DELETE', '/chats/123', '', ''],
      ];
      for (const [method, p, extraHeaders, payload] of cases) {
        for (const upgrade of upgrades) {
          // A real WebSocket handshake at the live path is the one request that
          // is meant to differ: it is answered 101.
          if (p === '/api/hub/live' && upgrade === upgrades[0]) continue;
          const head = `${method} ${p} HTTP/1.1\r\nHost: localhost\r\n${upgrade}${extraHeaders}\r\n`;
          const onMain = await raw(plain.port, head, payload);
          const onBranch = await raw(port, head, payload);
          expect(onMain).not.toBe('hang');
          expect(onBranch).toEqual(onMain);
        }
      }
    }, 120000);
  });

  describe('a running server told to stop', () => {
    it('tells its sockets 1001 and exits promptly on SIGTERM', async () => {
      const fixturePort = 38000 + Math.floor(Math.random() * 1000);
      const child = spawn(
        process.execPath,
        [
          '-r',
          path.join(__dirname, 'ts-preload.js'),
          path.join(__dirname, 'live-server.fixture.ts'),
        ],
        {
          cwd: path.join(__dirname, '../../..'),
          env: {
            ...process.env,
            LIVE_FIXTURE_PORT: String(fixturePort),
            TS_NODE_PROJECT: path.join(__dirname, '../../../tsconfig.json'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      const exited = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
      );
      const started = Date.now();
      while (!output.includes('listening') && Date.now() - started < 60000) {
        await settle(100);
      }
      expect(output).toContain('listening');
      const live = await Promise.all(
        [ada, bola, ada].map((p) => Client.open(fixturePort, p.token)),
      );
      sockets.push(...live);
      const sentAt = Date.now();
      child.kill('SIGTERM');
      const closes = await Promise.all(live.map((c) => c.closedWith(5000)));
      for (const c of closes) expect(c.code).toBe(1001);
      const result = await Promise.race([
        exited,
        settle(5000).then(() => 'hung' as const),
      ]);
      expect(result).not.toBe('hung');
      expect(Date.now() - sentAt).toBeLessThan(5000);
      expect(result).toEqual(expect.objectContaining({ signal: 'SIGTERM' }));
    }, 90000);
  });

  describe('a feed that must prove it can hear', () => {
    it('closes every socket with 4503 and refuses new ones when the listener goes deaf, then recovers', async () => {
      const second = await boot(true);
      extra.push(second.app);
      const c = await open(second.port, ada.token);
      const listener = second.app.get(LiveListener);
      // A healthy check changes nothing and sends clients nothing.
      await listener.checkNow();
      await settle(200);
      expect(c.closed).toBeUndefined();
      expect(c.events()).toEqual([]);

      // Deaf: the session stops listening but the connection stays up.
      await (
        listener as unknown as {
          client: { query(q: string): Promise<unknown> };
        }
      ).client.query('UNLISTEN wawu_live');
      const error = jest.spyOn(Logger.prototype, 'error');
      try {
        await listener.checkNow();
        expect((await c.closedWith()).code).toBe(4503);
        expect(await Client.refused(second.port)).toBe(503);
        expect(
          error.mock.calls.some((e) =>
            String(e[0]).includes('did not receive its own probe'),
          ),
        ).toBe(true);
      } finally {
        error.mockRestore();
      }
      let back: Client | undefined;
      for (let i = 0; i < 40 && !back; i += 1) {
        try {
          back = await open(second.port, ada.token);
        } catch {
          await settle(250);
        }
      }
      expect(back?.ready?.wawuId).toBe(ada.sub);
    }, 40000);

    // PgBouncer is the tool that shows the failure; without it installed the
    // other deaf-listener test above still covers the same check.
    const hasPooler = spawnSync('pgbouncer', ['--version']).status === 0;
    (hasPooler ? it : it.skip)(
      'behind a transaction-mode pooler it never accepts a socket and says why',
      async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'live-pgbouncer-'));
        // PgBouncer refuses to run as root, and then needs the folder to be its own.
        chmodSync(dir, 0o777);
        writeFileSync(path.join(dir, 'users.txt'), '"postgres" ""\n', {
          mode: 0o644,
        });
        const db = new URL(process.env.DATABASE_URL!);
        const poolPort = 36000 + Math.floor(Math.random() * 1000);
        writeFileSync(
          path.join(dir, 'pgbouncer.ini'),
          [
            '[databases]',
            `${db.pathname.slice(1)} = host=${db.hostname} port=${db.port} dbname=${db.pathname.slice(1)}`,
            '[pgbouncer]',
            'listen_addr = 127.0.0.1',
            `listen_port = ${poolPort}`,
            'auth_type = trust',
            `auth_file = ${path.join(dir, 'users.txt')}`,
            'pool_mode = transaction',
            'max_client_conn = 100',
            'default_pool_size = 5',
            `logfile = ${path.join(dir, 'pgbouncer.log')}`,
            `pidfile = ${path.join(dir, 'pgbouncer.pid')}`,
            '',
          ].join('\n'),
        );
        const pooler = spawn(
          'pgbouncer',
          [
            ...(process.getuid?.() === 0 ? ['-u', 'postgres'] : []),
            path.join(dir, 'pgbouncer.ini'),
          ],
          {
            stdio: 'ignore',
          },
        );
        const direct = process.env.DATABASE_URL;
        const error = jest.spyOn(Logger.prototype, 'error');
        let pooled: { app: INestApplication<App>; port: number } | undefined;
        try {
          for (let i = 0; i < 50; i += 1) {
            const up = await new Promise<boolean>((resolve) => {
              const s = net.connect(poolPort, '127.0.0.1');
              s.on('connect', () => (s.destroy(), resolve(true)));
              s.on('error', () => resolve(false));
            });
            if (up) break;
            await settle(100);
          }
          const via = new URL(direct!);
          via.hostname = '127.0.0.1';
          via.port = String(poolPort);
          process.env.DATABASE_URL = via.toString();
          pooled = await boot(true);
          process.env.DATABASE_URL = direct;
          expect(await Client.refused(pooled.port)).toBe(503);
          await settle(500);
          expect(await Client.refused(pooled.port)).toBe(503);
          expect(
            error.mock.calls.some(
              (e) =>
                String(e[0]).includes('did not receive its own probe') &&
                String(e[0]).includes('direct connection'),
            ),
          ).toBe(true);
        } finally {
          process.env.DATABASE_URL = direct;
          error.mockRestore();
          if (pooled) await pooled.app.close();
          pooler.kill();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      60000,
    );
  });

  describe('limits', () => {
    it('closes a client that does not read once too much is waiting for it, with 4408', () => {
      const closes: Array<[number, string]> = [];
      const fake = {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: LIVE_LIMITS.maxBufferedBytes + 1,
        send: jest.fn(),
        close: (code: number, reason: string) => closes.push([code, reason]),
        terminate: jest.fn(),
      };
      const connections = new LiveConnections();
      connections.add({
        ws: fake as never,
        wawuId: 'slow',
        expiresAtMs: Date.now() + 60000,
        alive: true,
        expiryTimer: undefined,
      });
      connections.send('slow', { type: 'chat.read' });
      expect(closes).toEqual([[4408, 'too_slow']]);
      expect(fake.send).not.toHaveBeenCalled();
      expect(connections.has('slow')).toBe(false);
    });

    it('holds each address to a few sockets that have not signed in yet', async () => {
      const unsigned: Client[] = [];
      for (let i = 0; i < LIVE_LIMITS.unsignedPerAddress; i += 1) {
        unsigned.push(await Client.open(port, null));
      }
      expect(await Client.refused(port)).toBe(429);
      // Behind nginx the address is the right-most X-Forwarded-For entry, so a
      // different client behind the same proxy is not held back.
      const other = await new Promise<number>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () =>
          s.write(
            'GET /api/hub/live HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Forwarded-For: 203.0.113.9\r\n\r\n',
          ),
        );
        s.once('data', (d) => {
          resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(d.toString())?.[1]));
          s.destroy();
        });
      });
      expect(other).toBe(101);
      // Signed-in sockets are not counted: they wait for nothing.
      for (const u of unsigned) u.ws.terminate();
      await settle(300);
      const fine = await open(port, ada.token);
      expect(fine.ready).toBeDefined();
    }, 30000);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, relative } from 'node:path';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import {
  THROTTLER_BLOCK_DURATION,
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { AdminAuthController } from '../admin/auth/admin-auth.controller';
import { AppController } from '../app.controller';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import {
  applyHubHttpSettings,
  HUB_APP_OPTIONS,
  hubTrustProxy,
  isLoopbackAddress,
} from '../hub-app-options';
import {
  HUB_THROTTLER_STORAGE,
  HUB_THROTTLER_SWEEP_CHUNK,
  HUB_THROTTLER_SWEEP_MS,
  HubThrottlerStorage,
} from '../hub-throttler-storage';
import { HUB_THROTTLERS, SKIP_EVERY_HUB_THROTTLER } from '../hub-throttlers';
import { MoneyIdentityController } from '../money/identity/money-identity.controller';
import { MoneyReceiptController } from '../money/receipts/money-receipt.controller';
import { PublicReceiptController } from '../money/receipts/public-receipt.controller';
import { MoneyRecipientController } from '../money/recipients/money-recipient.controller';
import {
  RECIPIENT_SEARCH_PERSON_LIMITS,
  RECIPIENT_SEARCH_THROTTLE,
} from '../money/recipients/recipient-config';
import { MoneyStatementController } from '../money/statements/money-statement.controller';
import {
  STATEMENT_CONCURRENCY,
  STATEMENT_RATE_LIMITS,
  STATEMENT_WAIT_MS,
  StatementSlots,
} from '../money/statements/statement-config';
import { WaitlistPublicController } from '../waitlist/waitlist-public.controller';

/**
 * OPS-11: behind nginx, every caller gets its own rate-limit bucket, and no
 * caller can choose someone else's.
 *
 * Production (deploy/install-services.sh): nginx on the droplet proxies to
 * `http://127.0.0.1:3001` and sets `X-Forwarded-For $proxy_add_x_forwarded_for`,
 * which is whatever the client sent, then ", <the address nginx saw>". So
 * "through nginx" here is a loopback connection whose X-Forwarded-For ends
 * with the client's address, and "direct" is a connection from this
 * machine's non-loopback address, as anyone reaching the app port without
 * nginx would arrive.
 *
 * The app is built as src/main.ts builds it (HUB_APP_OPTIONS,
 * applyHubHttpSettings, global prefix, filter, interceptor) with AppModule's
 * throttlers (HUB_THROTTLERS) behind the real global ThrottlerGuard, and
 * listens like main.ts, on every interface. The route is the real
 * `GET /api/hub/health`, which is throttled like every other route.
 * Addresses are from the documentation ranges, one set per test, so no test
 * reads another's bucket.
 */

const SHORT = HUB_THROTTLERS.find((t) => t.name === 'short')!;
const MEDIUM = HUB_THROTTLERS.find((t) => t.name === 'medium')!;
const PATH = '/api/hub/health';

type Hit = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
};

/** This machine's first non-loopback IPv4 address: a "direct" caller. */
function externalAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address;
    }
  }
  throw new Error(
    'This test needs a non-loopback IPv4 interface to stand for a caller that bypasses nginx; none was found.',
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Rate limits behind nginx (OPS-11)', () => {
  let app: INestApplication;
  let port: number;
  let direct: string;

  /** One GET, from `from` to `to`, with the X-Forwarded-For given. */
  function get(to: string, from: string, xff?: string): Promise<Hit> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: to,
          port,
          path: PATH,
          method: 'GET',
          localAddress: from,
          agent: false,
          headers: xff === undefined ? {} : { 'X-Forwarded-For': xff },
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * A request as nginx forwards it: the client's own X-Forwarded-For (if it
   * sent one), then the address nginx saw, over loopback.
   */
  const viaNginx = (client: string, sent?: string) =>
    get('127.0.0.1', '127.0.0.1', sent ? `${sent}, ${client}` : client);

  /** A request straight to the app port, not through nginx. */
  const directly = (xff?: string) => get(direct, direct, xff);

  const statuses = (hits: Hit[]) => {
    const out: Record<number, number> = {};
    for (const h of hits) out[h.status] = (out[h.status] ?? 0) + 1;
    return out;
  };
  const remainingShort = (h: Hit) =>
    Number(h.headers['x-ratelimit-remaining-short']);

  beforeAll(async () => {
    direct = externalAddress();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([...HUB_THROTTLERS])],
      controllers: [AppController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
    applyHubHttpSettings(app);
    app.setGlobalPrefix('api/hub');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    // Every interface, as main.ts's `app.listen(port)`; port 0 so the OS
    // picks a free one and nothing here can collide.
    await app.listen(0);
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('two clients behind nginx', () => {
    it('get separate buckets: one client sending 25 in a second gets 5 times 429, the other in the same second gets 20 times 200', async () => {
      const a = '198.51.100.11';
      const b = '198.51.100.12';
      const [hitsA, hitsB] = await Promise.all([
        Promise.all(Array.from({ length: SHORT.limit + 5 }, () => viaNginx(a))),
        Promise.all(Array.from({ length: SHORT.limit }, () => viaNginx(b))),
      ]);
      expect(statuses(hitsA)).toEqual({ 200: SHORT.limit, 429: 5 });
      expect(statuses(hitsB)).toEqual({ 200: SHORT.limit });
      // ...and A is still refused while B is not.
      expect((await viaNginx(a)).status).toBe(429);
    });

    it("a client cannot take another client's bucket by writing its address into X-Forwarded-For: nginx appends the real one, and only that is read", async () => {
      const victim = '198.51.100.21';
      const forger = '198.51.100.22';
      // The victim is throttled...
      await Promise.all(
        Array.from({ length: SHORT.limit + 1 }, () => viaNginx(victim)),
      );
      expect((await viaNginx(victim)).status).toBe(429);
      // ...and the forger claiming to be the victim is counted as itself:
      // a first request, 19 left.
      const forged = await viaNginx(forger, victim);
      expect(forged.status).toBe(200);
      expect(remainingShort(forged)).toBe(SHORT.limit - 1);
    });

    it("a client cannot spend another client's bucket either: 25 forged requests throttle only the forger", async () => {
      const victim = '198.51.100.31';
      const forger = '198.51.100.32';
      const hits = await Promise.all(
        Array.from({ length: SHORT.limit + 5 }, () => viaNginx(forger, victim)),
      );
      expect(statuses(hits)).toEqual({ 200: SHORT.limit, 429: 5 });
      const first = await viaNginx(victim);
      expect(first.status).toBe(200);
      expect(remainingShort(first)).toBe(SHORT.limit - 1);
    });
  });

  describe('a direct connection (not through nginx)', () => {
    it("is not trusted: a forged X-Forwarded-For neither escapes a throttled bucket nor spends another client's", async () => {
      expect(isLoopbackAddress(direct)).toBe(false);
      const victim = '198.51.100.41';
      await Promise.all(
        Array.from({ length: SHORT.limit + 1 }, () => viaNginx(victim)),
      );
      expect((await viaNginx(victim)).status).toBe(429);

      // Claiming to be the throttled victim: counted as its own address.
      const one = await directly(victim);
      expect(one.status).toBe(200);
      expect(remainingShort(one)).toBe(SHORT.limit - 1);

      // Its own bucket empties after 20 a second whatever it writes in the
      // header, and a client it names keeps a full bucket.
      await sleep(SHORT.ttl + 100);
      const other = '198.51.100.42';
      const hits = await Promise.all(
        Array.from({ length: SHORT.limit + 5 }, (_, i) =>
          directly(i % 2 ? other : `198.51.100.${100 + i}`),
        ),
      );
      expect(statuses(hits)).toEqual({ 200: SHORT.limit, 429: 5 });
      const first = await viaNginx(other);
      expect(first.status).toBe(200);
      expect(remainingShort(first)).toBe(SHORT.limit - 1);
    }, 10000);

    it('the trust rule: exactly one hop, and only a loopback peer (nginx on the droplet)', () => {
      for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '127.0.1.1', '::1'])
        expect(hubTrustProxy(peer, 0)).toBe(true);
      for (const peer of [
        direct,
        '10.0.0.5',
        '::ffff:10.0.0.5',
        '203.0.113.9',
        '2001:db8::1',
      ])
        expect(hubTrustProxy(peer, 0)).toBe(false);
      // The address nginx wrote is the answer, never a further hop.
      for (const hop of ['127.0.0.1', '198.51.100.1'])
        expect(hubTrustProxy(hop, 1)).toBe(false);
    });
  });

  describe('every other route keeps 20 a second and 200 a minute', () => {
    it('the limits are unchanged: short 20 per 1 s, medium 200 per 60 s, registered once in AppModule behind the global guard', () => {
      expect(HUB_THROTTLERS).toEqual([
        { name: 'short', ttl: 1_000, limit: 20 },
        { name: 'medium', ttl: 60_000, limit: 200 },
      ]);
      const appModule = readFileSync(
        join(__dirname, '../app.module.ts'),
        'utf8',
      );
      expect(appModule).toMatch(
        /ThrottlerModule\.forRoot\(\[\.\.\.HUB_THROTTLERS\]\)/,
      );
      expect(appModule).toMatch(
        /\{\s*provide:\s*APP_GUARD,\s*useClass:\s*ThrottlerGuard\s*\}/,
      );
    });

    it('only the three payment webhooks (Flutterwave, Fintava, Nuvion: NUV-01) skip the limits; the only other overrides are admin login and refresh, the BVN check (KYC-01), the selfie match (KYC-02), the public receipt check and the receipt image and PDF (WALLET-18), the recipient search (WALLET-08), and the four public event registration routes (JOIN-01), once each', () => {
      const root = join(__dirname, '..');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (name.endsWith('.ts') && !name.endsWith('.spec.ts'))
            files.push(path);
        }
      };
      walk(root);
      // How many times each file uses the decorator, so a second override
      // added to a file already listed is caught too.
      const uses = (pattern: RegExp): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const f of [...files].sort()) {
          const n = readFileSync(f, 'utf8').match(pattern)?.length ?? 0;
          if (n !== 0) counts[relative(root, f)] = n;
        }
        return counts;
      };
      expect(uses(/^\s*@SkipThrottle\(/gm)).toEqual({
        'fintava/webhook/fintava-webhook.controller.ts': 1,
        'nuvion/webhook/nuvion-webhook.controller.ts': 1,
        'payment-webhook/payment-webhook.controller.ts': 1,
      });
      expect(uses(/^\s*@Throttle\(/gm)).toEqual({
        'admin/auth/admin-auth.controller.ts': 2,
        'money/identity/money-identity.controller.ts': 2,
        'money/receipts/money-receipt.controller.ts': 2,
        'money/receipts/public-receipt.controller.ts': 1,
        'money/recipients/money-recipient.controller.ts': 1,
        'waitlist/waitlist-public.controller.ts': 4,
      });
    });

    it('statements (WALLET-27) set no throttler of their own: the global per-address limits apply; the per-person limit (5 a minute, 30 an hour) and two at once are counted after the token is verified', () => {
      const proto = MoneyStatementController.prototype as unknown as Record<
        string,
        object
      >;
      for (const target of [MoneyStatementController, proto.statement]) {
        const keys = (Reflect.getOwnMetadataKeys(target) as unknown[]).filter(
          // Any of the throttler's keys: limit, ttl, tracker, block, skip.
          (k) => typeof k === 'string' && k.startsWith('THROTTLER:'),
        );
        expect(keys).toEqual([]);
      }
      // The provisional figures in statement-config.ts (STATEMENT-RATE-LIMITS,
      // STATEMENT-CONCURRENCY): these exact ones.
      expect(STATEMENT_RATE_LIMITS).toEqual([
        { name: 'minute', limit: 5, windowMs: 60_000 },
        { name: 'hour', limit: 30, windowMs: 3_600_000 },
      ]);
      expect([STATEMENT_CONCURRENCY, STATEMENT_WAIT_MS]).toEqual([2, 5_000]);
      const slots = new StatementSlots();
      expect([slots.max, slots.waitMs]).toEqual([2, 5_000]);
    });

    it('each of those overrides only tightens the limits: per throttler, no more requests in no shorter a window, and no shorter a block', () => {
      // What the decorators actually set, read the way the guard reads it:
      // the class and each handler's own metadata.
      const overrides: {
        on: string;
        name: string;
        limit?: number;
        ttl?: number;
        blockDuration?: number;
      }[] = [];
      for (const controller of [
        AdminAuthController,
        MoneyIdentityController,
        MoneyReceiptController,
        PublicReceiptController,
        MoneyRecipientController,
        WaitlistPublicController,
      ]) {
        const proto = controller.prototype as unknown as Record<
          string,
          unknown
        >;
        const targets: [string, object][] = [
          [controller.name, controller],
          ...Object.getOwnPropertyNames(proto)
            .filter((k) => k !== 'constructor')
            .map((k): [string, object] => [
              `${controller.name}.${k}`,
              proto[k] as object,
            ]),
        ];
        for (const [on, target] of targets) {
          for (const key of Reflect.getOwnMetadataKeys(target) as unknown[]) {
            if (typeof key !== 'string' || !key.startsWith(THROTTLER_LIMIT))
              continue;
            const name = key.slice(THROTTLER_LIMIT.length);
            const read = (prefix: string) =>
              Reflect.getOwnMetadata(prefix + name, target) as
                number | undefined;
            overrides.push({
              on,
              name,
              limit: read(THROTTLER_LIMIT),
              ttl: read(THROTTLER_TTL),
              blockDuration: read(THROTTLER_BLOCK_DURATION),
            });
          }
        }
      }
      expect([...new Set(overrides.map((o) => o.on))].sort()).toEqual([
        'AdminAuthController.login',
        'AdminAuthController.refresh',
        'MoneyIdentityController.checkBvn',
        'MoneyIdentityController.matchSelfie',
        'MoneyReceiptController.image',
        'MoneyReceiptController.pdf',
        'MoneyRecipientController.search',
        'PublicReceiptController.page',
        'WaitlistPublicController.currentOffer',
        'WaitlistPublicController.register',
        'WaitlistPublicController.status',
        'WaitlistPublicController.verify',
      ]);
      // WALLET-18: the public receipt check, and drawing a receipt as an
      // image or a PDF, each set exactly these per-address limits: 10 a
      // minute and 60 an hour, no block of their own.
      for (const on of [
        'MoneyReceiptController.image',
        'MoneyReceiptController.pdf',
        'PublicReceiptController.page',
      ]) {
        expect(
          overrides
            .filter((o) => o.on === on)
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          {
            on,
            name: 'medium',
            limit: 60,
            ttl: 3_600_000,
            blockDuration: undefined,
          },
          {
            on,
            name: 'short',
            limit: 10,
            ttl: 60_000,
            blockDuration: undefined,
          },
        ]);
      }
      // WALLET-08: the recipient search reaches every wallet holder, and sets
      // exactly these per-address limits: 20 a minute and 120 an hour, no
      // block of its own. The recent list (a different handler) sets none.
      // On top, one person is counted in the handler, after the token is
      // verified (RecipientSearchLimiter): 20 a minute, 120 an hour, 500 a day.
      expect(RECIPIENT_SEARCH_PERSON_LIMITS).toEqual([
        { name: 'minute', limit: 20, windowMs: 60_000 },
        { name: 'hour', limit: 120, windowMs: 3_600_000 },
        { name: 'day', limit: 500, windowMs: 86_400_000 },
      ]);
      expect(RECIPIENT_SEARCH_THROTTLE).toEqual({
        short: { limit: 20, ttl: 60_000 },
        medium: { limit: 120, ttl: 3_600_000 },
      });
      expect(
        overrides
          .filter((o) => o.on === 'MoneyRecipientController.search')
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        {
          on: 'MoneyRecipientController.search',
          name: 'medium',
          limit: 120,
          ttl: 3_600_000,
          blockDuration: undefined,
        },
        {
          on: 'MoneyRecipientController.search',
          name: 'short',
          limit: 20,
          ttl: 60_000,
          blockDuration: undefined,
        },
      ]);
      // JOIN-01 (round 2, lead ruling of 10 Oct 2026: many Nigerian phones sit
      // behind one mobile-network address and a venue shares one Wi-Fi
      // address): the four public event registration routes each set their own
      // `medium` override and the guard counts each route apart. The two reads
      // (the offer, a registration's status) allow 600 calls per address in 10
      // minutes, the two writes (register, verify) 300. Only `medium` is
      // changed; `short` keeps its 20 a second.
      const waitlist = (on: string, limit: number) => ({
        on: `WaitlistPublicController.${on}`,
        name: 'medium',
        limit,
        ttl: 600_000,
        blockDuration: undefined,
      });
      expect(
        overrides
          .filter((o) => o.on.startsWith('WaitlistPublicController.'))
          .sort((a, b) => a.on.localeCompare(b.on)),
      ).toEqual([
        waitlist('currentOffer', 600),
        waitlist('register', 300),
        waitlist('status', 600),
        waitlist('verify', 300),
      ]);
      // KYC-02: the selfie match is charged per attempt, like the BVN check,
      // and sets exactly these per-address limits: 3 a minute and 20 an hour,
      // no block of its own.
      expect(
        overrides
          .filter((o) => o.on === 'MoneyIdentityController.matchSelfie')
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        {
          on: 'MoneyIdentityController.matchSelfie',
          name: 'medium',
          limit: 20,
          ttl: 3_600_000,
          blockDuration: undefined,
        },
        {
          on: 'MoneyIdentityController.matchSelfie',
          name: 'short',
          limit: 3,
          ttl: 60_000,
          blockDuration: undefined,
        },
      ]);
      // The four event registration routes are the one deliberate exception to
      // "no more requests": 600 and 300 are above `medium`'s 200, in a window
      // 10 times as long. They must still be no faster over their own window
      // than `medium` is over its (600 in 600 s is 1 a second against 3.3 a
      // second), and `short` is not touched.
      const LONGER_WINDOW = new Set(
        overrides
          .filter((o) => o.on.startsWith('WaitlistPublicController.'))
          .map((o) => o.on),
      );
      for (const o of overrides) {
        const base = HUB_THROTTLERS.find((t) => t.name === o.name);
        // A name the app does not register would be silently ignored.
        expect({ on: o.on, name: o.name, registered: !!base }).toEqual({
          on: o.on,
          name: o.name,
          registered: true,
        });
        const limit = o.limit ?? base!.limit;
        const ttl = o.ttl ?? base!.ttl;
        const slowerOverItsWindow =
          o.name === 'medium' &&
          LONGER_WINDOW.has(o.on) &&
          ttl > base!.ttl &&
          limit / ttl <= base!.limit / base!.ttl;
        expect({
          on: o.on,
          name: o.name,
          tightens:
            slowerOverItsWindow ||
            (limit <= base!.limit &&
              ttl >= base!.ttl &&
              (o.blockDuration === undefined || o.blockDuration >= ttl)),
        }).toEqual({ on: o.on, name: o.name, tightens: true });
      }
    });

    it('through nginx, one client gets 20 a second (the 21st is 429, with the limit headers) and 200 a minute (the 201st is 429 from `medium`)', async () => {
      const client = '198.51.100.51';
      const first = await viaNginx(client);
      expect(first.status).toBe(200);
      expect(first.headers['x-ratelimit-limit-short']).toBe(
        String(SHORT.limit),
      );
      expect(first.headers['x-ratelimit-limit-medium']).toBe(
        String(MEDIUM.limit),
      );

      let sent = 1;
      const perSecond = SHORT.limit;
      // Fill the minute 20 at a time, one window apart.
      while (sent < MEDIUM.limit) {
        const n = Math.min(
          perSecond - (sent === 1 ? 1 : 0),
          MEDIUM.limit - sent,
        );
        const hits = await Promise.all(
          Array.from({ length: n }, () => viaNginx(client)),
        );
        expect(statuses(hits)).toEqual({ 200: n });
        sent += n;
        if (sent === perSecond) {
          // The 21st in the first second is refused by `short`.
          const extra = await viaNginx(client);
          expect(extra.status).toBe(429);
          expect(extra.headers['retry-after-short']).toBeDefined();
        }
        await sleep(SHORT.ttl + 100);
      }
      expect(sent).toBe(MEDIUM.limit);
      const over = await viaNginx(client);
      expect(over.status).toBe(429);
      expect(over.headers['retry-after-medium']).toBeDefined();
      expect(over.headers['retry-after-short']).toBeUndefined();
    }, 40000);
  });

  it('src/main.ts applies the same settings to the live app', () => {
    const main = readFileSync(join(__dirname, '../main.ts'), 'utf8');
    expect(main).toMatch(
      /NestFactory\.create\(\s*AppModule,\s*HUB_APP_OPTIONS\s*\)/,
    );
    expect(main).toMatch(/applyHubHttpSettings\(app\)/);
  });
});

/**
 * FIX-05 (G-95): @nestjs/throttler 6.5's default in-memory store kept every
 * caller's hit timers in one list per throttler name, and when ANY caller's
 * block ended it cleared that whole list: everyone else's hits stopped
 * expiring and callers who never reached the limit got 429. AppModule now
 * gives the global guard src/hub-throttler-storage.ts instead, one bucket per
 * caller. The app below is built as the one above, plus that provider, as
 * AppModule registers it.
 */
@Controller('fix05')
class Fix05Controller {
  // Test-only routes, to show a route's own limits and a skip still work
  // through the new store. Not app routes: the scan above reads no spec file.
  @Get('tight')
  @Throttle({ short: { limit: 3, ttl: 60_000 } })
  tight() {
    return { ok: true };
  }

  @Get('skipped')
  @SkipThrottle(SKIP_EVERY_HUB_THROTTLER)
  skipped() {
    return { ok: true };
  }
}

describe('One address never changes another address’s throttling (FIX-05)', () => {
  let app: INestApplication;
  let port: number;
  let ours: HubThrottlerStorage;
  let library: ThrottlerStorageService;

  /** A request as nginx forwards it from `client`. */
  function from(client: string, path = PATH): Promise<Hit> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          localAddress: '127.0.0.1',
          agent: false,
          headers: { 'X-Forwarded-For': client },
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  const burst = (client: string, n: number, path = PATH) =>
    Promise.all(Array.from({ length: n }, () => from(client, path)));
  const tally = (hits: Hit[]) => {
    const out: Record<number, number> = {};
    for (const h of hits) out[h.status] = (out[h.status] ?? 0) + 1;
    return out;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([...HUB_THROTTLERS])],
      controllers: [AppController, Fix05Controller],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        HUB_THROTTLER_STORAGE,
      ],
    }).compile();
    const stores = moduleRef.get<unknown>(ThrottlerStorage, { each: true });
    ours = stores.find((s) => s instanceof HubThrottlerStorage)!;
    library = stores.find((s) => s instanceof ThrottlerStorageService)!;
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
    applyHubHttpSettings(app);
    app.setGlobalPrefix('api/hub');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AppModule gives its global guard the per-caller store, and the guard counts there, never in the library’s', async () => {
    const appModule = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(appModule).toMatch(
      /import \{ HUB_THROTTLER_STORAGE \} from '\.\/hub-throttler-storage';/,
    );
    expect(appModule).toMatch(
      /providers:\s*\[\s*\{\s*provide:\s*APP_GUARD,\s*useClass:\s*ThrottlerGuard\s*\},(?:\s*\/\/[^\n]*)*\s*HUB_THROTTLER_STORAGE,\s*\]/,
    );
    expect(ours).toBeInstanceOf(HubThrottlerStorage);
    const before = ours.size;
    expect((await from('198.51.100.61')).status).toBe(200);
    // One bucket for each of `short` and `medium`.
    expect(ours.size).toBe(before + 2);
    expect(library.storage.size).toBe(0);
  });

  it('G-95: when one address’s block ends, another address’s hits still expire (15, then 6 more after its window, is 21 times 200)', async () => {
    const attacker = '198.51.100.71';
    const victim = '198.51.100.72';
    const t0 = Date.now();
    const at = (ms: number) => sleep(Math.max(0, t0 + ms - Date.now()));
    // The attacker goes over and is blocked for one `short` window.
    expect(tally(await burst(attacker, SHORT.limit + 1))).toEqual({
      200: SHORT.limit,
      429: 1,
    });
    // Half a window later the victim sends 15, under the limit.
    await at(500);
    const victimStart = Date.now();
    expect(tally(await burst(victim, 15))).toEqual({ 200: 15 });
    // The attacker's block has ended; its next request starts a fresh count.
    // On the library's store this is what froze the victim's 15.
    await at(1_250);
    expect(Date.now()).toBeLessThan(victimStart + SHORT.ttl);
    const again = await from(attacker);
    expect(again.status).toBe(200);
    expect(remaining(again)).toBe(SHORT.limit - 1);
    // A window after the victim's 15, all of them have expired: 6 more are
    // 6 more of 20, not the 21st.
    await sleep(Math.max(0, victimStart + SHORT.ttl + 400 - Date.now()));
    const later = await burst(victim, 6);
    expect(tally(later)).toEqual({ 200: 6 });
    expect(Math.min(...later.map(remaining))).toBe(SHORT.limit - 6);
  }, 10000);

  it('the reproduction: a caller at 2 a second gets no 429 while another address sends 25 every 1.5 s', async () => {
    const victim = '198.51.100.81';
    const flooder = '198.51.100.82';
    const victimHits: Hit[] = [];
    const bursts: Record<number, number>[] = [];
    let done = false;
    const victimLoop = (async () => {
      while (!done) {
        victimHits.push(await from(victim));
        await sleep(500);
      }
    })();
    for (let i = 0; i < 5; i++) {
      bursts.push(tally(await burst(flooder, SHORT.limit + 5)));
      await sleep(1_500);
    }
    done = true;
    await victimLoop;
    expect(victimHits.length).toBeGreaterThanOrEqual(10);
    expect(tally(victimHits)).toEqual({ 200: victimHits.length });
    // ...and the flooder is refused at today's limit in every burst.
    for (const b of bursts) expect(b).toEqual({ 200: SHORT.limit, 429: 5 });
  }, 20000);

  it('the flooding address is refused exactly as before: 20 a second, the 21st is 429 with Retry-After, refused while blocked, then a fresh count', async () => {
    const client = '198.51.100.91';
    const hits = await burst(client, SHORT.limit + 5);
    expect(tally(hits)).toEqual({ 200: SHORT.limit, 429: 5 });
    const refused = hits.filter((h) => h.status === 429);
    for (const h of refused) {
      expect(h.headers['retry-after-short']).toBe('1');
      expect(h.headers['retry-after-medium']).toBeUndefined();
    }
    const ok = hits.filter((h) => h.status === 200);
    expect(ok.map(remaining).sort((a, b) => a - b)).toEqual(
      Array.from({ length: SHORT.limit }, (_, i) => i),
    );
    for (const h of ok) {
      expect(h.headers['x-ratelimit-limit-short']).toBe(String(SHORT.limit));
      expect(h.headers['x-ratelimit-limit-medium']).toBe(String(MEDIUM.limit));
      expect(h.headers['x-ratelimit-reset-short']).toBe('1');
    }
    expect((await from(client)).status).toBe(429);
    await sleep(SHORT.ttl + 100);
    const fresh = await from(client);
    expect(fresh.status).toBe(200);
    expect(remaining(fresh)).toBe(SHORT.limit - 1);
  });

  it('a route’s own @Throttle still applies per address (3 a minute), and @SkipThrottle still skips, through the new store', async () => {
    const a = '198.51.100.101';
    const b = '198.51.100.102';
    expect(tally(await burst(a, 5, '/api/hub/fix05/tight'))).toEqual({
      200: 3,
      429: 2,
    });
    const refused = await from(a, '/api/hub/fix05/tight');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after-short']).toBe('60');
    // Another address on the same tight route is untouched.
    const other = await from(b, '/api/hub/fix05/tight');
    expect(other.status).toBe(200);
    expect(remaining(other)).toBe(2);
    // A skipped route answers every request and keeps no count at all.
    const before = ours.size;
    expect(
      tally(await burst(a, SHORT.limit + 10, '/api/hub/fix05/skipped')),
    ).toEqual({
      200: SHORT.limit + 10,
    });
    expect(ours.size).toBe(before);
  });
});

function remaining(h: Hit): number {
  return Number(h.headers['x-ratelimit-remaining-short']);
}

describe('HubThrottlerStorage (FIX-05)', () => {
  type Rec = Awaited<ReturnType<HubThrottlerStorage['increment']>>;
  /** Deterministic pseudo-random numbers, so a failure replays. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** What the guard reads; how long a block has left only matters while blocked. */
  const seen = (r: Rec) => ({
    totalHits: r.totalHits,
    timeToExpire: r.timeToExpire,
    isBlocked: r.isBlocked,
    timeToBlockExpire: r.isBlocked ? r.timeToBlockExpire : null,
  });
  const LIMITS = [
    { ttl: SHORT.ttl, limit: SHORT.limit, blockDuration: SHORT.ttl },
    { ttl: MEDIUM.ttl, limit: MEDIUM.limit, blockDuration: MEDIUM.ttl },
    // The BVN check and selfie match's own `short` and `medium`.
    { ttl: 60_000, limit: 3, blockDuration: 60_000 },
    { ttl: 3_600_000, limit: 20, blockDuration: 3_600_000 },
    // A block longer than the window.
    { ttl: 1_000, limit: 5, blockDuration: 5_000 },
  ];

  afterEach(() => {
    jest.useRealTimers();
  });

  it('for one caller, every answer is the library store’s, hit for hit, on every limit the app uses', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    for (const [n, { ttl, limit, blockDuration }] of LIMITS.entries()) {
      const ours = new HubThrottlerStorage();
      const library = new ThrottlerStorageService();
      const next = random(n + 1);
      // Bursts, small gaps, gaps of about a window, and exact boundaries.
      const gaps = [
        0,
        0,
        0,
        1,
        () => Math.floor(next() * (ttl / 20)),
        () => Math.floor(next() * ttl),
        ttl,
        ttl - 1,
        blockDuration,
        () => Math.floor(next() * 2 * blockDuration),
      ];
      for (let step = 0; step < 3_000; step++) {
        const g = gaps[Math.floor(next() * gaps.length)];
        jest.advanceTimersByTime(typeof g === 'function' ? g() : g);
        const mine = await ours.increment(
          'k',
          ttl,
          limit,
          blockDuration,
          'short',
        );
        const theirs = await library.increment(
          'k',
          ttl,
          limit,
          blockDuration,
          'short',
        );
        if (JSON.stringify(seen(mine)) !== JSON.stringify(seen(theirs)))
          expect({ limits: n, step, mine: seen(mine) }).toEqual({
            limits: n,
            step,
            mine: seen(theirs),
          });
      }
      ours.onApplicationShutdown();
      library.onApplicationShutdown();
    }
  });

  it('with many callers interleaved, each caller’s answers are what the library gives that caller ALONE', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const { ttl, limit, blockDuration } = LIMITS[0];
    const ours = new HubThrottlerStorage();
    // One library store per caller: alone, it has no one else to disturb.
    const alone = Array.from(
      { length: 6 },
      () => new ThrottlerStorageService(),
    );
    const next = random(42);
    let blocks = 0;
    for (let step = 0; step < 6_000; step++) {
      jest.advanceTimersByTime(next() < 0.7 ? 0 : Math.floor(next() * 400));
      // Caller 0 floods; the others send a little.
      const who = next() < 0.5 ? 0 : 1 + Math.floor(next() * 5);
      for (const name of ['short', 'medium']) {
        // As the guard makes them: one key per caller AND throttler name.
        const key = `caller-${who}-${name}`;
        const mine = await ours.increment(key, ttl, limit, blockDuration, name);
        const theirs = await alone[who].increment(
          key,
          ttl,
          limit,
          blockDuration,
          name,
        );
        if (mine.isBlocked && name === 'short') blocks++;
        if (JSON.stringify(seen(mine)) !== JSON.stringify(seen(theirs)))
          expect({ step, who, name, mine: seen(mine) }).toEqual({
            step,
            who,
            name,
            mine: seen(theirs),
          });
      }
    }
    // The flooder really was blocked, again and again.
    expect(blocks).toBeGreaterThan(50);
    ours.onApplicationShutdown();
    for (const s of alone) s.onApplicationShutdown();
  });

  it('G-95 at the store: a caller under the limit is never blocked by another caller’s block ending', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const { ttl, limit, blockDuration } = LIMITS[0];
    const ours = new HubThrottlerStorage();
    let victimBlocked = 0;
    let attackerBlocked = 0;
    // 30 s: the victim sends 2 every 100 ms (20 a second, exactly the
    // limit, never over), the attacker 25 at once every 1.5 s.
    for (let t = 0; t < 30_000; t += 100) {
      for (let i = 0; i < 2; i++) {
        if (
          (await ours.increment('victim', ttl, limit, blockDuration, 'short'))
            .isBlocked
        )
          victimBlocked++;
      }
      if (t % 1_500 === 0) {
        for (let i = 0; i < 25; i++) {
          if (
            (
              await ours.increment(
                'attacker',
                ttl,
                limit,
                blockDuration,
                'short',
              )
            ).isBlocked
          )
            attackerBlocked++;
        }
      }
      jest.advanceTimersByTime(100);
    }
    expect(victimBlocked).toBe(0);
    expect(attackerBlocked).toBe(20 * 5);
    ours.onApplicationShutdown();
  });

  it('100,000 callers start no timer per hit, and the periodic sweep removes every one of them after their window', async () => {
    jest.useFakeTimers({
      now: 1_700_000_000_000,
      doNotFake: ['setImmediate'],
    });
    const ours = new HubThrottlerStorage();
    expect(jest.getTimerCount()).toBe(0);
    for (let i = 0; i < 100_000; i++) {
      for (const { name, ttl, limit } of HUB_THROTTLERS)
        await ours.increment(`caller-${i}`, ttl, limit, ttl, name);
    }
    // The sweeper, and nothing else.
    expect(jest.getTimerCount()).toBe(1);
    expect(ours.size).toBe(200_000);
    // 10 s on, the interval's sweep (which yields between chunks) has
    // removed every `short` bucket (a 1 s window) and kept every `medium`
    // one (60 s). Enough turns of the loop for a whole sweep to finish.
    const turns = async (n: number) => {
      for (let i = 0; i < n; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    jest.advanceTimersByTime(HUB_THROTTLER_SWEEP_MS);
    await turns((2 * 200_000) / HUB_THROTTLER_SWEEP_CHUNK);
    expect(ours.size).toBe(100_000);
    // ...and once the longest window (medium, 60 s) has passed, the sweep
    // started by the interval removes the rest.
    for (let t = 0; t < MEDIUM.ttl; t += HUB_THROTTLER_SWEEP_MS) {
      jest.advanceTimersByTime(HUB_THROTTLER_SWEEP_MS);
      await turns((2 * 100_000) / HUB_THROTTLER_SWEEP_CHUNK);
    }
    expect(ours.size).toBe(0);
    expect(jest.getTimerCount()).toBe(1);
    ours.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
  }, 60000);

  it('a sweep yields the event loop between chunks instead of holding it', async () => {
    const ours = new HubThrottlerStorage();
    const n = HUB_THROTTLER_SWEEP_CHUNK * 4;
    for (let i = 0; i < n; i++)
      await ours.increment(`c${i}`, 1, 20, 1, 'short');
    await sleep(5);
    let finished = false;
    let yielded = 0;
    const sweeping = ours.sweep().then((removed) => {
      finished = true;
      return removed;
    });
    // Each of these runs only if the sweep has handed the loop back.
    const tick = (): void => {
      if (finished) return;
      yielded++;
      setImmediate(tick);
    };
    setImmediate(tick);
    expect(await sweeping).toBe(n);
    expect(yielded).toBeGreaterThanOrEqual(3);
    expect(ours.size).toBe(0);
    ours.onApplicationShutdown();
  });

  it('an idle caller’s bucket is dropped when it is next touched, and answers as a new one would', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const ours = new HubThrottlerStorage();
    for (let i = 0; i < SHORT.limit + 3; i++)
      await ours.increment('k', SHORT.ttl, SHORT.limit, SHORT.ttl, 'short');
    expect(ours.size).toBe(1);
    jest.advanceTimersByTime(SHORT.ttl);
    expect(
      seen(
        await ours.increment('k', SHORT.ttl, SHORT.limit, SHORT.ttl, 'short'),
      ),
    ).toEqual({
      totalHits: 1,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: null,
    });
    expect(ours.size).toBe(1);
    ours.onApplicationShutdown();
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, relative } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { HUB_THROTTLERS } from '../hub-throttlers';
import { MoneyIdentityController } from '../money/identity/money-identity.controller';
import { MoneyReceiptController } from '../money/receipts/money-receipt.controller';
import { PublicReceiptController } from '../money/receipts/public-receipt.controller';

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

    it('only the two payment webhooks skip the limits; the only other overrides are admin login and refresh, the BVN check (KYC-01), the selfie match (KYC-02), the public receipt check and the receipt image and PDF (WALLET-18), once each', () => {
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
        'payment-webhook/payment-webhook.controller.ts': 1,
      });
      expect(uses(/^\s*@Throttle\(/gm)).toEqual({
        'admin/auth/admin-auth.controller.ts': 2,
        'money/identity/money-identity.controller.ts': 2,
        'money/receipts/money-receipt.controller.ts': 2,
        'money/receipts/public-receipt.controller.ts': 1,
      });
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
        'PublicReceiptController.page',
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
        expect({
          on: o.on,
          name: o.name,
          tightens:
            limit <= base!.limit &&
            ttl >= base!.ttl &&
            (o.blockDuration === undefined || o.blockDuration >= ttl),
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

// Contract tests for STORE-CUT30 (R-101 point 9): the Hub keeps each store's calendar-year total of WAWU's store
// proceeds in US dollars; at the threshold that store's `wawu.buy.*` prices switch to the 30% ladder, once, and the
// owner is told once. Real database and real HTTP for GET /prices and the admin routes; the FX source (Nuvion's
// quote through the wallet-provider seam) and the two stores' publishing APIs are stand-ins on local sockets. No
// Nuvion, Google, Apple or Fintava host is called. Run with
//   WAWU_ID_JWKS_URL=http://localhost:10730/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:10730
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public';

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminTokenService } from '../../../admin/auth/admin-token.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { PriceListModule } from '../../../price-list/price-list.module';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import {
  API,
  BUYER,
  dataOf,
  ensureMockWawuId,
  mintToken,
} from '../../../../test/store/store-test-kit';
import { StorePayoutModule } from '../../payout/store-payout.module';
import { STORE_LADDER } from '../../store-ladder';
import { StoreCut30Module } from '../store-cut30.module';
import { StoreCut30Service, CUT30_THRESHOLD_KEY } from '../store-cut30.service';
import { STORE_LADDER_30 } from '../store-ladder-30';
import {
  loadStorePriceConfig,
  STORE_PRICE_CONFIG,
  type StorePriceConfig,
} from '../store-price-sync';
import { lagosYear, proceedsKoboOf, usdCentsOf } from '../store-proceeds';
import { StoreUsdRateService } from '../store-usd-rate.service';

jest.setTimeout(120_000);

/** 1,500 naira to the dollar: 1,500 kobo buy one US cent. */
const KOBO_PER_CENT = 1500n;

describe('STORE-CUT30: the ladders and the pure rules', () => {
  it('the 30% ladder lines up with the 15% ladder: same list prices, every price higher', () => {
    expect(STORE_LADDER_30.map((s) => s.listNaira)).toEqual(
      STORE_LADDER.map((s) => s.listNaira),
    );
    STORE_LADDER_30.forEach((s, i) => {
      expect(s.storeNaira).toBeGreaterThan(STORE_LADDER[i].storeNaira);
      // The store keeps 30% of what the buyer pays, so what is left covers the list price.
      expect(s.storeNaira * 0.7).toBeGreaterThanOrEqual(s.listNaira * 0.95);
    });
    expect(STORE_LADDER_30[0]).toEqual({ listNaira: 100, storeNaira: 160 });
    expect(STORE_LADDER_30[24]).toEqual({
      listNaira: 1_000_000,
      storeNaira: 1_549_000,
    });
  });

  it('counts what the store pays WAWU: the reference first, else a naira price less the cut, else nothing', () => {
    const none = { currency: null, priceMicros: null, storeFeeBps: 1500 };
    expect(proceedsKoboOf({ ...none, netKobo: 100_000 })).toBe(100_000n);
    expect(
      proceedsKoboOf({
        netKobo: null,
        currency: 'NGN',
        priceMicros: 1_300_000_000n,
        storeFeeBps: 1500,
      }),
    ).toBe(110_500n);
    expect(
      proceedsKoboOf({
        netKobo: null,
        currency: 'USD',
        priceMicros: 5_000_000n,
        storeFeeBps: 1500,
      }),
    ).toBeNull();
    expect(
      usdCentsOf(100_000n, { rateKobo: 1500n, rateCents: 1n, source: 'x' }),
    ).toBe(66n);
    expect(lagosYear(new Date('2026-12-31T23:30:00.000Z'))).toBe(2027);
    expect(lagosYear(new Date('2026-12-31T22:30:00.000Z'))).toBe(2026);
  });
});

describe('STORE-CUT30: the switch (stand-in FX and stores)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let cut: StoreCut30Service;
  let settings: PlanSettingsService;
  let mock: ChildProcess | undefined;
  let userToken: string;
  let adminToken: string;
  const adminId = randomUUID();
  const previous: Record<string, string | undefined> = {};
  const startedAt = new Date();
  const purchases: string[] = [];
  const fxAccounts: string[] = [];
  const madeProducts: string[] = [];
  const quotes: string[] = [];
  const year = lagosYear(new Date());

  // The FX source: Nuvion's merchant quote, through the seam.
  const nuvion = new NuvionSeamStandIn();
  const fxCalls: unknown[] = [];
  let fxFails = false;
  const provider = Object.assign(Object.create(nuvion) as NuvionSeamStandIn, {
    fx: {
      currencies: ['USD'],
      quoteFromMerchant: (input: {
        to: { currency: string; accountId: string | null };
        amountToMinor: bigint;
      }) => {
        fxCalls.push(input);
        if (fxFails) return Promise.reject(new Error('Nuvion is down'));
        return Promise.resolve({
          id: 'quote-1',
          amountFromMinor: input.amountToMinor * KOBO_PER_CENT,
          amountToMinor: input.amountToMinor,
          rate: '15',
          expiresAt: new Date(Date.now() + 30_000),
          feeMinor: null,
        });
      },
    },
  }) as unknown as WalletProvider;

  // The stores' publishing APIs.
  type Hit = { method: string; url: string; auth: string; body: string };
  const hits: Hit[] = [];
  let storeServer: Server;
  let storeBase = '';
  let appleFailsFor: string | null = null;
  const priceConfig: StorePriceConfig = { google: null, apple: null };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => resolve(b));
    });

  const http = () => request(app.getHttpServer() as Server);

  async function purchase(
    platform: 'android' | 'ios',
    listNaira: number,
    over: { status?: 'granted' | 'refunded'; environment?: string } = {},
  ) {
    const product = await prisma.storeProduct.findFirstOrThrow({
      where: { platform, storeProductId: `wawu.buy.${listNaira}` },
    });
    const id = randomUUID();
    purchases.push(id);
    await prisma.storePurchase.create({
      data: {
        id,
        wawuUserId: null,
        platform,
        storeTransactionId: `t-${id}`,
        productId: product.id,
        storeProductId: product.storeProductId,
        kind: 'buy',
        status: over.status ?? 'granted',
        environment: over.environment ?? 'production',
        grant: {},
        referenceKobo: listNaira * 100,
        storeFeeBps: 1500,
        netKobo: listNaira * 100,
        currency: 'NGN',
        priceMicros: BigInt(product.storePriceKobo ?? 0) * 10_000n,
        purchasedAt: new Date(),
      },
    });
    return id;
  }

  const priceOf = async (platform: 'android' | 'ios', listNaira: number) =>
    (
      await prisma.storeProduct.findFirstOrThrow({
        where: { platform, storeProductId: `wawu.buy.${listNaira}` },
      })
    ).storePriceKobo;

  async function setThreshold(usd: number) {
    await prisma.planSetting.upsert({
      where: { key: CUT30_THRESHOLD_KEY },
      create: { key: CUT30_THRESHOLD_KEY, value: usd },
      update: { value: usd },
    });
    await settings.refresh();
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      FINTAVA_BASE_URL: 'http://127.0.0.1:9',
      FINTAVA_API_KEY: 'live_test_cut30_0123456789FAKEKEY',
      ADMIN_JWT_SECRET: 'cut30-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'cut30-admin-refresh-secret-0123456789abcd',
    })) {
      previous[k] = process.env[k];
      process.env[k] = process.env[k] ?? v;
    }
    mock = await ensureMockWawuId();
    storeServer = createServer((req, res) => {
      void readBody(req).then((body) => {
        const url = req.url ?? '';
        hits.push({
          method: req.method ?? '',
          url,
          auth: String(req.headers.authorization ?? ''),
          body,
        });
        const json = (status: number, o: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(o));
        };
        if (url === '/oauth/token')
          return json(200, { access_token: 'g-token', expires_in: 3000 });
        if (url.startsWith('/androidpublisher/')) return json(200, {});
        const sku = /filter\[productId\]=([^&]+)/.exec(url)?.[1];
        if (sku) return json(200, { data: [{ id: `iap-${sku}` }] });
        const iap = /inAppPurchases\/iap-([^/]+)\/pricePoints/.exec(url)?.[1];
        if (iap) {
          const list = Number(iap.replace('wawu.buy.', ''));
          const step = STORE_LADDER_30.find((s) => s.listNaira === list);
          return json(200, {
            data: [
              { id: 'pp-decoy', attributes: { customerPrice: '1.0' } },
              {
                id: `pp-${list}`,
                attributes: { customerPrice: `${step?.storeNaira}.0` },
              },
            ],
          });
        }
        if (url === '/v1/inAppPurchasePriceSchedules') {
          if (appleFailsFor && body.includes(`"id":"${appleFailsFor}"}`))
            return json(409, {});
          return json(201, {});
        }
        return json(404, {});
      });
    });
    await new Promise<void>((r) =>
      storeServer.listen(0, '127.0.0.1', () => r()),
    );
    storeBase = `http://127.0.0.1:${(storeServer.address() as AddressInfo).port}`;

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PriceListModule,
        StorePayoutModule,
        StoreCut30Module,
      ],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
      .overrideProvider(STORE_PRICE_CONFIG)
      .useValue(priceConfig)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
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
    prisma = moduleRef.get(PrismaService);
    cut = moduleRef.get(StoreCut30Service);
    settings = moduleRef.get(PlanSettingsService);
    userToken = mintToken(BUYER);
    adminToken = moduleRef.get(AdminTokenService).issuePair(
      await prisma.adminUser.create({
        data: {
          id: adminId,
          email: `cut30-${adminId}@admin.test.wawu.dev`,
          passwordHash: 'x',
          name: 'Cut30 finance',
          role: AdminRole.finance,
        },
      }),
    ).accessToken;

    // The ladder's store products (the migration makes them; another spec may have cleared them): make any
    // that are missing, and take them away again afterwards.
    for (const platform of ['android', 'ios'] as const) {
      for (const [i, step] of STORE_LADDER.entries()) {
        const found = await prisma.storeProduct.findFirst({
          where: { platform, storeProductId: `wawu.buy.${step.listNaira}` },
          select: { id: true },
        });
        if (found === null) {
          const made = await prisma.storeProduct.create({
            data: {
              platform,
              storeProductId: `wawu.buy.${step.listNaira}`,
              kind: 'buy',
              title: `Buy at ${step.listNaira} naira`,
              grants: { packId: null, pack: null, tierId: null, days: null },
              referenceKobo: step.listNaira * 100,
              storePriceKobo: step.storeNaira * 100,
              sortOrder: i + 1,
            },
          });
          madeProducts.push(made.id);
        }
      }
    }
    // WAWU holds a US dollar account at the provider (the quote's destination side is checked for its shape).
    const acct = await prisma.fxAccount.create({
      data: {
        wawuUserId: randomUUID(),
        provider: 'nuvion',
        currency: 'USD',
        chain: '',
        providerCustomerId: 'C0000000000000000000000000',
        providerAccountId: 'A0000000000000000000000000',
        status: 'open',
      },
    });
    fxAccounts.push(acct.id);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.storeProceedsEntry.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      await prisma.storeCut30Switch.deleteMany({ where: { year } });
      // The switch put each store's recorded cut at 3000; put it back to none.
      await prisma.storePlatformSetting.updateMany({
        where: { storeFeeBps: 3000 },
        data: { storeFeeBps: null },
      });
      await prisma.storePurchase.deleteMany({
        where: { id: { in: purchases } },
      });
      await prisma.storeAdminNotice.deleteMany({
        where: { kind: 'store_cut30' },
      });
      await prisma.fxQuote.deleteMany({ where: { id: { in: quotes } } });
      await prisma.fxAccount.deleteMany({ where: { id: { in: fxAccounts } } });
      await prisma.planSetting.deleteMany({
        where: { key: CUT30_THRESHOLD_KEY },
      });
      await prisma.adminUser.deleteMany({ where: { id: adminId } });
      // Leave the ladder rows as the migration made them, and remove the ones this spec made.
      for (const platform of ['android', 'ios'] as const)
        for (const s of STORE_LADDER)
          await prisma.storeProduct.updateMany({
            where: {
              platform,
              kind: 'buy',
              storeProductId: `wawu.buy.${s.listNaira}`,
            },
            data: { storePriceKobo: s.storeNaira * 100 },
          });
      await prisma.storeProduct.deleteMany({
        where: { id: { in: madeProducts } },
      });
    }
    if (app) await app.close();
    if (storeServer)
      await new Promise<void>((r) => storeServer.close(() => r()));
    mock?.kill();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the threshold setting is a whole number of dollars', async () => {
    expect(settings.number(CUT30_THRESHOLD_KEY)).toBe(900_000);
    await prisma.planSetting.upsert({
      where: { key: CUT30_THRESHOLD_KEY },
      create: { key: CUT30_THRESHOLD_KEY, value: 0 },
      update: { value: 0 },
    });
    await settings.refresh();
    // A bad stored value is ignored: the default stands.
    expect(settings.number(CUT30_THRESHOLD_KEY)).toBe(900_000);
  });

  it('counts at the Nuvion quote; a store crosses once; its prices switch and GET /prices shows them; the owner is told once', async () => {
    // Count whatever other specs left behind first, so the crossing below is this spec's own.
    await cut.sweep();
    const base = await cut.totalCents('android', year);
    const baseIos = await cut.totalCents('ios', year);
    const threshold = Number(base / 100n) + 2; // two dollars above where android stands
    await setThreshold(threshold);
    const need = BigInt(threshold) * 100n - base; // 101 to 200 cents: 2 or 3 sales of 100,000 kobo (66 cents)
    const sales = Number((need + 65n) / 66n);
    expect(sales).toBeGreaterThanOrEqual(2);

    // One iOS sale and a sandbox sale never move android; a refunded sale does not count.
    await purchase('ios', 1000);
    await purchase('android', 1000, { environment: 'sandbox' });
    const refunded = await purchase('android', 1000, { status: 'refunded' });

    for (let i = 0; i < sales - 1; i += 1) await purchase('android', 1000);
    const first = await cut.sweep();
    expect(first.counted).toBeGreaterThanOrEqual(sales - 1);
    expect(first.switched).toEqual([]);
    expect(await priceOf('android', 1000)).toBe(130_000);
    expect(fxCalls.length).toBeGreaterThan(0);
    const entry = await prisma.storeProceedsEntry.findFirstOrThrow({
      where: { createdAt: { gte: startedAt }, platform: 'android' },
    });
    expect(entry).toMatchObject({
      rateSource: 'nuvion_merchant_quote',
      usdCents: 66n,
      proceedsKobo: 100_000n,
    });
    expect(await cut.totalCents('ios', year)).toBe(baseIos + 66n);

    // The last sale crosses it.
    await purchase('android', 1000);
    const second = await cut.sweep();
    expect(second.switched).toEqual(['android']);
    expect(await priceOf('android', 1000)).toBe(155_000);
    expect(await priceOf('android', 100)).toBe(16_000);
    expect(await priceOf('android', 1_000_000)).toBe(154_900_000);
    expect(await priceOf('ios', 1000)).toBe(130_000);

    // GET /prices: the Android store's prices, the iPhone's, and without a platform the higher of the two.
    const pricesOf = async (qs: string) =>
      dataOf<{
        prices: Array<{ priceNaira: number; storePriceNaira: number | null }>;
      }>(
        await http()
          .get(`${API}/prices${qs}`)
          .set('Authorization', `Bearer ${userToken}`)
          .expect(200),
      ).prices.find((p) => p.priceNaira === 1000)?.storePriceNaira;
    expect(await pricesOf('?platform=android')).toBe(1550);
    expect(await pricesOf('?platform=ios')).toBe(1300);
    expect(await pricesOf('')).toBe(1550);

    // The owner is told once; with no keys the notice says to change the stores by hand.
    const notices = await prisma.storeAdminNotice.findMany({
      where: { kind: 'store_cut30' },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].noticeKey).toBe(`store_cut30:android:${year}`);
    expect(notices[0].body).toContain('no keys');
    expect(notices[0].body).toContain('by hand');
    expect(notices[0].body).not.toContain('—');
    expect(hits).toHaveLength(0);
    // V-SP-7: with no keys all 25 products are listed for the owner to change by hand.
    expect((notices[0].data as { byHand: string[] }).byHand).toHaveLength(25);

    // Crossing again and again changes nothing: not the prices, not the notice.
    await purchase('android', 1000);
    expect((await cut.sweep()).switched).toEqual([]);
    await cut.sweep();
    expect(
      await prisma.storeAdminNotice.count({ where: { kind: 'store_cut30' } }),
    ).toBe(1);
    expect(
      await prisma.storeCut30Switch.count({ where: { year } }),
    ).toBeGreaterThanOrEqual(1);

    // A refund takes a sale out of the total.
    const total = await cut.totalCents('android', year);
    await prisma.storePurchase.update({
      where: { id: purchases[purchases.length - 1] },
      data: { status: 'refunded' },
    });
    expect(await cut.totalCents('android', year)).toBe(total - 66n);
    expect(refunded).toBeTruthy();

    // The admin sees where each store stands.
    const status = dataOf<Array<{ platform: string; ladder: number }>>(
      await http()
        .get(`${API}/admin/store/cut30`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200),
    );
    expect(status.find((s) => s.platform === 'android')?.ladder).toBe(30);
    expect(status.find((s) => s.platform === 'ios')?.ladder).toBe(15);
    // The owner's notices are listed, and one can be marked read.
    const list = dataOf<{
      items: Array<{ id: string; kind: string; readAt: string | null }>;
      unread: number;
    }>(
      await http()
        .get(`${API}/admin/store/notices?unread=true`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200),
    );
    const mine = list.items.find((n) => n.kind === 'store_cut30')!;
    expect(mine.readAt).toBeNull();
    const read = dataOf<{ readAt: string | null }>(
      await http()
        .patch(`${API}/admin/store/notices/${mine.id}/read`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200),
    );
    expect(read.readAt).not.toBeNull();
    await http().get(`${API}/admin/store/notices`).expect(401);
  });

  it('the switch back to 15% is an admin action, not automatic, and only when the store is on 30%', async () => {
    await http()
      .post(`${API}/admin/store/cut30/ios/switch-back`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    await http()
      .post(`${API}/admin/store/cut30/android/switch-back`)
      .expect(401);
    const back = dataOf<{
      ladder: number;
      storeSync: string;
      byHand: string[];
    }>(
      await http()
        .post(`${API}/admin/store/cut30/android/switch-back`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200),
    );
    expect(back).toMatchObject({ ladder: 15, storeSync: 'no_keys' });
    expect(back.byHand).toHaveLength(25);
    expect(await priceOf('android', 1000)).toBe(130_000);
    // Not switched again by the sweep (the year's switch is spent), and a second ask is refused.
    await cut.sweep();
    expect(await priceOf('android', 1000)).toBe(130_000);
    await http()
      .post(`${API}/admin/store/cut30/android/switch-back`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
  });

  it('with the keys, the prices are changed in Google Play and App Store Connect, and what failed is named', async () => {
    // Google: a service account whose token the stand-in gives.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    priceConfig.google = {
      packageName: 'africa.wawu.test',
      serviceAccount: {
        client_email: 'prices@wawu.test',
        private_key: rsa.privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        token_uri: `${storeBase}/oauth/token`,
      },
      apiBase: storeBase,
    };
    priceConfig.apple = {
      appId: '1234567890',
      issuerId: 'issuer-1',
      keyId: 'KEY1',
      privateKey: ec.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      apiBase: storeBase,
    };
    await prisma.storeCut30Switch.deleteMany({ where: { year } });
    await prisma.storeAdminNotice.deleteMany({
      where: { kind: 'store_cut30' },
    });
    // Both stores are over now.
    await purchase('ios', 1000);
    await purchase('ios', 1000);
    await setThreshold(1);
    hits.length = 0;
    appleFailsFor = 'pp-5000';
    const run = await cut.sweep();
    expect(run.switched.sort()).toEqual(['android', 'ios']);

    // Google: one PATCH per product, the Nigeria price in micros, signed in with the service account.
    const g = hits.filter((h) => h.method === 'PATCH');
    expect(g).toHaveLength(25);
    const p1000 = g.find((h) =>
      h.url.includes('/inappproducts/wawu.buy.1000'),
    )!;
    expect(p1000.auth).toBe('Bearer g-token');
    expect(JSON.parse(p1000.body)).toMatchObject({
      sku: 'wawu.buy.1000',
      prices: { NG: { currency: 'NGN', priceMicros: '1550000000' } },
    });
    // Apple: the product is found, its Nigeria price point matched on the price, the base price set.
    const sched = hits.filter(
      (h) => h.url === '/v1/inAppPurchasePriceSchedules',
    );
    expect(sched).toHaveLength(25);
    expect(sched[0].auth).toMatch(/^Bearer ey/);
    const s1000 = sched.find((h) => h.body.includes('"id":"pp-1000"}'))!;
    const sent = JSON.parse(s1000.body) as {
      data: { relationships: { baseTerritory: { data: { id: string } } } };
    };
    expect(sent.data.relationships.baseTerritory.data.id).toBe('NGA');

    const switches = await prisma.storeCut30Switch.findMany({
      where: { year },
    });
    expect(switches.find((s) => s.platform === 'android')?.storeSync).toBe(
      'done',
    );
    expect(switches.find((s) => s.platform === 'ios')?.storeSync).toBe(
      'partial',
    );
    const notice = (platform: string) =>
      prisma.storeAdminNotice.findUniqueOrThrow({
        where: { noticeKey: `store_cut30:${platform}:${year}` },
      });
    expect((await notice('android')).body).toContain(
      'changed all 25 prices in Google Play',
    );
    const ios = await notice('ios');
    expect(ios.body).toContain(
      'could not change 1 of the 25 prices in the App Store',
    );
    expect(ios.body).toContain('wawu.buy.5000');
    expect((ios.data as { byHand: string[] }).byHand).toEqual([
      'wawu.buy.5000',
    ]);
    // Once: another sweep calls no store and writes no notice.
    hits.length = 0;
    await cut.sweep();
    expect(hits).toHaveLength(0);
    expect(
      await prisma.storeAdminNotice.count({ where: { kind: 'store_cut30' } }),
    ).toBe(2);
    priceConfig.google = null;
    priceConfig.apple = null;
  });

  it('the keys come from named environment variables, and a store with part of them has none', () => {
    expect(loadStorePriceConfig({}).google).toBeNull();
    expect(
      loadStorePriceConfig({
        STORE_PRICE_APPLE_APP_ID: '12',
        STORE_PRICE_APPLE_ISSUER_ID: 'i',
      }).apple,
    ).toBeNull();
    const full = loadStorePriceConfig({
      STORE_PRICE_APPLE_APP_ID: '12',
      STORE_PRICE_APPLE_ISSUER_ID: 'i',
      STORE_PRICE_APPLE_KEY_ID: 'k',
      STORE_PRICE_APPLE_PRIVATE_KEY: 'a\\nb',
    });
    expect(full.apple).toMatchObject({ appId: '12', privateKey: 'a\nb' });
  });

  it('the rate falls back to the newest Nuvion quote the Hub stored when the live quote is not available', async () => {
    fxFails = true;
    const q = await prisma.fxQuote.create({
      data: {
        wawuUserId: randomUUID(),
        provider: 'nuvion',
        providerQuoteId: 'stored-1',
        fromCurrency: 'USD',
        toCurrency: 'NGN',
        amountFromMinor: 10_000n,
        amountToMinor: 15_000_000n,
        rate: '1500',
        expiresAt: new Date(),
      },
    });
    quotes.push(q.id);
    const rates = new StoreUsdRateService(prisma, provider);
    const rate = await rates.current();
    expect(rate).toMatchObject({
      rateKobo: 15_000_000n,
      rateCents: 10_000n,
      source: 'nuvion_stored_quote',
    });
    // No live quote and no stored quote: no rate, and nothing is counted.
    await prisma.fxQuote.deleteMany({ where: { id: { in: quotes } } });
    expect(
      await new StoreUsdRateService(prisma, provider).current(),
    ).toBeNull();
    fxFails = false;
  });
});

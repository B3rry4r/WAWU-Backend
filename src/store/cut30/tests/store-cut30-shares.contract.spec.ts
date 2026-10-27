// STORE-CUT30 patch (V-SP-3, R-101 point 9): when a store moves to 30%, WAWU's own recorded net is true (70%) and
// every creator and host share stays exactly what it was (WAWU absorbs the extra cut). Real HTTP and database;
// the stores are stand-ins and the FX source is Nuvion's quote stood in. Run with
//   WAWU_ID_JWKS_URL=http://localhost:10731/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:10731
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { NuvionSeamStandIn } from '../../../../test/payments/nuvion-seam-standin';
import {
  APP_STORE_CLIENT,
  GOOGLE_PLAY_CLIENT,
} from '../../clients/store-clients';
import {
  API,
  BUYER,
  dataOf,
  ensureMockWawuId,
  mintToken,
  STAND_IN_CONFIG,
} from '../../../../test/store/store-test-kit';
import {
  StandInGooglePlay,
  verified,
} from '../../../../test/store/store-standins';
import { StorePayoutModule } from '../../payout/store-payout.module';
import { STORE_CONFIG } from '../../store-config';
import { StoreCatalogService } from '../../store-catalog.service';
import { StoreModule } from '../../store.module';
import { StoreCut30Module } from '../store-cut30.module';
import { CUT30_THRESHOLD_KEY, StoreCut30Service } from '../store-cut30.service';
import { STORE_PRICE_CONFIG } from '../store-price-sync';
import { lagosYear } from '../store-proceeds';

jest.setTimeout(120_000);

describe('STORE-CUT30 patch: a store at 30% leaves every creator and host share as it was', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let cut: StoreCut30Service;
  let catalog: StoreCatalogService;
  let settings: PlanSettingsService;
  let mock: ChildProcess | undefined;
  let accountToken: string;
  let userToken: string;
  const google = new StandInGooglePlay();
  const startedAt = new Date();
  const fxAccounts: string[] = [];
  const productIds: string[] = [];
  const sku = `wawu_credits_shares_${randomUUID().slice(0, 6)}`;
  const nuvion = new NuvionSeamStandIn();
  const provider = Object.assign(Object.create(nuvion) as NuvionSeamStandIn, {
    fx: {
      currencies: ['USD'],
      quoteFromMerchant: (i: { amountToMinor: bigint }) =>
        Promise.resolve({
          id: 'q',
          amountFromMinor: i.amountToMinor * 1500n,
          amountToMinor: i.amountToMinor,
          rate: '15',
          expiresAt: new Date(Date.now() + 30_000),
          feeMinor: null,
        }),
    },
  }) as unknown as WalletProvider;
  const year = lagosYear(new Date());

  const http = () => request(app.getHttpServer() as Server);

  async function buyCredits(token: string) {
    google.oneTime.set(
      token,
      verified({
        platform: 'android',
        storeProductId: sku,
        storeTransactionId: `GPA.${token}`,
        accountToken,
        needsAcknowledge: true,
      }),
    );
    const res = await http()
      .post(`${API}/store/purchases`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ platform: 'android', productId: sku, purchaseToken: token })
      .expect(201);
    const id = dataOf<{ id: string }>(res).id;
    const row = await prisma.storePurchase.findUniqueOrThrow({
      where: { id },
    });
    const lot = await prisma.creditLot.findFirstOrThrow({
      where: { creditPurchase: { storePurchaseId: id } },
    });
    return { row, lot };
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      FINTAVA_BASE_URL: 'http://127.0.0.1:9',
      FINTAVA_API_KEY: 'live_test_shares_0123456789FAKEKEY',
    }))
      process.env[k] = process.env[k] ?? v;
    mock = await ensureMockWawuId();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        StoreModule,
        StorePayoutModule,
        StoreCut30Module,
      ],
    })
      .overrideProvider(STORE_CONFIG)
      .useValue(STAND_IN_CONFIG)
      .overrideProvider(GOOGLE_PLAY_CLIENT)
      .useValue(google)
      .overrideProvider(APP_STORE_CLIENT)
      .useValue(null)
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
      .overrideProvider(STORE_PRICE_CONFIG)
      .useValue({ google: null, apple: null })
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
    await prisma.storePlatformSetting.updateMany({
      where: { platform: 'android' },
      data: { storeFeeBps: null },
    });
    cut = moduleRef.get(StoreCut30Service);
    catalog = moduleRef.get(StoreCatalogService);
    settings = moduleRef.get(PlanSettingsService);
    userToken = mintToken(BUYER);
    accountToken = dataOf<{ accountToken: string }>(
      await http()
        .get(`${API}/store/products?platform=android`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200),
    ).accountToken;
    const made = await prisma.storeProduct.create({
      data: {
        platform: 'android',
        storeProductId: sku,
        kind: 'credits',
        title: 'Credits shares test',
        grants: { pack: 'popular' },
        referenceKobo: 100_000,
      },
    });
    productIds.push(made.id);
    fxAccounts.push(
      (
        await prisma.fxAccount.create({
          data: {
            wawuUserId: randomUUID(),
            provider: 'nuvion',
            currency: 'USD',
            chain: '',
            providerCustomerId: 'C0000000000000000000000000',
            providerAccountId: 'A0000000000000000000000000',
            status: 'open',
          },
        })
      ).id,
    );
    await prisma.planSetting.upsert({
      where: { key: CUT30_THRESHOLD_KEY },
      create: { key: CUT30_THRESHOLD_KEY, value: 1 },
      update: { value: 1 },
    });
    await settings.refresh();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.storeProceedsEntry.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      await prisma.storeCut30Switch.deleteMany({ where: { year } });
      await prisma.creditPurchase.deleteMany({ where: { userWawuId: BUYER } });
      await prisma.creditsState.deleteMany({ where: { userWawuId: BUYER } });
      await prisma.storePurchase.deleteMany({ where: { wawuUserId: BUYER } });
      await prisma.storePurchase.deleteMany({
        where: { productId: { in: productIds } },
      });
      await prisma.storeProduct.deleteMany({
        where: { id: { in: productIds } },
      });
      await prisma.storePlatformSetting.deleteMany({
        where: { platform: 'android' },
      });
      await prisma.storeAdminNotice.deleteMany({
        where: { kind: 'store_cut30' },
      });
      await prisma.fxAccount.deleteMany({ where: { id: { in: fxAccounts } } });
      await prisma.planSetting.deleteMany({
        where: { key: CUT30_THRESHOLD_KEY },
      });
    }
    if (app) await app.close();
    mock?.kill();
  });

  it('a credit pack bought before and after the switch: the host share is unchanged and WAWU nets 70%', async () => {
    // Before: the store keeps 15%.
    const a = await buyCredits('tok-a');
    expect(a.row).toMatchObject({
      storeFeeBps: 1500,
      netKobo: 85_000,
      shareFeeBps: null,
    });
    expect(a.lot.grossKobo).toBe(85_000);
    // Whatever other sales are in the books, the threshold is set so that the next sale crosses it.
    await cut.sweep();
    const base = await cut.totalCents('android', year);
    const dollars = Number(base / 100n) + 2;
    await prisma.planSetting.upsert({
      where: { key: CUT30_THRESHOLD_KEY },
      create: { key: CUT30_THRESHOLD_KEY, value: dollars },
      update: { value: dollars },
    });
    await settings.refresh();
    const room = BigInt(dollars) * 100n - 1n - base; // cents that leave it one cent short
    await prisma.storePurchase.create({
      data: {
        wawuUserId: null,
        platform: 'android',
        storeTransactionId: `filler-${randomUUID()}`,
        productId: productIds[0],
        storeProductId: sku,
        kind: 'credits',
        environment: 'production',
        grant: {},
        referenceKobo: Number(room) * 1500,
        storeFeeBps: 0,
        netKobo: Number(room) * 1500,
        purchasedAt: new Date(),
      },
    });
    expect((await cut.sweep()).switched).toEqual([]);
    const b = await buyCredits('tok-b');
    expect(b.lot.grossKobo).toBe(85_000);

    // The second sale takes the total over one dollar: the store moves to 30%.
    expect((await cut.sweep()).switched).toEqual(['android']);
    expect((await catalog.availability('android')).feeBps).toBe(3000);
    const c = await buyCredits('tok-c');
    // WAWU's own record is true: the store kept 30%, 70,000 is what is left.
    expect(c.row).toMatchObject({
      storeFeeBps: 3000,
      netKobo: 70_000,
      shareFeeBps: 1500,
    });
    // The host's share of spent credits is worked on the lot's gross: unchanged.
    expect(c.lot.grossKobo).toBe(a.lot.grossKobo);
    const hostShare = (gross: number) => Math.floor((gross * 85) / 100);
    expect(hostShare(c.lot.grossKobo)).toBe(hostShare(a.lot.grossKobo));

    // The switch back puts the store's cut back, and a new sale is worked on it plainly.
    await cut.switchBack('android', 'admin-1');
    expect((await catalog.availability('android')).feeBps).toBe(1500);
    const d = await buyCredits('tok-d');
    expect(d.row).toMatchObject({
      storeFeeBps: 1500,
      netKobo: 85_000,
      shareFeeBps: null,
    });
    expect(d.lot.grossKobo).toBe(85_000);
  });
});

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { MoneyModule } from '../../money/money.module';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { NuvionSeamStandIn } from '../../../test/payments/nuvion-seam-standin';
import { mintToken, QuietLogger } from '../../../test/payments/poll-helpers';
import { PIN } from '../../../test/plans/tier-purchase-harness';
import { WalletBillsModule } from '../wallet-bills.module';

/**
 * BILLS-04 round 2: bills ride on Fintava only (R-45). Under
 * WALLET_PROVIDER=nuvion every bill create answers 409 target_not_payable
 * before anything asks Fintava for a list (no Fintava key is set here, so a
 * list asked first would answer 503 bills_unavailable instead).
 */
describe('BILLS-04 round 2: bills under Nuvion', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const nuvion = new NuvionSeamStandIn();
  const prev: Record<string, string | undefined> = {};
  let uid = '';
  let auth = '';
  beforeAll(async () => {
    const env: Record<string, string> = {
      FEE_QUOTE_KEY: 'bills04r2-test-fee-quote-key-0123456789abcdef',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: '0',
      NUVION_FEE_BANK_PAYOUT: '0',
      NUVION_FEE_INFLOW: '0',
      WALLET_PROVIDER: 'nuvion',
      BILLS_CATALOGUE_CACHE_SECONDS: '0',
    };
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    const logger = new QuietLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        WalletBillsModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(nuvion)
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      ...HUB_APP_OPTIONS,
      logger,
    });
    app.useLogger(logger);
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    uid = randomUUID();
    const acct = nuvion.openAccount(
      BigInt(5_000_000),
      `31${String(Date.now()).slice(-8)}`,
    );
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: uid,
        customerId: acct.entityId,
        walletId: acct.accountId,
        accountNumber: acct.accountNumber ?? '',
        provider: 'nuvion',
      },
    });
    const pinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    await prisma.transactionPin.create({ data: { wawuUserId: uid, pinHash } });
    auth = `Bearer ${mintToken(uid, 'bills04r2n')}`;
  });
  afterAll(async () => {
    await prisma.walletBill.deleteMany({ where: { wawuUserId: uid } });
    await prisma.transactionPin.deleteMany({ where: { wawuUserId: uid } });
    await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: uid } });
    await app.close();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each([
    [
      'electricity',
      {
        category: 'electricity',
        code: 'Ikeja_Electric_Bill_Payment',
        accountNumber: '04123456789',
        amountKobo: 1_000_000,
      },
    ],
    [
      'airtime',
      {
        category: 'airtime',
        code: 'MTN',
        accountNumber: '08031234567',
        amountKobo: 50_000,
      },
    ],
    [
      'data',
      {
        category: 'data',
        code: 'MTN',
        accountNumber: '08031234567',
        productCode: '30',
      },
    ],
    [
      'cable',
      {
        category: 'cable',
        code: 'DSTV',
        accountNumber: '7031234567',
        productCode: 'COMPACT',
      },
    ],
  ])(
    'a %s bill create answers 409 target_not_payable and nothing is made',
    async (_name, send) => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/bills/wallet')
        .set('Authorization', auth)
        .send(send);
      expect(res.status).toBe(409);
      expect((res.body as { reason?: { code?: string } }).reason?.code).toBe(
        'target_not_payable',
      );
      expect(
        await prisma.walletBill.count({ where: { wawuUserId: uid } }),
      ).toBe(0);
      expect(nuvion.transfers).toHaveLength(0);
    },
  );
});

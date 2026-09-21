import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { UserProfileModule } from '../../user-profile/user-profile.module';
import { WalletModule } from '../wallet.module';
import { WalletService } from '../wallet.service';

/**
 * THE WALLET, THROUGH THE REAL FRONT DOOR.
 *
 * Every request here carries a token this spec obtained by REGISTERING or
 * LOGGING IN at the identity service over HTTP, and every one is verified by
 * the real WawuAuthGuard against that service's real JWKS. Nothing about auth
 * is stubbed. The rows are real rows in Postgres, read back through Prisma
 * directly as well as through the API, so a response that agrees with itself
 * but not with the database cannot pass.
 *
 * WHAT IT DELIBERATELY ASSERTS: values that ONLY THE SERVER COULD HAVE
 * PRODUCED. The account reference on a wallet, the account NAME a withdrawal
 * resolved from the bank, and the balance after money moved are all decided
 * past the API boundary. A client that faked them would have to fake the
 * banking side too, which is exactly the point - passing this cannot be
 * explained by the test having supplied the answer.
 *
 * WHAT IS STILL A STAND-IN: the Flutterwave gateway. NODE_ENV=test selects
 * FlutterwaveWalletMock, so no test can move real money or need a network.
 * That is the ceiling on this file's evidence and it is stated rather than
 * glossed: proving the wallet against Flutterwave's own sandbox is a separate,
 * higher rung and this is not it.
 */

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

/** A brand-new identity at WAWU ID, as a real signup produces one. */
async function registerIdentity(tag: string): Promise<{ sub: string; token: string }> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Wallet ${tag}`,
      email: `wallet-${tag}-${stamp}@test.wawu.dev`,
      phone: `+23480${stamp.slice(-8)}`,
      country: 'Nigeria',
      password: 'whatever-the-mock-ignores',
    }),
  });
  if (!res.ok) {
    throw new Error(`register failed for ${tag}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };
  const claims = JSON.parse(
    Buffer.from(body.accessToken.split('.')[1], 'base64').toString('utf8'),
  ) as { sub: string };
  return { sub: claims.sub, token: body.accessToken };
}

describe('Wallet (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wallet: WalletService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  /** Every sub this spec brought into existence, cleaned up at the end. */
  const OWNED: string[] = [];

  async function newAccount(
    tag: string,
    accountType: 'creator' | 'user',
  ): Promise<{ sub: string; token: string }> {
    const identity = await registerIdentity(tag);
    OWNED.push(identity.sub);
    // The real onboarding call. This is what is meant to open the wallet.
    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${identity.token}`)
      .send({ accountType })
      .expect(200);
    return identity;
  }

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) throw new Error('mock-wawu-id did not become healthy in time');
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
        WalletModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    wallet = moduleRef.get(WalletService);
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      await prisma.walletWithdrawal.deleteMany({ where: { wawuUserId: { in: OWNED } } });
      await prisma.walletLedgerEntry.deleteMany({ where: { wawuUserId: { in: OWNED } } });
      await prisma.creatorWallet.deleteMany({ where: { wawuUserId: { in: OWNED } } });
      await prisma.creatorState.deleteMany({ where: { wawuUserId: { in: OWNED } } });
      await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: OWNED } } });
    }
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  describe('provisioning at registration', () => {
    it('opens a wallet the moment an account becomes a creator, with no further request', async () => {
      const { sub } = await newAccount('newcreator', 'creator');

      // Read straight from Postgres, NOT from the API: the claim is that
      // registration itself wrote this, not that some later read did.
      const row = await prisma.creatorWallet.findUnique({ where: { wawuUserId: sub } });
      expect(row).not.toBeNull();
      // An account reference the server got from the banking side. The client
      // never sent this and could not have guessed it.
      expect(row!.accountReference).toMatch(/^PSA[0-9A-F]{16}$/);
      expect(row!.nuban).toMatch(/^\d{10}$/);
      expect(row!.bankName).toBe('Flutterwave MFB');
    }, 30000);

    it('opens exactly one, however many times onboarding is saved', async () => {
      const { sub, token } = await newAccount('repeat', 'creator');
      const first = await prisma.creatorWallet.findUnique({ where: { wawuUserId: sub } });

      for (const bio of ['Take one.', 'Take two.']) {
        await request(app.getHttpServer())
          .patch('/users/me')
          .set('Authorization', `Bearer ${token}`)
          .send({ bio })
          .expect(200);
      }

      const count = await prisma.creatorWallet.count({ where: { wawuUserId: sub } });
      expect(count).toBe(1);
      const again = await prisma.creatorWallet.findUnique({ where: { wawuUserId: sub } });
      expect(again!.accountReference).toBe(first!.accountReference);
    }, 30000);

    it('opens none for a buyer account, and says what would change that', async () => {
      const { sub, token } = await newAccount('buyer', 'user');

      expect(await prisma.creatorWallet.findUnique({ where: { wawuUserId: sub } })).toBeNull();

      const res = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      // Not a bare refusal: the sentence has to carry the way in.
      expect(res.body.message).toMatch(/creator or professional account/i);
      expect(await prisma.creatorWallet.findUnique({ where: { wawuUserId: sub } })).toBeNull();
    }, 30000);
  });

  describe('GET /wallet', () => {
    it('reports the banking side as the balance, and our own ledger beside it', async () => {
      const { sub, token } = await newAccount('balance', 'creator');

      const empty = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(empty.body.data).toEqual(
        expect.objectContaining({
          availableNgn: 0,
          paidInNgn: 0,
          pendingInNgn: 0,
          withdrawnNgn: 0,
          withdrawalsEnabled: false,
        }),
      );
      // A wallet with nothing in it still hands over its account number: that
      // number is how money gets in from outside a sale.
      expect(empty.body.data.accountNumber).toMatch(/^\d{10}$/);

      // A real sale being swept into the wallet, through the same service the
      // funding cron calls.
      await wallet.creditEarning({
        wawuUserId: sub,
        amount: 42_500,
        reference: `contract-earning-${sub}`,
        sourceType: 'purchase',
        sourceId: 'contract-spec',
      });

      const inFlight = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // The money has reached the account, so the BALANCE is 42,500 - that
      // figure comes from the banking side, not from anything summed here.
      expect(inFlight.body.data.availableNgn).toBe(42_500);
      // Our own record of it is still unsettled until the webhook lands, and
      // it is reported as pending rather than quietly counted as paid.
      expect(inFlight.body.data.pendingInNgn).toBe(42_500);
      expect(inFlight.body.data.paidInNgn).toBe(0);

      await wallet.settleFromWebhook({
        reference: `contract-earning-${sub}`,
        succeeded: true,
      });

      const settled = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(settled.body.data.paidInNgn).toBe(42_500);
      expect(settled.body.data.pendingInNgn).toBe(0);
    }, 30000);

    it('lists what moved, newest first', async () => {
      const { sub, token } = await newAccount('history', 'creator');
      for (const [i, amount] of [1_000, 2_000].entries()) {
        await wallet.creditEarning({
          wawuUserId: sub,
          amount,
          reference: `contract-history-${sub}-${i}`,
          sourceType: 'purchase',
          sourceId: `contract-spec-${i}`,
        });
      }

      const res = await request(app.getHttpServer())
        .get('/wallet/history')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].amount).toBe(2_000);
      expect(res.body.data[0].kind).toBe('earning');
      expect(res.body.data[1].amount).toBe(1_000);
    }, 30000);

    it('refuses a caller with no token at all', async () => {
      await request(app.getHttpServer()).get('/wallet').expect(401);
    });
  });

  describe('withdrawing', () => {
    /** A creator with money in the wallet and the identity check settled. */
    async function fundedCreator(tag: string, amount: number, kyc: 'approved' | 'pending') {
      const account = await newAccount(tag, 'creator');
      await prisma.creatorState.upsert({
        where: { wawuUserId: account.sub },
        update: { kycStatus: kyc },
        create: { wawuUserId: account.sub, kycStatus: kyc },
      });
      await wallet.creditEarning({
        wawuUserId: account.sub,
        amount,
        reference: `contract-fund-${account.sub}`,
        sourceType: 'purchase',
        sourceId: `contract-${tag}`,
      });
      return account;
    }

    it('will not send money out until the identity check is approved', async () => {
      const { sub, token } = await fundedCreator('unverified', 50_000, 'pending');

      const gate = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // The money is visibly THERE. What is withheld is sending it onward,
      // and the reason is on the response rather than worked out by the app.
      expect(gate.body.data.availableNgn).toBe(50_000);
      expect(gate.body.data.withdrawalsEnabled).toBe(false);
      expect(gate.body.data.withdrawalsBlockedReason).toMatch(/identity check/i);

      const res = await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 5_000, bankCode: '044', accountNumber: '0123456789' })
        .expect(400);
      expect(res.body.message).toMatch(/identity check/i);

      // Nothing was recorded, so nothing can later be reconciled into a payment.
      const entries = await prisma.walletLedgerEntry.count({
        where: { wawuUserId: sub, kind: 'withdrawal' },
      });
      expect(entries).toBe(0);
    }, 30000);

    it('sends it, in the name the BANK gave back, and the balance falls', async () => {
      const { sub, token } = await fundedCreator('verified', 50_000, 'approved');

      const before = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(before.body.data.availableNgn).toBe(50_000);
      expect(before.body.data.withdrawalsEnabled).toBe(true);

      const res = await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 20_000, bankCode: '044', accountNumber: '0123456789' })
        .expect(201);

      // ADA OKEKE is not in the request body. It came back from the account
      // lookup on the banking side, which is the whole point of the confirm
      // step: the creator approves a PERSON, not ten digits they retyped.
      expect(res.body.data.accountName).toBe('ADA OKEKE');
      expect(res.body.data.amount).toBe(20_000);
      expect(res.body.data.status).toBe('pending');

      // The destination is stored with the movement, resolved name and all.
      const stored = await prisma.walletWithdrawal.findFirst({
        where: { wawuUserId: sub },
      });
      expect(stored).toMatchObject({
        amount: 20_000,
        bankCode: '044',
        accountNumber: '0123456789',
        accountName: 'ADA OKEKE',
      });
      const entry = await prisma.walletLedgerEntry.findUnique({
        where: { id: stored!.entryId },
      });
      expect(entry).toMatchObject({ kind: 'withdrawal', amount: 20_000, status: 'pending' });
      expect(entry!.transferId).toBeTruthy();

      // And the money is gone from the account, as the banking side reports it.
      const after = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.data.availableNgn).toBe(30_000);
      // Still only pending: a transfer is not settled until it settles.
      expect(after.body.data.withdrawnNgn).toBe(0);

      await wallet.settleFromWebhook({ reference: entry!.reference, succeeded: true });
      const settled = await request(app.getHttpServer())
        .get('/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(settled.body.data.withdrawnNgn).toBe(20_000);
    }, 45000);

    it('refuses more than the banking side says is there', async () => {
      const { token } = await fundedCreator('overdraw', 10_000, 'approved');
      const res = await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 50_000, bankCode: '044', accountNumber: '0123456789' })
        .expect(400);
      expect(res.body.message).toMatch(/10,000/);
    }, 30000);

    it('refuses an amount under the floor before it reaches the money at all', async () => {
      const { token } = await fundedCreator('tiny', 10_000, 'approved');
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100, bankCode: '044', accountNumber: '0123456789' })
        .expect(400);
    }, 30000);

    it('refuses an account number that is not ten digits', async () => {
      const { token } = await fundedCreator('shortacct', 10_000, 'approved');
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 5_000, bankCode: '044', accountNumber: '12345' })
        .expect(400);
    }, 30000);
  });

  describe('the destination', () => {
    it('lists banks to withdraw to', async () => {
      const { token } = await newAccount('banks', 'creator');
      const res = await request(app.getHttpServer())
        .get('/wallet/banks')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({ code: expect.any(String), name: expect.any(String) }),
      );
    }, 30000);

    it('names whose account a number is, before anybody is paid', async () => {
      const { token } = await newAccount('resolve', 'creator');
      const res = await request(app.getHttpServer())
        .post('/wallet/resolve-account')
        .set('Authorization', `Bearer ${token}`)
        .send({ bankCode: '044', accountNumber: '0123456789' })
        .expect(201);
      expect(res.body.data.accountName).toBe('ADA OKEKE');
    }, 30000);
  });
});

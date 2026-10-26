import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AdminRole } from '../../../generated/prisma/enums';
import {
  CapitalSeamStandIn,
  PRODUCT_FR,
  PRODUCT_FR_LOCKED_ONLY,
  PRODUCT_SO,
  PRODUCT_SO_CLOSED,
  PRODUCT_USD,
} from '../../../test/nuvion/capital-seam-standin';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import { NuvionSeamStandIn } from '../../../test/payments/nuvion-seam-standin';
import { AdminTokenService } from '../../admin/auth/admin-token.service';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { MoneyModule } from '../../money/money.module';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { CapitalModule } from '../capital.module';
import { CapitalSettings } from '../capital-config';
import { CapitalSweepService } from '../capital-sweep.service';

jest.setTimeout(120_000);

const BASE = '/api/hub/capital';
const ADMIN = '/api/hub/admin/capital/orders';
const PIN = '4826';

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

interface Env<T = unknown> {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: { code: string; [k: string]: unknown };
}

interface Order {
  id: string;
  status: string;
  productId: string;
  amountKobo: number;
  totalKobo: number;
  feeKobo: number;
  expiresAt: string | null;
  frozen: boolean;
  canWithdraw: boolean;
  withdrawBlockedBy: string | null;
  holding: { lifecycle: string | null; payoutKobo: number | null } | null;
  quote: { totalDebitKobo: number; penaltyRate: number | null } | null;
}

describe('NUV-12: Capital from the wallet', () => {
  const wawuId = new WawuIdDouble();
  const seam = new NuvionSeamStandIn();
  const cap = new CapitalSeamStandIn(seam);
  const provider: NuvionSeamStandIn & { capital?: CapitalSeamStandIn } =
    Object.assign(seam, { capital: cap });
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let sweep: CapitalSweepService;
  let plan: PlanSettingsService;
  let settings: CapitalSettings;
  let pinHash = '';
  const users: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const adminTokens: Partial<Record<AdminRole, string>> = {};
  let seq = 0;

  const ENV: Record<string, string> = {
    WALLET_PROVIDER: 'nuvion',
    NUVION_FEE_BOOK_TRANSFER: '0:0',
    NUVION_FEE_BANK_PAYOUT: '0:0',
    NUVION_FEE_INFLOW: '0:0',
    ADMIN_JWT_SECRET: 'nuv12-admin-access-secret-0123456789abcdef',
    ADMIN_JWT_REFRESH_SECRET: 'nuv12-admin-refresh-secret-0123456789abcd',
    MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
  };

  function token(sub: string): string {
    const privateKey = readFileSync(
      join(__dirname, '../../../mock-wawu-id/private.pem'),
      'utf8',
    );
    return jwt.sign(
      {
        sub,
        email: `n12-${sub}@test.wawu.dev`,
        phone: '+2348000001212',
        firstName: 'Cap',
        lastName: 'Ital',
        country: 'Nigeria',
        verificationTier: 'basic',
        trustScore: 0,
        status: 'active',
      },
      privateKey,
      { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
    );
  }

  interface Person {
    id: string;
    auth: string;
    accountId: string;
    accountNumber: string;
  }

  async function person(kobo = 100_000_000, pin = true): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    seq += 1;
    const accountNumber = `84${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
    const account = seam.openAccount(BigInt(kobo), accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: account.entityId,
        walletId: account.accountId,
        accountNumber,
        provider: 'nuvion',
      },
    });
    if (pin) {
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash },
      });
    }
    return {
      id,
      auth: `Bearer ${token(id)}`,
      accountId: account.accountId,
      accountNumber,
    };
  }

  const http = () => request(app.getHttpServer() as Server);
  const get = (p: Person, path: string) =>
    http().get(`${BASE}${path}`).set('Authorization', p.auth);
  const body = <T>(res: request.Response) => res.body as Env<T>;
  const balance = (p: Person) =>
    Number(seam.accounts.get(p.accountId)!.availableKobo);

  async function reserve(
    p: Person,
    over: Record<string, unknown> = {},
    key: string = randomUUID(),
  ) {
    return http()
      .post(`${BASE}/orders`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .send({
        productId: PRODUCT_FR,
        amountKobo: 1_000_000,
        agreedToDocuments: true,
        ...over,
      });
  }

  async function reserved(p: Person, over: Record<string, unknown> = {}) {
    const res = await reserve(p, over);
    expect(res.status).toBe(201);
    return body<Order>(res).data!;
  }

  function confirm(
    p: Person,
    id: string,
    o: { key?: string; pin?: string | null } = {},
  ) {
    const r = http()
      .post(`${BASE}/orders/${id}/confirm`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', o.key ?? randomUUID());
    return o.pin === null ? r : r.set('X-Transaction-Pin', o.pin ?? PIN);
  }

  function withdraw(
    p: Person,
    id: string,
    o: { key?: string; pin?: string | null } = {},
  ) {
    const r = http()
      .post(`${BASE}/orders/${id}/withdrawal`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', o.key ?? randomUUID());
    return o.pin === null ? r : r.set('X-Transaction-Pin', o.pin ?? PIN);
  }

  async function invested(p: Person, over: Record<string, unknown> = {}) {
    const o = await reserved(p, over);
    const res = await confirm(p, o.id);
    expect(res.status).toBe(201);
    return body<Order>(res).data!;
  }

  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
    });

  beforeAll(async () => {
    pinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    await wawuId.start();
    Object.assign(ENV, {
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
    });
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    seam.operational.availableKobo = 50_000_000n;
    seam.mode = 'successful';
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        CapitalModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
      .setLogger(new QuietLogger())
      .compile();
    app = moduleRef.createNestApplication(HUB_APP_OPTIONS);
    app.useLogger(new QuietLogger());
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
    sweep = moduleRef.get(CapitalSweepService);
    plan = moduleRef.get(PlanSettingsService);
    // CAPITAL-OFF (R-97): Capital is off by default, so every test below but the default test runs with an admin's
    // saved "on" (a row the way the admin screen writes it). The default test removes the row and puts it back.
    await prisma.planSetting.upsert({
      where: { key: 'capital.enabled' },
      create: { key: 'capital.enabled', value: 1 },
      update: { value: 1 },
    });
    await plan.refresh();
    settings = moduleRef.get(CapitalSettings);
    const issuer = moduleRef.get(AdminTokenService, { strict: false });
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `n12-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `NUV-12 ${role}`,
          role,
        },
      });
      adminTokens[role] = issuer.issuePair(admin).accessToken;
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.planSetting.deleteMany({
        where: { key: 'capital.enabled' },
      });
      const orders = await prisma.capitalOrder.findMany({
        where: { wawuUserId: { in: users } },
        select: { id: true },
      });
      const refs = orders.flatMap((o) => [
        `wawu-cap-${o.id}`,
        `wawu-cap-payout-${o.id}`,
        `wawu-capfee-${o.id}`,
      ]);
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { wawuUserId: { in: users } },
            { customerReference: { in: refs } },
          ],
        },
      });
      await prisma.capitalAdminAudit.deleteMany({
        where: { subjectWawuId: { in: users } },
      });
      await prisma.capitalOrder.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    await wawuId.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -----------------------------------------------------------------------
  // Browsing
  // -----------------------------------------------------------------------

  it('a person sees only the products they can buy in naira, with the terms Nuvion states', async () => {
    const p = await person();
    expect(
      body<{ available: boolean; holding: boolean }>(
        await get(p, '/availability').expect(200),
      ).data,
    ).toEqual({ available: true, holding: false });
    const list = body<{
      items: Array<{
        id: string;
        orderable: boolean;
        notOrderableReason: string | null;
        annualRate: number | null;
        documents: unknown[];
      }>;
    }>(await get(p, '/products').expect(200)).data!;
    const ids = list.items.map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        PRODUCT_FR,
        PRODUCT_FR_LOCKED_ONLY,
        PRODUCT_SO,
        PRODUCT_SO_CLOSED,
      ]),
    );
    expect(ids).not.toContain(PRODUCT_USD);
    const fr = list.items.find((i) => i.id === PRODUCT_FR)!;
    expect(fr.annualRate).toBe(0.3);
    expect(fr.orderable).toBe(true);
    expect(fr.documents).toEqual([]);
    const closed = list.items.find((i) => i.id === PRODUCT_SO_CLOSED)!;
    expect(closed.orderable).toBe(false);
    expect(closed.notOrderableReason).toBe('sale_closed');

    const detail = body<{
      documents: Array<{ name: string }>;
      terms: { wawuFeeFlatKobo: number };
    }>(await get(p, `/products/${PRODUCT_FR}`).expect(200)).data!;
    expect(detail.documents.map((d) => d.name)).toEqual([
      'Terms & Conditions.pdf',
    ]);
    expect(detail.terms.wawuFeeFlatKobo).toBe(0);
    const usd = await get(p, `/products/${PRODUCT_USD}`);
    expect(usd.status).toBe(404);
    expect(body(usd).reason?.code).toBe('target_not_found');
  });

  it('a person with no wallet is sent to open one', async () => {
    const id = randomUUID();
    users.push(id);
    const res = await http()
      .get(`${BASE}/products`)
      .set('Authorization', `Bearer ${token(id)}`);
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('wallet_not_open');
  });

  // -----------------------------------------------------------------------
  // Reserving
  // -----------------------------------------------------------------------

  it('reserving takes no money, and a double tap reserves once', async () => {
    const p = await person();
    const before = balance(p);
    const key = randomUUID();
    const a = body<Order>(await reserve(p, {}, key)).data!;
    const b = body<Order>(await reserve(p, {}, key)).data!;
    expect(a.status).toBe('reserved');
    expect(b.id).toBe(a.id);
    expect(a.quote!.totalDebitKobo).toBe(1_000_000);
    expect(a.expiresAt).not.toBeNull();
    expect(balance(p)).toBe(before);
    expect(cap.orders.size).toBeGreaterThan(0);
    const rows = await prisma.capitalOrder.count({
      where: { wawuUserId: p.id },
    });
    expect(rows).toBe(1);

    const other = await reserve(p, { amountKobo: 2_000_000 }, key);
    expect(other.status).toBe(409);
    expect(body(other).reason?.code).toBe('idempotency_key_reused');
  });

  it('a reservation is refused plainly: no key, documents not agreed, wrong amount, closed sale, short balance', async () => {
    const p = await person(500_000);
    const noKey = await http()
      .post(`${BASE}/orders`)
      .set('Authorization', p.auth)
      .send({
        productId: PRODUCT_FR,
        amountKobo: 100_000,
        agreedToDocuments: true,
      });
    expect(noKey.status).toBe(400);
    expect(body(noKey).reason?.code).toBe('idempotency_key_required');

    const notAgreed = await reserve(p, { agreedToDocuments: false });
    expect(notAgreed.status).toBe(409);
    expect(body(notAgreed).reason?.code).toBe('target_not_payable');

    const small = await reserve(p, { amountKobo: 5_000 });
    expect(small.status).toBe(400);
    expect(body(small).reason).toMatchObject({
      code: 'amount_out_of_range',
      minimumKobo: 100_000,
    });

    const closed = await reserve(p, {
      productId: PRODUCT_SO_CLOSED,
      amountKobo: 100_000,
    });
    expect(closed.status).toBe(409);
    expect(body(closed).reason?.code).toBe('target_not_payable');

    const dollars = await reserve(p, { productId: PRODUCT_USD });
    expect(dollars.status).toBe(404);

    const short = await reserve(p, { amountKobo: 1_000_000 });
    expect(short.status).toBe(402);
    expect(body(short).reason).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: 500_000,
      shortfallKobo: 500_000,
    });
    expect(
      await prisma.capitalOrder.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Confirming
  // -----------------------------------------------------------------------

  it('the PIN confirms: money leaves once, the ledger has the purchase, a repeat or a second key takes nothing more', async () => {
    const p = await person();
    const o = await reserved(p);

    const noPin = await confirm(p, o.id, { pin: null });
    expect(noPin.status).toBe(403);
    expect(body(noPin).reason?.code).toBe('pin_required');
    const wrong = await confirm(p, o.id, { pin: '1111' });
    expect(wrong.status).toBe(403);
    expect(body(wrong).reason?.code).toBe('pin_incorrect');
    expect(balance(p)).toBe(100_000_000);

    const key = randomUUID();
    const ok = await confirm(p, o.id, { key });
    expect(ok.status).toBe(201);
    const done = body<Order>(ok).data!;
    expect(done.status).toBe('invested');
    expect(done.holding?.lifecycle).toBe('ACTIVE');
    expect(balance(p)).toBe(99_000_000);

    const replay = await confirm(p, o.id, { key, pin: null });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const second = await confirm(p, o.id);
    expect(second.status).toBe(201);
    expect(body<Order>(second).data!.status).toBe('invested');
    expect(balance(p)).toBe(99_000_000);

    const rows = await ledgerRows(`wawu-cap-${o.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', status: 'completed' });
    expect(Number(rows[0].amountKobo)).toBe(1_000_000);
  });

  it('two taps at once confirm once', async () => {
    const p = await person();
    const o = await reserved(p);
    const [a, b] = await Promise.all([confirm(p, o.id), confirm(p, o.id)]);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(
      true,
    );
    expect(balance(p)).toBe(99_000_000);
    expect(await ledgerRows(`wawu-cap-${o.id}`)).toHaveLength(1);
  });

  it('a reservation that ran out cannot be confirmed, and nothing is taken', async () => {
    const p = await person();
    const o = await reserved(p);
    const row = await prisma.capitalOrder.findUniqueOrThrow({
      where: { id: o.id },
    });
    cap.expire(row.nuvionOrderId!);
    await prisma.capitalOrder.update({
      where: { id: o.id },
      data: { expiresAt: new Date(Date.now() - 5_000) },
    });
    const res = await confirm(p, o.id);
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('reservation_expired');
    expect(balance(p)).toBe(100_000_000);
    const view = body<Order>(await get(p, `/orders/${o.id}`).expect(200)).data!;
    expect(view.status).toBe('expired');
  });

  it('a short balance is answered before the PIN, and the PIN tries are untouched', async () => {
    const p = await person(1_200_000);
    const o = await reserved(p);
    // Money leaves the wallet some other way before the PIN is typed.
    seam.accounts.get(p.accountId)!.availableKobo = 400_000n;
    const res = await confirm(p, o.id, { pin: '1111' });
    expect(res.status).toBe(402);
    expect(body(res).reason).toMatchObject({
      code: 'insufficient_funds',
      shortfallKobo: 600_000,
    });
    const pinRow = await prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(pinRow.failedTries).toBe(0);
  });

  it('when Nuvion loses the answer, the order stays confirming and the sweep settles it once', async () => {
    const p = await person();
    const o = await reserved(p);
    cap.loseNextConfirm = true;
    const res = await confirm(p, o.id);
    expect(res.status).toBe(201);
    expect(body<Order>(res).data!.status).toBe('confirming');
    expect(balance(p)).toBe(99_000_000);

    const later = new Date(Date.now() + 120_000);
    await sweep.tick(later);
    await sweep.tick(later);
    const view = body<Order>(await get(p, `/orders/${o.id}`).expect(200)).data!;
    expect(view.status).toBe('invested');
    expect(balance(p)).toBe(99_000_000);
    expect(await ledgerRows(`wawu-cap-${o.id}`)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Holding, history, portfolio
  // -----------------------------------------------------------------------

  it('the portfolio, the history and the holding show what Nuvion holds', async () => {
    const p = await person();
    const a = await invested(p);
    await invested(p, { amountKobo: 2_000_000 });
    const port = body<{ investedKobo: number; holdings: number }>(
      await get(p, '/portfolio').expect(200),
    ).data!;
    expect(port).toMatchObject({ investedKobo: 3_000_000, holdings: 2 });
    const list = body<{ items: Order[] }>(
      await get(p, '/orders').expect(200),
    ).data!;
    expect(list.items).toHaveLength(2);
    expect(list.items[0].amountKobo).toBe(2_000_000);
    const mine = body<{ items: Order[] }>(
      await get(p, '/orders?show=holding').expect(200),
    ).data!;
    expect(mine.items).toHaveLength(2);
    const ended = body<{ items: Order[] }>(
      await get(p, '/orders?show=ended').expect(200),
    ).data!;
    expect(ended.items).toHaveLength(0);
    const tx = body<{ items: Array<{ event: string; amountKobo: number }> }>(
      await get(p, `/orders/${a.id}/transactions`).expect(200),
    ).data!;
    expect(tx.items[0]).toMatchObject({
      event: 'PURCHASE',
      amountKobo: 1_000_000,
    });
    // Somebody else's order is not found.
    const stranger = await person();
    const res = await get(stranger, `/orders/${a.id}`);
    expect(res.status).toBe(404);
  });

  it('a share offering is bought at the quote Nuvion gives, whole shares only', async () => {
    const p = await person();
    const o = await reserved(p, {
      productId: PRODUCT_SO,
      amountKobo: 1_005_000,
    });
    expect(o.quote).toMatchObject({
      allocatedShares: 100,
      baseCostKobo: 1_000_000,
    });
    const done = body<Order>(await confirm(p, o.id)).data!;
    expect(done.status).toBe('invested');
    expect(done.canWithdraw).toBe(false);
    expect(done.withdrawBlockedBy).toBe('not_for_this_product');
    expect(balance(p)).toBe(100_000_000 - o.totalKobo);
  });

  // -----------------------------------------------------------------------
  // Withdrawing
  // -----------------------------------------------------------------------

  it('early liquidation: the preview, the PIN, the payout settles and the money is back once', async () => {
    const p = await person();
    const o = await invested(p);
    expect(o.canWithdraw).toBe(true);
    const preview = body<{ netPayoutKobo: number; penaltyRate: number }>(
      await get(p, `/orders/${o.id}/withdrawal`).expect(200),
    ).data!;
    expect(preview).toMatchObject({
      netPayoutKobo: 1_000_000,
      penaltyRate: 0.15,
    });

    const wrong = await withdraw(p, o.id, { pin: '2222' });
    expect(wrong.status).toBe(403);
    expect(body(wrong).reason?.code).toBe('pin_incorrect');

    const key = randomUUID();
    const res = await withdraw(p, o.id, { key });
    expect(res.status).toBe(201);
    expect(body<Order>(res).data!.status).toBe('paying_out');
    const replay = await withdraw(p, o.id, { key, pin: null });
    expect(replay.headers['idempotent-replayed']).toBe('true');

    cap.settlePayouts();
    const view = body<Order>(await get(p, `/orders/${o.id}`).expect(200)).data!;
    expect(view.status).toBe('paid_out');
    expect(view.holding?.payoutKobo).toBe(1_000_000);
    expect(balance(p)).toBe(100_000_000);
    await get(p, `/orders/${o.id}`).expect(200);
    const rows = await ledgerRows(`wawu-cap-payout-${o.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'in', status: 'completed' });

    const again = await withdraw(p, o.id);
    expect(again.status).toBe(409);
    expect(body(again).reason?.code).toBe('withdrawal_not_available');
  });

  it('a holding Nuvion will not let out early is refused before the PIN', async () => {
    const p = await person();
    const o = await invested(p, {
      productId: PRODUCT_FR_LOCKED_ONLY,
      lockInvestment: false,
    });
    expect(o.canWithdraw).toBe(false);
    expect(o.withdrawBlockedBy).toBe('not_allowed');
    const res = await withdraw(p, o.id, { pin: '9999' });
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('withdrawal_not_available');
    const pinRow = await prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(pinRow.failedTries).toBe(0);
  });

  // -----------------------------------------------------------------------
  // The owner's controls
  // -----------------------------------------------------------------------

  it('switched off in the plan settings, new orders close and nothing is taken, but a holder still reads and withdraws what they hold', async () => {
    const holder = await person();
    const held = await invested(holder);
    const p = await person();
    const o = await reserved(p);
    const spy = jest.spyOn(plan, 'number').mockImplementation((key: string) => {
      if (key === 'capital.enabled') return 0;
      throw new Error('unexpected setting');
    });
    try {
      // Nothing to hold: no way in. A holder keeps the way in.
      expect(
        body<{ available: boolean; holding: boolean }>(
          await get(p, '/availability').expect(200),
        ).data,
      ).toEqual({ available: false, holding: false });
      expect(
        body<{ available: boolean; holding: boolean }>(
          await get(holder, '/availability').expect(200),
        ).data,
      ).toEqual({ available: false, holding: true });
      // New orders are closed: the list, a reservation, a held reservation.
      const list = await get(p, '/products');
      expect(list.status).toBe(409);
      expect(body(list).reason?.code).toBe('capital_unavailable');
      expect((await reserve(p)).status).toBe(409);
      const res = await confirm(p, o.id);
      expect(res.status).toBe(409);
      expect(body(res).reason?.code).toBe('capital_unavailable');
      expect(balance(p)).toBe(100_000_000);
      // What is held can be read and taken out.
      expect(
        body<{ investedKobo: number }>(
          await get(holder, '/portfolio').expect(200),
        ).data!.investedKobo,
      ).toBe(1_000_000);
      expect(
        body<{ items: Order[] }>(await get(holder, '/orders').expect(200)).data!
          .items,
      ).toHaveLength(1);
      await get(holder, `/orders/${held.id}`).expect(200);
      await get(holder, `/orders/${held.id}/transactions`).expect(200);
      await get(holder, `/orders/${held.id}/withdrawal`).expect(200);
      const out = await withdraw(holder, held.id);
      expect(out.status).toBe(201);
      expect(body<Order>(out).data!.status).toBe('paying_out');
    } finally {
      spy.mockRestore();
    }
    cap.settlePayouts();
    expect(plan.number('capital.enabled')).toBe(1);
  });

  it('R-97: with no saved setting Capital is off (the default), a switch that cannot be read counts as off, and a holder keeps the way in', async () => {
    const holder = await person();
    const held = await invested(holder);
    const p = await person();
    await prisma.planSetting.deleteMany({ where: { key: 'capital.enabled' } });
    await plan.refresh();
    try {
      expect(plan.number('capital.enabled')).toBe(0);
      expect(
        body<{ available: boolean; holding: boolean }>(
          await get(p, '/availability').expect(200),
        ).data,
      ).toEqual({ available: false, holding: false });
      expect(
        body<{ available: boolean; holding: boolean }>(
          await get(holder, '/availability').expect(200),
        ).data,
      ).toEqual({ available: false, holding: true });
      const list = await get(p, '/products');
      expect(list.status).toBe(409);
      expect(body(list).reason?.code).toBe('capital_unavailable');
      expect((await reserve(p)).status).toBe(409);
      // What the holder holds can still be read and taken out.
      await get(holder, `/orders/${held.id}`).expect(200);
      await get(holder, `/orders/${held.id}/withdrawal`).expect(200);
      // A setting that cannot be read counts as off, never on.
      const spy = jest.spyOn(plan, 'number').mockImplementation(() => {
        throw new Error('cannot read');
      });
      try {
        expect(
          body<{ available: boolean; holding: boolean }>(
            await get(p, '/availability').expect(200),
          ).data,
        ).toEqual({ available: false, holding: false });
      } finally {
        spy.mockRestore();
      }
    } finally {
      await prisma.planSetting.upsert({
        where: { key: 'capital.enabled' },
        create: { key: 'capital.enabled', value: 1 },
        update: { value: 1 },
      });
      await plan.refresh();
    }
    expect(plan.number('capital.enabled')).toBe(1);
  });

  it('N1: an order the provider has given no lifecycle yet is still held: it keeps the Wallet row, the portfolio count, the holding list and the sweep', async () => {
    const holder = await person();
    const held = await invested(holder);
    const spy = jest.spyOn(plan, 'number').mockImplementation((key: string) => {
      if (key === 'capital.enabled') return 0;
      throw new Error('unexpected setting');
    });
    try {
      // In review with no lifecycle yet: with Capital off, the person keeps the way in and sees it as held.
      await prisma.capitalOrder.update({
        where: { id: held.id },
        data: { state: 'review', lifecycle: null },
      });
      expect(
        body<{ available: boolean; holding: boolean }>(
          await get(holder, '/availability').expect(200),
        ).data,
      ).toEqual({ available: false, holding: true });
      expect(
        body<{ items: Order[] }>(
          await get(holder, '/orders?show=holding').expect(200),
        ).data!.items.map((o) => o.id),
      ).toEqual([held.id]);
      // Confirmed with no lifecycle yet: counted, and read by the sweep.
      await prisma.capitalOrder.update({
        where: { id: held.id },
        data: { state: 'confirmed', lifecycle: null, lastCheckedAt: null },
      });
      expect(
        body<{ holdings: number }>(await get(holder, '/portfolio').expect(200))
          .data!.holdings,
      ).toBe(1);
      await sweep.tick();
      const read = await prisma.capitalOrder.findUniqueOrThrow({
        where: { id: held.id },
      });
      expect(read.lastCheckedAt).not.toBeNull();
      expect(read.lifecycle).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('a provider with no Capital leaves it unavailable', async () => {
    const p = await person();
    provider.capital = undefined;
    try {
      expect(
        body<{ available: boolean; holding: boolean }>(
          await get(p, '/availability').expect(200),
        ).data,
      ).toEqual({ available: false, holding: false });
      expect((await get(p, '/products')).status).toBe(409);
    } finally {
      provider.capital = cap;
    }
  });

  it('WAWU limits and fee come from settings: the limit refuses, the fee is quoted, taken once and recorded', async () => {
    const p = await person();
    const original = { limits: settings.limits, fee: settings.fee };
    try {
      Object.assign(settings, {
        limits: { minKobo: null, maxKobo: 1_500_000, dailyMaxKobo: 2_000_000 },
        fee: { flatKobo: 5_000, basisPoints: 100 },
      });
      const over = await reserve(p, { amountKobo: 1_600_000 });
      expect(over.status).toBe(400);
      expect(body(over).reason).toMatchObject({
        code: 'amount_out_of_range',
        maximumKobo: 1_500_000,
      });

      const o = await reserved(p, { amountKobo: 1_000_000 });
      const next = await reserved(p, { amountKobo: 1_000_000 });
      expect(o.feeKobo).toBe(15_000);
      expect(o.totalKobo).toBe(1_015_000);
      const res = await confirm(p, o.id);
      expect(res.status).toBe(201);
      expect(balance(p)).toBe(100_000_000 - 1_000_000 - 15_000);
      const feeRows = await ledgerRows(`wawu-capfee-${o.id}`);
      expect(feeRows).toHaveLength(1);
      expect(Number(feeRows[0].amountKobo)).toBe(15_000);
      expect(feeRows[0].counterpartyName).toBe("WAWU's fee");
      await sweep.tick(new Date(Date.now() + 300_000));
      expect(balance(p)).toBe(100_000_000 - 1_000_000 - 15_000);

      // The day's limit: the first took 1,015,000 of 2,000,000, so a second
      // such order passes it, before the PIN, and a new one is not reserved.
      const day = await confirm(p, next.id, { pin: '1111' });
      expect(day.status).toBe(403);
      expect(body(day).reason).toMatchObject({
        code: 'limit_reached',
        limit: 'daily',
      });
      const third = await reserve(p, { amountKobo: 1_000_000 });
      expect(third.status).toBe(403);
      expect(body(third).reason).toMatchObject({
        code: 'limit_reached',
        limit: 'daily',
      });
    } finally {
      Object.assign(settings, original);
    }
  });

  it('the dashboard lists orders and holds, releases or cancels them, with an audit row each; the wrong role is refused', async () => {
    const p = await person();
    const held = await invested(p);
    const open = await reserved(p, { amountKobo: 2_000_000 });
    const as = (role: AdminRole) => `Bearer ${adminTokens[role]}`;

    const refused = await http()
      .get(ADMIN)
      .set('Authorization', as(AdminRole.support));
    expect(refused.status).toBe(403);
    expect((await http().get(ADMIN)).status).toBe(401);

    const list = await http()
      .get(`${ADMIN}?wawuUserId=${p.id}`)
      .set('Authorization', as(AdminRole.finance))
      .expect(200);
    const items = (
      list.body as Env<{
        items: Array<{ id: string; status: string; wawuUserId: string }>;
      }>
    ).data!.items;
    expect(items.map((i) => i.id).sort()).toEqual([held.id, open.id].sort());
    expect(JSON.stringify(items)).not.toMatch(/phone|email|accountNumber/i);

    // Freeze: the person cannot start a withdrawal until it is lifted.
    const frozen = await http()
      .post(`${ADMIN}/${held.id}/freeze`)
      .set('Authorization', as(AdminRole.superadmin))
      .send({ note: 'under review' })
      .expect(200);
    expect((frozen.body as Env<{ frozen: boolean }>).data!.frozen).toBe(true);
    const blocked = await withdraw(p, held.id);
    expect(blocked.status).toBe(409);
    expect(body(blocked).reason?.code).toBe('capital_unavailable');
    const personView = body<Order>(
      await get(p, `/orders/${held.id}`).expect(200),
    ).data!;
    expect(personView.frozen).toBe(true);
    await http()
      .post(`${ADMIN}/${held.id}/unfreeze`)
      .set('Authorization', as(AdminRole.finance))
      .send({})
      .expect(200);
    expect(
      (
        await http()
          .post(`${ADMIN}/${held.id}/unfreeze`)
          .set('Authorization', as(AdminRole.finance))
          .send({})
      ).status,
    ).toBe(409);

    // Cancel: only a reservation.
    const invest = await http()
      .post(`${ADMIN}/${held.id}/cancel`)
      .set('Authorization', as(AdminRole.finance))
      .send({});
    expect(invest.status).toBe(409);
    await http()
      .post(`${ADMIN}/${open.id}/cancel`)
      .set('Authorization', as(AdminRole.finance))
      .send({ note: 'asked by the person' })
      .expect(200);
    const res = await confirm(p, open.id);
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('capital_unavailable');
    // A cancelled reservation says so; it is not an investment "on hold".
    expect(body(res).message).toMatch(/cancelled/);
    expect(body(res).message).not.toMatch(/on hold/);
    expect(balance(p)).toBe(100_000_000 - 1_000_000);

    const audit = await prisma.capitalAdminAudit.findMany({
      where: { subjectWawuId: p.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'freeze',
      'unfreeze',
      'cancel',
    ]);
    expect(audit[0]).toMatchObject({
      adminRole: 'superadmin',
      note: 'under review',
    });
  });
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { AdminAuthModule } from '../../src/admin/auth/admin-auth.module';
import { AdminSchoolsModule } from '../../src/admin/schools/admin-schools.module';
import { MoneyModule } from '../../src/money/money.module';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../src/money/money-view.type';
import { SchoolsPublicModule } from '../../src/schools/schools-public.module';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';
import { WawuIdDouble } from '../nuvion/wawu-id-double';
import { QuietLogger, type Envelope } from '../transfers/harness';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../payments/nuvion-seam-standin';

/**
 * The school specs' common ground on NUVION (tasks SCHOOLS-09 and SCHOOLS-11):
 * the real Hub modules for money and schools, a real database, real RS256
 * tokens checked against a stand-in WAWU ID's JWKS, WAWU ID's mail relay
 * stood in (`POST /internal/mail/send`, answering a repeated Idempotency-Key
 * with the first mail), and the wallet provider seam answered by
 * `NuvionSeamStandIn` (book transfers, and bank sends from WAWU's operational
 * account). Fintava is pointed at a closed counter and never used. No
 * provider, no Nuvion host and no wawuafrica.com host is called.
 */

export const BASE = '/api/hub';
export const PIN = '4826';
export const NUVION_FEES = '0:1500,500000:2500';

export const body = <T>(res: Response) => res.body as Envelope<T>;

/** WAWU ID's mail relay, stood in. */
export class MailRelayDouble {
  /** Every request, in order (a repeat of a key is listed again). */
  readonly requests: Array<{
    key: string | undefined;
    serviceKey: string | undefined;
    to: string;
    subject: string;
    text: string;
    html: string;
  }> = [];
  /** The mails the relay made: one per Idempotency-Key. */
  readonly mails = new Map<string, { id: string; to: string; text: string }>();
  /** Answered to every request when set: 'down' is a 503, 'refuse' a 400, 'lose' takes the mail and answers 500. */
  mode: 'ok' | 'down' | 'refuse' | 'lose' = 'ok';
  private server: Server | null = null;
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  reset(): void {
    this.requests.length = 0;
    this.mails.clear();
    this.mode = 'ok';
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST' || req.url !== '/internal/mail/send') {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        let b: Record<string, string> = {};
        try {
          b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            string
          >;
        } catch {
          b = {};
        }
        const key = req.headers['idempotency-key'] as string | undefined;
        this.requests.push({
          key,
          serviceKey: req.headers['x-service-key'] as string | undefined,
          to: b.to,
          subject: b.subject,
          text: b.text,
          html: b.html,
        });
        if (this.mode === 'down') {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'busy' }));
          return;
        }
        if (this.mode === 'refuse') {
          res.statusCode = 400;
          res.end(JSON.stringify({ message: 'bad address' }));
          return;
        }
        let mail = key ? this.mails.get(key) : undefined;
        if (!mail) {
          mail = { id: `mail-${randomUUID()}`, to: b.to, text: b.text };
          if (key) this.mails.set(key, mail);
        }
        if (this.mode === 'lose') {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: 'lost' }));
          return;
        }
        res.end(JSON.stringify({ id: mail.id }));
      });
    });
    await new Promise<void>((r) =>
      this.server!.listen(0, '127.0.0.1', () => r()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
}

export function mintToken(
  sub: string,
  who: {
    firstName?: string;
    lastName?: string;
    email?: string | null;
    phone?: string;
  } = {},
): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: who.email === undefined ? `sch-${sub}@test.wawu.dev` : who.email,
      phone: who.phone ?? '+2348000009911',
      firstName: who.firstName ?? 'Ada',
      lastName: who.lastName ?? 'Student',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

export interface Person {
  id: string;
  auth: string;
  account: NuvionAccount;
}

export interface SeededClass {
  schoolId: string;
  courseId: string;
  /** In the order given. */
  intakeIds: string[];
}

export interface SchoolNuvion {
  app: INestApplication<App>;
  prisma: PrismaService;
  nuvion: NuvionSeamStandIn;
  mail: MailRelayDouble;
  logger: QuietLogger;
  users: string[];
  /** A student (or any person) with a wallet holding `kobo` and a PIN. */
  person(kobo: number, who?: Parameters<typeof mintToken>[1]): Promise<Person>;
  /** A school with one course and these intakes. */
  seed(opts: {
    priceKobo: number;
    intakes: Array<{ capacity: number; startDate: string }>;
    title?: string;
    schoolName?: string;
    weeks?: number;
    reportEmail?: string;
  }): Promise<SeededClass>;
  /** POST /schools/enrolments. */
  enrol(p: Person, intakeId: string): request.Test;
  /** Pays the enrolment's fee from the wallet (quote, PIN) and answers the payment. */
  pay(p: Person, enrolmentId: string): Promise<PaymentView>;
  /** The Authorization header of an admin of this role (made on first ask). */
  adminAuth(role: 'superadmin' | 'reviewer' | 'finance'): Promise<{
    Authorization: string;
  }>;
  /** Enrols and pays: the enrolment id. */
  enrolAndPay(p: Person, intakeId: string): Promise<string>;
  get(p: Person, path: string): request.Test;
  close(): Promise<void>;
}

let accountSeq = 0;

export async function bootSchoolNuvion(
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<SchoolNuvion> {
  const nuvion = new NuvionSeamStandIn();
  const mail = new MailRelayDouble();
  const wawuId = new WawuIdDouble();
  const logger = new QuietLogger();
  await mail.start();
  await wawuId.start();
  const counter = createServer((_req, res) => {
    res.statusCode = 503;
    res.end('{}');
  });
  await new Promise<void>((r) => counter.listen(0, '127.0.0.1', () => r()));
  const counterPort = (counter.address() as AddressInfo).port;
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    FINTAVA_BASE_URL: `http://127.0.0.1:${counterPort}`,
    FINTAVA_API_KEY: `live_test_${tag}_0123456789FAKEKEY`,
    FEE_QUOTE_KEY: `${tag}-fee-quote-key-0123456789abcdef0123`,
    MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
    NUVION_FEE_BOOK_TRANSFER: NUVION_FEES,
    NUVION_FEE_BANK_PAYOUT: NUVION_FEES,
    NUVION_FEE_INFLOW: NUVION_FEES,
    WAWU_ID_JWKS_URL: wawuId.jwksUrl,
    WAWU_ID_BASE_URL: mail.baseUrl,
    WAWU_ID_INTERNAL_SERVICE_KEY: 'school-test-service-key',
    ADMIN_JWT_SECRET: `${tag}-admin-access-secret-0123456789abcdef01`,
    ADMIN_JWT_REFRESH_SECRET: `${tag}-admin-refresh-secret-0123456789abcdef0`,
    PIN_LOCK_MINUTES: '',
    IDEMPOTENCY_KEY_HOURS: '',
    PAYMENT_REVIEW_AFTER_HOURS: '',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      AdminAuthModule,
      MoneyModule,
      SchoolsPublicModule,
      AdminSchoolsModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .overrideProvider(WALLET_PROVIDER)
    .useValue(nuvion)
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
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
  const prisma = moduleRef.get(PrismaService);
  nuvion.operational.availableKobo = 5_000_000_000n;

  const users: string[] = [];
  const schoolIds: string[] = [];
  const adminIds: string[] = [];
  const adminTokens = new Map<string, { Authorization: string }>();

  const h: SchoolNuvion = {
    app,
    prisma,
    nuvion,
    mail,
    logger,
    users,
    async person(kobo, who) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `84${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
      const account = nuvion.openAccount(BigInt(kobo), accountNumber);
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: account.entityId,
          walletId: account.accountId,
          accountNumber,
          provider: 'nuvion',
        },
      });
      const auth = `Bearer ${mintToken(id, who)}`;
      const set = await request(app.getHttpServer())
        .post(`${BASE}/money/pin`)
        .set('Authorization', auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      if (set.status !== 201) throw new Error(`pin not set: ${set.status}`);
      return { id, auth, account };
    },
    async seed(opts) {
      const school = await prisma.school.create({
        data: {
          name: opts.schoolName ?? `Greenfield ${randomUUID().slice(0, 6)}`,
          category: 'tech',
          location: 'Yaba, Lagos',
          about: 'A school.',
          reportEmail:
            opts.reportEmail ??
            `office-${randomUUID().slice(0, 8)}@school.test`,
        },
      });
      schoolIds.push(school.id);
      const course = await prisma.schoolCourse.create({
        data: {
          schoolId: school.id,
          title: opts.title ?? 'Product Design Bootcamp',
          weeks: opts.weeks ?? 12,
          mode: 'in_person',
          syllabus: ['Basics'],
          outcomes: ['Certificate'],
          priceKobo: opts.priceKobo,
        },
      });
      const intakeIds: string[] = [];
      for (const i of opts.intakes) {
        const intake = await prisma.courseIntake.create({
          data: {
            courseId: course.id,
            startDate: new Date(`${i.startDate}T00:00:00.000Z`),
            schedule: 'Saturdays',
            location: 'Yaba',
            capacity: i.capacity,
          },
        });
        intakeIds.push(intake.id);
      }
      return { schoolId: school.id, courseId: course.id, intakeIds };
    },
    enrol(p, intakeId) {
      return request(app.getHttpServer())
        .post(`${BASE}/schools/enrolments`)
        .set('Authorization', p.auth)
        .send({ intakeId });
    },
    async pay(p, enrolmentId) {
      nuvion.mode = 'successful';
      const qres = await request(app.getHttpServer())
        .get(
          `${BASE}/money/payments/quote?kind=school_fee&targetId=${enrolmentId}`,
        )
        .set('Authorization', p.auth);
      if (qres.status !== 200) {
        throw new Error(`quote ${qres.status}: ${qres.text.slice(0, 200)}`);
      }
      const q = body<PaymentQuoteView>(qres).data!;
      nuvion.feeKobo = () => BigInt(q.fee.providerFeeKobo);
      const res = await request(app.getHttpServer())
        .post(`${BASE}/money/payments`)
        .set('Authorization', p.auth)
        .set('Idempotency-Key', randomUUID())
        .set('X-Transaction-Pin', PIN)
        .send({
          kind: q.kind,
          targetId: q.targetId,
          expectedTotalKobo: q.totalKobo,
          quoteToken: q.quoteToken,
        });
      nuvion.feeKobo = () => 0n;
      nuvion.mode = 'pending';
      if (res.status !== 201) {
        throw new Error(`payment ${res.status}: ${res.text.slice(0, 300)}`);
      }
      return body<PaymentView>(res).data!;
    },
    async adminAuth(role) {
      const known = adminTokens.get(role);
      if (known) return known;
      const argon2 = await import('argon2');
      const id = randomUUID();
      adminIds.push(id);
      const email = `${tag}-${role}-${id.slice(0, 8)}@admin.test.wawu.dev`;
      await prisma.adminUser.create({
        data: {
          id,
          email,
          passwordHash: await argon2.hash('school-money-admin-password'),
          name: `${tag} ${role}`,
          role,
        },
      });
      const res = await request(app.getHttpServer())
        .post(`${BASE}/admin/auth/login`)
        .send({ email, password: 'school-money-admin-password' });
      if (res.status !== 200) throw new Error(`admin login ${res.status}`);
      const header = {
        Authorization: `Bearer ${(res.body as { data: { accessToken: string } }).data.accessToken}`,
      };
      adminTokens.set(role, header);
      return header;
    },
    async enrolAndPay(p, intakeId) {
      const made = await h.enrol(p, intakeId);
      if (made.status !== 201) {
        throw new Error(`enrol ${made.status}: ${made.text.slice(0, 200)}`);
      }
      const id = (made.body as { data: { id: string } }).data.id;
      await h.pay(p, id);
      return id;
    },
    get(p, path) {
      return request(app.getHttpServer())
        .get(`${BASE}${path}`)
        .set('Authorization', p.auth);
    },
    async close() {
      const payments = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { id: true, customerReference: true },
      });
      const holds = await prisma.walletHold.findMany({
        where: { paymentId: { in: payments.map((p) => p.id) } },
        select: { customerReference: true },
      });
      const settlementRows = await prisma.schoolSettlement.findMany({
        where: { schoolId: { in: schoolIds } },
        select: { id: true },
      });
      const settlementRefs = settlementRows.flatMap((r) => [
        `wawu-bank-sch-${r.id}`,
        `wawu-bank-sch-${r.id}-2`,
      ]);
      const refs = [
        ...payments.map((p) => p.customerReference),
        ...holds
          .map((x) => x.customerReference)
          .filter((r): r is string => !!r),
        ...settlementRefs,
      ];
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: refs } },
            { wawuUserId: { in: users } },
            { paymentId: { in: payments.map((p) => p.id) } },
          ],
        },
      });
      await prisma.schoolSettlement.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      await prisma.schoolEnrolment.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      await prisma.walletHold.deleteMany({
        where: { paymentId: { in: payments.map((p) => p.id) } },
      });
      await prisma.walletPayment.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.schoolPayee.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      await prisma.school.deleteMany({ where: { id: { in: schoolIds } } });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await app.close();
      await mail.stop();
      await wawuId.stop();
      await new Promise<void>((r) => counter.close(() => r()));
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
  return h;
}

import {
  createHash,
  generateKeyPairSync,
  randomInt,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
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
import type { MoneyErrorReason } from '../../src/money/dto/money-error.dto';
import { MoneyModule } from '../../src/money/money.module';
import { approvalMessage } from '../../src/money/pin/approval-device.service';
import { BVN_200, FintavaDouble } from '../fintava/fintava-double';

/**
 * The app, the people and the phone keys the MONEY-14 contract specs share
 * (PIN reset by a code, biometric approval). A real database, real RS256
 * tokens checked over the stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL), and
 * the real MONEY-06 Fintava client over a socket to FintavaDouble, which
 * answers `/sms/send` the way the sandbox documents it (`{}`) unless a test
 * says otherwise. Each person is new, so each test owns its rows.
 */

export const TIMEOUT_MS = 2_000;

/** Every line any part of the app or the process printed. */
export class Captured implements LoggerService {
  lines: string[] = [];
  private restores: Array<() => void> = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(
      `${level} ${args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ')}`,
    );
  }
  log(...a: unknown[]) {
    this.push('log', a);
  }
  error(...a: unknown[]) {
    this.push('error', a);
  }
  warn(...a: unknown[]) {
    this.push('warn', a);
  }
  debug(...a: unknown[]) {
    this.push('debug', a);
  }
  verbose(...a: unknown[]) {
    this.push('verbose', a);
  }
  fatal(...a: unknown[]) {
    this.push('fatal', a);
  }
  /** Also takes stdout, stderr and console for the life of the file. */
  hook(): void {
    const take = (target: object, method: string) => {
      const t = target as Record<string, (...a: unknown[]) => unknown>;
      const original = t[method];
      t[method] = (...args: unknown[]) => {
        this.push(method, args);
        return true;
      };
      this.restores.push(() => {
        t[method] = original;
      });
    };
    take(process.stdout, 'write');
    take(process.stderr, 'write');
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
      take(console, m);
  }
  unhook(): void {
    for (const r of this.restores.splice(0)) r();
  }
}

export type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};

export type Person = {
  id: string;
  auth: string;
  /** E.164: the token's phone and, after bvnChecked, the proved one. */
  phone: string;
  bvn: string;
  nin: string;
};

/** A P-256 key pair, as the phone makes one. */
export type PhoneKey = { publicKey: string; privateKey: KeyObject };

export function phoneKey(): PhoneKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    publicKey: publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url'),
    privateKey,
  };
}

/** What the app sends as X-Device-Approval: the phone key's signature over the challenge and the request. */
export function signApproval(
  key: PhoneKey,
  challenge: { challengeId: string; challenge: string; deviceId: string },
  request: { method: string; url: string; body?: string },
): string {
  const message = approvalMessage({
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    deviceId: challenge.deviceId,
    request: {
      method: request.method,
      url: request.url,
      body: Buffer.from(request.body ?? '', 'utf8'),
    },
  });
  const signature = sign('sha256', Buffer.from(message, 'utf8'), {
    key: key.privateKey,
    dsaEncoding: 'der',
  });
  return `v1.${challenge.challengeId}.${signature.toString('base64url')}`;
}

export function digits(n: number): string {
  let out = String(randomInt(1, 10));
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function mintToken(sub: string, phone: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `m14-${sub}@example.com`,
      phone,
      firstName: 'Reset',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

export class Money14App {
  app!: INestApplication<App>;
  prisma!: PrismaService;
  readonly double = new FintavaDouble();
  readonly log = new Captured();
  /** Every response body, for the scans that nothing secret was answered. */
  readonly answered: string[] = [];
  readonly users: string[] = [];
  private previous: Record<string, string | undefined> = {};

  constructor(private readonly env: Record<string, string>) {}

  async start(): Promise<void> {
    this.log.hook();
    await this.double.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: this.double.baseUrl,
      FINTAVA_API_KEY: 'live_test_m14_reset_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(TIMEOUT_MS),
      IDENTITY_HASH_KEY: 'm14-test-identity-hash-key-0123456789abcdef',
      BVN_CHECKS_PER_DAY: '',
      PIN_LOCK_MINUTES: '',
      PIN_RESET_CODE_SECONDS: '',
      PIN_RESET_RESEND_SECONDS: '',
      PIN_RESET_TEXTS_PER_DAY: '',
      DEVICE_APPROVAL_SECONDS: '',
      ...this.env,
    };
    for (const [k, v] of Object.entries(env)) {
      this.previous[k] = process.env[k];
      process.env[k] = v;
    }
    this.installDefaults();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .setLogger(this.log)
      .compile();
    this.app = moduleRef.createNestApplication({
      ...HUB_APP_OPTIONS,
      logger: this.log,
    });
    this.app.useLogger(this.log);
    this.app.setGlobalPrefix('api/hub');
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    this.app.useGlobalFilters(new AllExceptionsFilter());
    this.app.useGlobalInterceptors(new ResponseInterceptor());
    await this.app.init();
    // One server for the whole file (FIX-02): concurrent requests are not
    // reset by a per-request server closing under them.
    await this.app.listen(0, '127.0.0.1');
    this.prisma = moduleRef.get(PrismaService);
  }

  /** `/sms/send` answers `{}` (the reference page) and BVN checks pass for whoever asks. */
  installDefaults(): void {
    this.double.reset();
    this.double.on('POST', '/sms/send', { status: 200, body: {} });
  }

  async stop(): Promise<void> {
    if (this.prisma) {
      const where = { wawuUserId: { in: this.users } };
      await this.prisma.approvalChallenge.deleteMany({ where });
      await this.prisma.approvalDevice.deleteMany({ where });
      await this.prisma.transactionPinReset.deleteMany({ where });
      await this.prisma.transactionPin.deleteMany({ where });
      await this.prisma.walletIdentity.deleteMany({ where });
      await this.prisma.bvnCheckAttempt.deleteMany({ where });
      await this.prisma.fintavaWallet.deleteMany({ where });
    }
    if (this.app) await this.app.close();
    await this.double.stop();
    for (const [k, v] of Object.entries(this.previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    this.log.unhook();
  }

  http() {
    return request(this.app.getHttpServer());
  }

  body<T>(res: Response): Envelope<T> {
    this.answered.push(res.text);
    return res.body as Envelope<T>;
  }

  person(phone?: string): Person {
    const id = randomUUID();
    this.users.push(id);
    const e164 = phone ?? `+23480${digits(8)}`;
    return {
      id,
      auth: `Bearer ${mintToken(id, e164)}`,
      phone: e164,
      bvn: digits(11),
      nin: digits(11),
    };
  }

  /**
   * Gives `who` an open wallet as MONEY-12 records one (a FintavaWallet
   * row): the PIN and every MONEY-14 route are behind the wallet gate
   * (MONEY-13), and the PIN is set once the wallet is open (A9 after A8).
   */
  async openWallet(who: Person): Promise<void> {
    this.walletCount += 1;
    await this.prisma.fintavaWallet.create({
      data: {
        wawuUserId: who.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `14${digits(6)}${String(this.walletCount % 100).padStart(2, '0')}`,
      },
    });
  }

  private walletCount = 0;

  /** The same person signed in again with a token naming another phone. */
  reissue(who: Person, phone: string): Person {
    return { ...who, phone, auth: `Bearer ${mintToken(who.id, phone)}` };
  }

  /** KYC-01's BVN check, passed through its own route: it proves `who.phone`. */
  async bvnChecked(who: Person): Promise<void> {
    this.double.on('GET', '/compliance/verify/bvn', {
      status: 200,
      body: {
        data: {
          ...BVN_200.data,
          bvn: who.bvn,
          phone_number1: `0${who.phone.slice(4)}`,
        },
      },
    });
    await this.http()
      .post('/api/hub/money/identity/bvn')
      .set('Authorization', who.auth)
      .send({ bvn: who.bvn, nin: who.nin })
      .expect(200);
  }

  async setPin(who: Person, pin: string): Promise<void> {
    await this.http()
      .post('/api/hub/money/pin')
      .set('Authorization', who.auth)
      .send({ pin, pinConfirmation: pin })
      .expect(201);
  }

  pinState(who: Person) {
    return this.http().get('/api/hub/money/pin').set('Authorization', who.auth);
  }

  /** POST /money/approval/verify: the check every debit makes. */
  approveWithPin(who: Person, pin: string) {
    return this.http()
      .post('/api/hub/money/approval/verify')
      .set('Authorization', who.auth)
      .set('X-Transaction-Pin', pin);
  }

  /** Texts the stand-in Fintava received, in order. */
  texts(): Array<{ to: string; sms: string }> {
    return this.double.seen
      .filter((r) => r.method === 'POST' && r.path === '/sms/send')
      .map((r) => r.body as { to: string; sms: string });
  }

  /** The 6-digit code in the last text sent to `phone`. */
  lastCode(phone: string): string {
    const sent = this.texts().filter((t) => t.to === phone);
    const last = sent[sent.length - 1];
    if (!last) throw new Error(`no text was sent to ${phone}`);
    const m = /\b(\d{6})\b/.exec(last.sms);
    if (!m) throw new Error('the text carries no 6-digit code');
    return m[1];
  }
}

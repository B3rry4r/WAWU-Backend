import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { NO_WALLET_MESSAGE } from '../../gate/wallet-gate';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import {
  EMAIL_NOT_VERIFIED_MESSAGE,
  STATEMENT_EMAIL_FAILED_MESSAGE,
} from '../statement-email.service';
import type {
  StatementDeliveryView,
  StatementEmailView,
} from '../statement-email-view.type';
import { STATEMENT_RATE_LIMITED_MESSAGE } from '../statement-config';
import { StatementService } from '../statement.service';
import type { StatementView } from '../statement-view.type';

/**
 * Emailing a statement over HTTP (task WALLET-35): the real MoneyModule, a
 * real database, real RS256 tokens checked against the stand-in WAWU ID's
 * JWKS, and a stand-in for WAWU ID's mail relay (`POST /internal/mail/send`)
 * that records every request. Every person is a brand-new wawuUserId with a
 * brand-new wallet; afterAll deletes their rows.
 */

const BASE = '/api/hub/money/statements';
const SEPT = { from: '2026-09-01', to: '2026-09-30', format: 'csv' };
const KEY = 'test-service-key';

function mintToken(
  sub: string,
  claims: { email: string | null; emailVerified?: boolean },
): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: claims.email,
      ...(claims.emailVerified === undefined
        ? {}
        : { emailVerified: claims.emailVerified }),
      phone: '+2348000009995',
      firstName: 'Statement',
      lastName: 'Mailer',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => res.body as Envelope<T>;

interface Relayed {
  headers: IncomingMessage['headers'];
  body: {
    to: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  };
}

let accountSeq = 0;
function nuban(): string {
  accountSeq += 1;
  return `7${String(Date.now()).slice(-6)}${String(accountSeq).padStart(3, '0')}`;
}

describe('POST /money/statements/email and GET /money/statements/delivery (WALLET-35) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let statements: StatementService;
  let relay: Server;
  let relayCaptured: Relayed[] = [];
  let relayScript: Array<{ status: number; message?: string }> = [];
  const users: string[] = [];
  const accounts: string[] = [];

  type Holder = { id: string; auth: string; account: string; email: string };

  async function person(
    opts: {
      wallet?: boolean;
      email?: string | null;
      emailVerified?: boolean;
    } = {},
  ): Promise<Holder> {
    const id = randomUUID();
    users.push(id);
    const email =
      opts.email === undefined
        ? `w35-${id.slice(0, 8)}@test.wawu.dev`
        : opts.email;
    const account = nuban();
    if (opts.wallet !== false) {
      accounts.push(account);
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: account,
        },
      });
    }
    return {
      id,
      account,
      email: email ?? '',
      auth: `Bearer ${mintToken(id, {
        email,
        emailVerified: opts.emailVerified ?? true,
      })}`,
    };
  }

  async function money(
    p: Holder,
    direction: 'in' | 'out',
    amountKobo: number,
    occurredAt: string,
    status: 'completed' | 'pending' = 'completed',
  ) {
    await ledger.record({
      wallet: { kind: 'user', wawuUserId: p.id, accountNumber: p.account },
      direction,
      status,
      category: 'transfer',
      amountKobo,
      references: { customerReference: `W35-${randomUUID()}` },
      source: 'send',
      occurredAt: new Date(occurredAt),
    });
  }

  const post = (auth: string | undefined, payload: object, key?: string) => {
    let req = request(app.getHttpServer()).post(`${BASE}/email`).send(payload);
    if (auth) req = req.set('Authorization', auth);
    if (key) req = req.set('Idempotency-Key', key);
    return req;
  };
  const get = (auth: string | undefined, path: string) => {
    const req = request(app.getHttpServer()).get(path);
    return auth ? req.set('Authorization', auth) : req;
  };

  beforeAll(async () => {
    relay = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const next = relayScript.shift();
        if (next && next.status !== 200) {
          res.writeHead(next.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: next.message ?? 'refused' }));
          return;
        }
        relayCaptured.push({
          headers: req.headers,
          body: JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as Relayed['body'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `relay-${relayCaptured.length}` }));
      });
    });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
    process.env.WAWU_ID_BASE_URL = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    process.env.WAWU_ID_INTERNAL_SERVICE_KEY = KEY;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new QuietLogger() });
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
    ledger = moduleRef.get(LedgerService);
    statements = moduleRef.get(StatementService);
  });

  beforeEach(() => {
    relayCaptured = [];
    relayScript = [];
  });

  afterAll(async () => {
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { accountNumber: { in: accounts } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
    await new Promise((r) => relay.close(r));
    delete process.env.WAWU_ID_BASE_URL;
    delete process.env.WAWU_ID_INTERNAL_SERVICE_KEY;
  });

  describe('who can ask', () => {
    it('without a token: 401, and nothing is sent', async () => {
      await post(undefined, SEPT).expect(401);
      await get(undefined, `${BASE}/delivery`).expect(401);
      expect(relayCaptured).toHaveLength(0);
    });

    it('no wallet yet: 409 wallet_not_open on both routes, before the body is checked', async () => {
      const p = await person({ wallet: false });
      for (const res of [
        await post(p.auth, SEPT).expect(409),
        await post(p.auth, { nonsense: true }).expect(409),
        await get(p.auth, `${BASE}/delivery`).expect(409),
      ]) {
        expect(body(res).reason).toEqual({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
      }
      expect(relayCaptured).toHaveLength(0);
    });
  });

  describe('GET /money/statements/delivery', () => {
    it('names the person’s own confirmed address, masked, and the formats served', async () => {
      const p = await person({ email: 'lennox.a@wawu.africa' });
      const res = await get(p.auth, `${BASE}/delivery`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body<StatementDeliveryView>(res).data).toEqual({
        email: 'l***@wawu.africa',
        canEmail: true,
        formats: ['csv'],
      });
    });

    it.each([
      ['an email that was never confirmed', { emailVerified: false }],
      ['a token with no confirmed flag at all', { emailVerified: undefined }],
      ['an account with no email', { email: null }],
      ['an address that is not one', { email: 'not-an-address' }],
    ])('%s: canEmail false and no address named', async (_name, opts) => {
      const p = await person(opts);
      // person() defaults the flag to true: take it off for the no-flag case.
      const auth =
        'emailVerified' in opts && opts.emailVerified === undefined
          ? `Bearer ${mintToken(p.id, { email: p.email })}`
          : p.auth;
      const res = await get(auth, `${BASE}/delivery`).expect(200);
      expect(body<StatementDeliveryView>(res).data).toEqual({
        email: null,
        canEmail: false,
        formats: ['csv'],
      });
    });
  });

  describe('POST /money/statements/email', () => {
    it('mails exactly the period’s completed movements as one CSV attachment, to the token’s own address', async () => {
      const p = await person();
      await money(p, 'in', 150_000, '2026-09-01T00:30:00.000+01:00'); // first instant, Lagos
      await money(p, 'out', 40_000, '2026-09-15T12:00:00.000+01:00');
      await money(p, 'in', 5_000, '2026-09-30T23:59:59.000+01:00'); // last second, Lagos
      await money(p, 'in', 9_900, '2026-08-31T23:59:59.000+01:00'); // before
      await money(p, 'in', 8_800, '2026-10-01T00:00:01.000+01:00'); // after
      await money(p, 'in', 7_700, '2026-09-10T10:00:00.000+01:00', 'pending'); // not completed

      const res = await post(p.auth, SEPT).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const sent = body<StatementEmailView>(res).data!;
      expect(sent).toMatchObject({
        from: '2026-09-01',
        to: '2026-09-30',
        format: 'csv',
        fileName: 'statement-2026-09-01-to-2026-09-30.csv',
        rowCount: 3,
        sentTo: `w***@test.wawu.dev`,
      });
      expect(Number.isNaN(Date.parse(sent.sentAt))).toBe(false);
      // The address is named back masked, never whole.
      expect(JSON.stringify(res.body)).not.toContain(p.email);

      expect(relayCaptured).toHaveLength(1);
      const mail = relayCaptured[0];
      expect(mail.headers['x-service-key']).toBe(KEY);
      expect(mail.body.to).toBe(p.email);
      expect(mail.body.attachments).toHaveLength(1);
      const file = mail.body.attachments![0];
      expect(file.filename).toBe(sent.fileName);
      expect(file.contentType).toBe('text/csv; charset=utf-8');

      // The attachment is the very file GET /money/statements serves.
      const served = body<StatementView>(
        await get(
          p.auth,
          `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`,
        ).expect(200),
      ).data!;
      const text = Buffer.from(file.content, 'base64').toString('utf8');
      expect(text).toBe(served.content);
      expect(text.startsWith('﻿')).toBe(true);
      expect(text.split('\r\n').filter(Boolean)).toHaveLength(1 + 3);
      expect(text).toContain('1500.00');
      expect(text).toContain('400.00');
      expect(text).toContain('50.00');
      for (const out of ['99.00', '88.00', '77.00'])
        expect(text).not.toContain(out);
    });

    it('the mail says the period and the count, in plain words with no em-dash', async () => {
      const p = await person();
      await money(p, 'in', 10_000, '2026-09-05T10:00:00.000+01:00');
      await post(p.auth, SEPT).expect(200);
      const { subject, text, html } = relayCaptured[0].body;
      expect(subject).toBe(
        'Your wallet statement, 1 September 2026 to 30 September 2026',
      );
      expect(text).toContain('1 movement is listed');
      expect(text).toContain('statement-2026-09-01-to-2026-09-30.csv');
      expect(html).toContain('<p>');
      for (const s of [subject, text, html]) expect(s).not.toContain('—');
      // A mail with no movements still goes, and says so.
      const empty = await person();
      await post(empty.auth, SEPT).expect(200);
      expect(relayCaptured[1].body.text).toContain('0 movements are listed');
    });

    it('takes no address: a `to` or `email` in the body is a 400 and nothing is sent', async () => {
      const p = await person();
      for (const extra of [
        { to: 'x@y.com' },
        { email: 'x@y.com' },
        { sendTo: 'x@y.com' },
      ]) {
        const res = await post(p.auth, { ...SEPT, ...extra }).expect(400);
        expect(body(res).data).toBeNull();
      }
      expect(relayCaptured).toHaveLength(0);
    });

    it('the period’s own 400s come before the 409 and before anything is sent', async () => {
      const p = await person({ emailVerified: false });
      const tomorrow = new Date(Date.now() + 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const bad of [
        { ...SEPT, from: '2026-02-30' },
        { ...SEPT, from: '2026-09-30', to: '2026-09-01' },
        { ...SEPT, to: tomorrow },
        { from: '2025-01-01', to: '2026-09-30', format: 'csv' },
        { ...SEPT, format: 'pdf' },
        { from: '2026-09-01', to: '2026-09-30' },
      ]) {
        await post(p.auth, bad).expect(400);
      }
      expect(relayCaptured).toHaveLength(0);
    });

    it('an email that is not confirmed is 409 email_not_verified, sends nothing and is not counted', async () => {
      const p = await person({ emailVerified: false });
      for (let i = 0; i < 8; i += 1) {
        const res = await post(p.auth, SEPT).expect(409);
        expect(body(res).reason).toEqual({
          code: 'email_not_verified',
          message: EMAIL_NOT_VERIFIED_MESSAGE,
        });
      }
      expect(relayCaptured).toHaveLength(0);
      const noEmail = await person({ email: null });
      await post(noEmail.auth, SEPT).expect(409);
    });

    it('when WAWU ID cannot send: 503 statement_email_failed, whatever it said, with no address in the answer', async () => {
      const p = await person();
      for (const status of [503, 502, 429, 400, 401]) {
        relayScript = [{ status, message: `no mail for ${p.email}` }];
        const res = await post(p.auth, SEPT).expect(503);
        expect(body(res).reason).toEqual({
          code: 'statement_email_failed',
          message: STATEMENT_EMAIL_FAILED_MESSAGE,
        });
        expect(JSON.stringify(res.body)).not.toContain(p.email);
      }
      // WAWU ID not set up on this server at all.
      const saved = process.env.WAWU_ID_BASE_URL;
      process.env.WAWU_ID_BASE_URL = '';
      try {
        const q = await person();
        const res = await post(q.auth, SEPT).expect(503);
        expect(body(res).reason?.code).toBe('statement_email_failed');
      } finally {
        process.env.WAWU_ID_BASE_URL = saved;
      }
      expect(relayCaptured).toHaveLength(0);
    });

    it('a repeat with the same Idempotency-Key reaches the sender under the same key; another person’s key, or none, does not', async () => {
      const a = await person();
      const b = await person();
      await post(a.auth, SEPT, 'attempt-0001-abcdef').expect(200);
      await post(a.auth, SEPT, 'attempt-0001-abcdef').expect(200);
      await post(b.auth, SEPT, 'attempt-0001-abcdef').expect(200);
      await post(a.auth, SEPT).expect(200);
      await post(a.auth, SEPT).expect(200);
      const keys = relayCaptured.map((m) =>
        String(m.headers['idempotency-key']),
      );
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
      expect(new Set(keys).size).toBe(4);
      for (const k of keys) {
        expect(k).toMatch(/^stmt-[A-Za-z0-9-]{20,60}$/);
        expect(k).not.toContain(a.id);
      }
      // A key that is not 8 to 128 of A-Z a-z 0-9 _ - is ignored, not an error.
      await post(a.auth, SEPT, 'short').expect(200);
    });

    it('shares the statement limit: five in a minute, then 429 for the mail and for the download alike', async () => {
      const p = await person();
      for (let i = 0; i < 3; i += 1) await post(p.auth, SEPT).expect(200);
      await get(
        p.auth,
        `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`,
      ).expect(200);
      await post(p.auth, SEPT).expect(200);
      const before = relayCaptured.length;
      const mail = await post(p.auth, SEPT).expect(429);
      expect(body(mail).reason).toMatchObject({
        code: 'statement_rate_limited',
        message: STATEMENT_RATE_LIMITED_MESSAGE,
      });
      await get(
        p.auth,
        `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`,
      ).expect(429);
      expect(relayCaptured).toHaveLength(before);
    });

    it('a period too large to list gives its place back, like the download', async () => {
      const p = await person();
      const spy = jest
        .spyOn(statements, 'statement')
        .mockRejectedValue(new MoneyError('statement_too_large', 'too large'));
      try {
        for (let i = 0; i < 8; i += 1) await post(p.auth, SEPT).expect(400);
      } finally {
        spy.mockRestore();
      }
      await post(p.auth, SEPT).expect(200);
      expect(relayCaptured).toHaveLength(1);
    });
  });
});

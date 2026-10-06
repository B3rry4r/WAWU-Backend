import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  applyHubHttpSettings,
  HUB_APP_OPTIONS,
} from '../../../hub-app-options';
import { HUB_THROTTLERS } from '../../../hub-throttlers';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { NO_WALLET_MESSAGE } from '../../gate/wallet-gate';
import { HISTORY_NOT_FOUND_MESSAGE } from '../../history/transaction-history.service';
import type { LedgerMovementInput } from '../../ledger/ledger.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyModule } from '../../money.module';
import { newReceiptCode } from '../receipt-code';
import { ReceiptService } from '../receipt.service';
import { DrawLimiter, RECEIPT_BUSY_MESSAGE } from '../receipt-draw-limiter';
import { D3_FORMS, visibleDigits } from './d3-forms';
import { RECEIPT_NOT_FOUND_PAGE } from '../receipt-page';
import type { ReceiptView } from '../receipt-view.type';

/**
 * Receipts over HTTP (task WALLET-18): the real MoneyModule behind the
 * app's own throttlers and global guard, a real database, real RS256 tokens
 * checked against the stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL), and
 * ledger rows written by the ledger's own writer (LedgerService.record), so
 * a receipt shows what the ledger stores. The HTTP settings are main.ts's
 * (one trusted nginx hop on loopback), so each test sends from its own
 * address in X-Forwarded-For and no test spends another's rate limit.
 * Every person is a brand-new wawuUserId; afterAll deletes their rows.
 *
 * The server listens on 127.0.0.1 after init (FIX-02): one test sends
 * requests at once.
 */

const BASE = '/api/hub/money/transactions';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `receipt-${sub}@test.wawu.dev`,
      phone: '+2348000007718',
      firstName: 'Receipt',
      lastName: 'Tester',
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
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => res.body as Envelope<T>;

let accountSeq = 0;
/** A NUBAN no other test run holds. */
function nuban(): string {
  accountSeq += 1;
  return `7${String(Date.now()).slice(-6)}${String(accountSeq).padStart(3, '0')}`;
}

let addressSeq = 0;
/** An address of its own (documentation range), so each test has its own rate-limit buckets. */
function address(): string {
  addressSeq += 1;
  return `198.51.100.${(addressSeq % 250) + 1}`;
}

/** A supertest parser that keeps a binary body as a Buffer. */
function binary(
  res: Response,
  done: (err: Error | null, body: Buffer) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('Receipts (WALLET-18) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let receipts: ReceiptService;
  const logger = new QuietLogger();
  const users: string[] = [];
  const accounts: string[] = [];

  type Person = { id: string; auth: string; account: string; ip: string };

  function newUser() {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}`, ip: address() };
  }

  async function withWallet(accountName: string | null): Promise<Person> {
    const user = newUser();
    const account = nuban();
    accounts.push(account);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: user.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: account,
        accountName,
      },
    });
    return { ...user, account };
  }

  type Move = Omit<LedgerMovementInput, 'wallet' | 'references' | 'source'> & {
    ref?: string;
  };

  async function record(p: Person, m: Move): Promise<string> {
    const { ref, ...rest } = m;
    const r = await ledger.record({
      ...rest,
      wallet: { kind: 'user', wawuUserId: p.id, accountNumber: p.account },
      references: { customerReference: ref ?? `W18-${randomUUID()}` },
      source: 'send',
    });
    return r.entryId;
  }

  const http = () => request(app.getHttpServer());
  const issue = (p: { auth?: string; ip: string }, id: string) => {
    const r = http().post(`${BASE}/${id}/receipt`).set('X-Forwarded-For', p.ip);
    return p.auth ? r.set('Authorization', p.auth) : r;
  };
  const drawn = (
    p: { auth?: string; ip: string },
    id: string,
    kind: 'image' | 'pdf',
  ) => {
    const r = http()
      .get(`${BASE}/${id}/receipt/${kind}`)
      .set('X-Forwarded-For', p.ip)
      .buffer(true)
      .parse(binary);
    return p.auth ? r.set('Authorization', p.auth) : r;
  };
  const page = (code: string, ip = address()) =>
    http()
      .get(`/api/hub/r/${encodeURIComponent(code)}`)
      .set('X-Forwarded-For', ip);

  /** A tip into A's wallet from B (a WAWU user), and A's send to a bank: one in row, one out row. */
  async function scene() {
    const a = await withWallet('Lennox Emmanuel Okafor');
    const b = await withWallet('Amaka Nwosu');
    await prisma.userProfile.create({
      data: {
        wawuUserId: b.id,
        accountType: 'user',
        handle: `amaka${String(Date.now()).slice(-6)}${accountSeq}`,
      },
    });
    const tipRef = `W18-TIP-${randomUUID().slice(0, 8)}`;
    const tip = await record(a, {
      direction: 'in',
      status: 'completed',
      category: 'earning',
      amountKobo: 200000,
      totalKobo: 200000,
      counterparty: {
        kind: 'wawu_user',
        name: 'Amaka Nwosu',
        wawuUserId: b.id,
        accountNumber: b.account,
      },
      link: {
        kind: 'tip',
        targetId: randomUUID(),
        title: 'How I light a night shoot',
      },
      note: 'loved the night shoot',
      ref: tipRef,
      occurredAt: new Date('2026-09-26T09:24:00.000Z'),
    });
    const sendRef = `W18-SEND-${randomUUID().slice(0, 8)}`;
    const send = await record(a, {
      direction: 'out',
      status: 'completed',
      category: 'transfer',
      amountKobo: 2500000,
      feeKobo: 6500,
      providerFeeKobo: 4000,
      wawuFeeKobo: 2500,
      totalKobo: 2506500,
      counterparty: {
        kind: 'bank_account',
        name: 'Chidinma Okoro',
        accountNumber: '0123456789',
        bankCode: '058',
        bankName: 'GTBank',
      },
      note: 'rent for October',
      ref: sendRef,
      occurredAt: new Date('2026-09-27T11:02:00.000Z'),
    });
    return { a, b, tip, tipRef, send, sendRef };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        ThrottlerModule.forRoot([...HUB_THROTTLERS]),
        PrismaModule,
        MoneyModule,
      ],
      providers: [
        WawuJwtStrategy,
        WawuIdClient,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
    app.useLogger(logger);
    applyHubHttpSettings(app);
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
    receipts = moduleRef.get(ReceiptService);
  });

  afterAll(async () => {
    await prisma.moneyReceipt.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { accountNumber: { in: accounts } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
  });

  describe('who can ask for a receipt', () => {
    it('without a token the three owner routes are 401', async () => {
      const ip = address();
      const id = randomUUID();
      await issue({ ip }, id).expect(401);
      await drawn({ ip }, id, 'image').expect(401);
      await drawn({ ip }, id, 'pdf').expect(401);
    });

    it('a person with no wallet gets wallet_not_open (R-6), never a 500', async () => {
      const u = newUser();
      const id = randomUUID();
      for (const res of [
        await issue(u, id).expect(409),
        await drawn(u, id, 'image').expect(409),
        await drawn(u, id, 'pdf').expect(409),
      ]) {
        const env = JSON.parse(
          Buffer.isBuffer(res.body)
            ? res.body.toString()
            : JSON.stringify(res.body),
        ) as Envelope<null>;
        expect(env.reason).toEqual({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
      }
    });

    it("someone else's transaction is the same 404 as no transaction, on all three routes, and makes no code", async () => {
      const { a, tip } = await scene();
      const stranger = await withWallet('Bayo Stranger');
      for (const id of [tip, randomUUID()]) {
        const r = await issue(stranger, id).expect(404);
        expect(body(r).reason).toEqual({
          code: 'not_found',
          message: HISTORY_NOT_FOUND_MESSAGE,
        });
        await drawn(stranger, id, 'image').expect(404);
        await drawn(stranger, id, 'pdf').expect(404);
      }
      expect(await prisma.moneyReceipt.count({ where: { entryId: tip } })).toBe(
        0,
      );
      void a;
    });

    it('an id that is not a UUID is 400', async () => {
      const p = await withWallet('Ada Lovelace');
      await issue(p, 'not-a-uuid').expect(400);
    });
  });

  describe('the owner', () => {
    it('gets the receipt W41 shows, with a 12-character code that is the same on every ask', async () => {
      const { a, tip, tipRef } = await scene();
      const first = body<ReceiptView>(await issue(a, tip).expect(200)).data!;
      expect(first.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
      expect(first.link).toBe(`wawu/r/${first.code}`);
      expect(first.url).toBeNull();
      expect(first.transaction.id).toBe(tip);
      expect(first.transaction.reference).toBe(tipRef);
      expect(first.headline).toBe('Tip from Amaka Nwosu');
      expect(first.typeLabel).toBe('Tip');
      expect(first.bankName).toBe('Loma Bank');
      expect(first.to).toEqual({
        name: 'Lennox Emmanuel Okafor',
        accountNumber: a.account,
        accountNumberLast4: null,
        bankName: null,
      });
      expect(first.lines.map((l) => l.label)).toEqual([
        'Type',
        'From',
        'To',
        'Bank',
        'Reference',
      ]);
      const again = body<ReceiptView>(await issue(a, tip).expect(200)).data!;
      expect(again.code).toBe(first.code);
      expect(again.issuedAt).toBe(first.issuedAt);
    });

    it('ten taps at once make one code', async () => {
      const { a, send } = await scene();
      const all = await Promise.all(
        Array.from({ length: 10 }, () => issue(a, send)),
      );
      const codes = new Set(
        all.map((r) =>
          r.status === 200
            ? body<ReceiptView>(r).data!.code
            : `status ${r.status}`,
        ),
      );
      expect([...codes]).toHaveLength(1);
      expect([...codes][0]).toMatch(/^[0-9A-Z]{12}$/);
      expect(
        await prisma.moneyReceipt.count({ where: { entryId: send } }),
      ).toBe(1);
    });

    it("a send's receipt shows what it cost (R-10) and the bank account only by its last 4 digits", async () => {
      const { a, send } = await scene();
      const v = body<ReceiptView>(await issue(a, send).expect(200)).data!;
      expect(v.headline).toBe('Transfer to Chidinma Okoro');
      expect(v.lines).toEqual([
        { label: 'Type', value: 'Transfer' },
        {
          label: 'From',
          value: `Lennox Emmanuel Okafor · ${a.account.slice(0, 3)} ${a.account.slice(3, 6)} ${a.account.slice(6)}`,
        },
        { label: 'To', value: 'Chidinma Okoro · GTBank •••• 6789' },
        { label: 'Bank', value: 'Loma Bank' },
        { label: 'Amount', value: '₦25,000.00' },
        { label: "Fintava's charge", value: '₦40.00' },
        { label: "WAWU's fee", value: '₦25.00' },
        { label: 'Total paid', value: '₦25,065.00' },
        { label: 'Reference', value: v.transaction.reference },
      ]);
      expect(JSON.stringify(v)).not.toContain('0123456789');
    });

    it('gets the receipt as a PNG and as a one-page A4 PDF, under the same code', async () => {
      const { a, tip } = await scene();
      const png = await drawn(a, tip, 'image').expect(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.headers['cache-control']).toBe('no-store');
      const pngBody = png.body as Buffer;
      expect(pngBody.subarray(1, 4).toString()).toBe('PNG');
      expect(pngBody.readUInt32BE(16)).toBe(1080);
      const code = (await prisma.moneyReceipt.findUnique({
        where: { entryId: tip },
      }))!.code;
      expect(png.headers['content-disposition']).toBe(
        `inline; filename="Receipt-${code}.png"`,
      );

      const pdf = await drawn(a, tip, 'pdf').expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      const text = (pdf.body as Buffer).toString('latin1');
      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
      expect(text.match(/\/Type \/Page /g)).toHaveLength(1);
      expect(pdf.headers['content-disposition']).toBe(
        `inline; filename="Receipt-${code}.pdf"`,
      );
      expect(await prisma.moneyReceipt.count({ where: { entryId: tip } })).toBe(
        1,
      );
    });
  });

  describe('the public check, wawu/r/<code>', () => {
    it("a receipt's code opens a page that matches the transaction: amount, date, status, masked sides, reference", async () => {
      const { a, b, tip, tipRef } = await scene();
      const { code } = body<ReceiptView>(await issue(a, tip).expect(200)).data!;
      const res = await page(code).expect(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      const html = res.text;
      expect(html).toContain('+₦2,000.00');
      expect(html).toContain('Completed');
      expect(html).toContain('26 Sep 2026, 10:24');
      expect(html).toContain(tipRef);
      expect(html).toContain('Amaka N.');
      expect(html).toContain('Lennox E. O.');
      expect(html).toContain(`Loma Bank •••• ${a.account.slice(-4)}`);
      expect(html).toContain(`wawu/r/${code}`);
      // Never a full account number, a full name, a handle, an email, a phone, a note or what it paid for.
      const handle = (await prisma.userProfile.findUnique({
        where: { wawuUserId: b.id },
      }))!.handle!;
      for (const secret of [
        a.account,
        b.account,
        'Emmanuel',
        'Okafor',
        'Nwosu',
        handle,
        '@',
        'night shoot',
        '+234',
        a.id,
        b.id,
        tip,
      ])
        expect(html).not.toContain(secret);
      expect(html).not.toMatch(/<script/i);
    });

    it('opens however the code is typed: lower case, with hyphens or spaces', async () => {
      const { a, send } = await scene();
      const { code } = body<ReceiptView>(
        await issue(a, send).expect(200),
      ).data!;
      const typed =
        `${code.slice(0, 4)}-${code.slice(4, 8)} ${code.slice(8)}`.toLowerCase();
      const res = await page(typed).expect(200);
      expect(res.text).toContain('₦25,000.00');
      expect(res.text).toContain('Chidinma O.');
      expect(res.text).toContain('GTBank •••• 6789');
      expect(res.text).not.toContain('0123456789');
      expect(res.text).not.toContain('rent for October');
    });

    it("a made-up code shows 'not found', never someone else's receipt: every miss is the same page and the same headers", async () => {
      const { a, tip } = await scene();
      await issue(a, tip).expect(200);
      const misses = [
        newReceiptCode(),
        newReceiptCode(),
        'T1P9',
        'x'.repeat(300),
        '%27%20OR%201%3D1',
        '00000000000-',
      ];
      const answers = await Promise.all(misses.map((c) => page(c)));
      for (const r of answers) {
        expect(r.status).toBe(404);
        expect(r.text).toBe(RECEIPT_NOT_FOUND_PAGE);
        expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(r.headers['content-length']).toBe(
          answers[0].headers['content-length'],
        );
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.text).not.toContain('₦');
      }
    });

    it('every miss costs the same one lookup, a code that cannot be one included', async () => {
      const receipts = jest.spyOn(prisma.moneyReceipt, 'findUnique');
      const wallets = jest.spyOn(prisma.fintavaWallet, 'findUnique');
      try {
        for (const c of [newReceiptCode(), 'T1P9', 'not a code at all']) {
          receipts.mockClear();
          wallets.mockClear();
          await page(c).expect(404);
          expect(receipts).toHaveBeenCalledTimes(1);
          expect(wallets).not.toHaveBeenCalled();
        }
      } finally {
        receipts.mockRestore();
        wallets.mockRestore();
      }
    });

    it('shows the status as it stands now: a reversal Fintava reported shows as Reversed', async () => {
      const { a, send } = await scene();
      const { code } = body<ReceiptView>(
        await issue(a, send).expect(200),
      ).data!;
      expect((await page(code).expect(200)).text).toContain('Completed');
      await prisma.fintavaLedgerEntry.update({
        where: { id: send },
        data: { status: 'reversed' },
      });
      const now = (await page(code).expect(200)).text;
      expect(now).toContain('Reversed');
      expect(now).not.toContain('Completed');
    });

    it("a receipt whose wallet is no longer its owner's is the plain miss", async () => {
      const { a, tip } = await scene();
      const { code } = body<ReceiptView>(await issue(a, tip).expect(200)).data!;
      await prisma.moneyReceipt.update({
        where: { code },
        data: { accountNumber: nuban() },
      });
      const r = await page(code).expect(404);
      expect(r.text).toBe(RECEIPT_NOT_FOUND_PAGE);
    });

    it('a biller name with a spaced or +234 phone number shows only its last 4 digits (round 2)', async () => {
      const p = await withWallet('Ada Obi');
      const forms = [
        'MTN Airtime 0803 123 4567',
        'Glo +234 805-123-4567',
        'IKEDC 4501.2345.6789',
      ];
      for (const name of forms) {
        const id = await record(p, {
          direction: 'out',
          status: 'completed',
          category: 'bill',
          amountKobo: 100000,
          totalKobo: 100000,
          counterparty: { kind: 'biller', name },
        });
        const { code } = body<ReceiptView>(
          await issue(p, id).expect(200),
        ).data!;
        const html = (await page(code).expect(200)).text;
        const digits = name.replace(/\D/g, '');
        expect(html).toContain(`•••• ${digits.slice(-4)}`);
        for (let i = 0; i + 5 <= digits.length; i += 1) {
          const window = digits.slice(i, i + 5);
          expect({
            name,
            window,
            shown: html.replace(/\D/g, ' ').includes(window),
          }).toEqual({ name, window, shown: false });
        }
        expect(html).not.toContain(name.split(' ').slice(1).join(' '));
      }
    });

    it('a name with characters XML forbids still draws as an image and a PDF, never a 500 (round 2)', async () => {
      const p = await withWallet('Ada Obi');
      const id = await record(p, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        totalKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'Bad\u0001Name\u0008X \uFFFE & <Sons>',
          accountNumber: '1234567890',
          bankName: 'Opay\u0002',
        },
      });
      const png = await drawn(p, id, 'image').expect(200);
      expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
      const pdf = await drawn(p, id, 'pdf').expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const { code } = body<ReceiptView>(await issue(p, id).expect(200)).data!;
      const html = (await page(code).expect(200)).text;
      expect(html).toContain('BadNameX');
      // eslint-disable-next-line no-control-regex
      expect(html).not.toMatch(/[\u0000-\u0008\uFFFE]/);
    });

    it('every number form the round-2 verifier listed shows at most its last 4 digits on the public page (round 3)', async () => {
      const p = await withWallet('Ada Obi');
      const dd = (html: string, row: string) =>
        new RegExp(`<dt>${row}</dt><dd>(.*?)</dd>`)
          .exec(html)?.[1]
          .replace(/<[^>]+>/g, ' ') ?? '';
      const rows: { name: string; cp: Move['counterparty'] }[] = [
        ...D3_FORMS.filter(
          ([n]) => n.startsWith('MTN') || n.startsWith('Shop'),
        ).map(([name]) => ({
          name,
          cp: { kind: 'biller' as const, name, accountNumber: '08031234567' },
        })),
        ...D3_FORMS.filter(([n]) => n.startsWith('GTBank')).map(([name]) => ({
          name,
          cp: {
            kind: 'bank_account' as const,
            name: 'Chidinma Okoro',
            bankName: name,
            accountNumber: '1234567890',
          },
        })),
        ...[
          '０８０３１２３４５６７ John Doe',
          '0803-123-4567 John',
          '0803_123_4567 John',
        ].map((name) => ({
          name,
          cp: {
            kind: 'bank_account' as const,
            name,
            bankName: 'Opay',
            accountNumber: '1234567890',
          },
        })),
      ];
      for (const r of rows) {
        const id = await record(p, {
          direction: 'out',
          status: 'completed',
          category: r.cp?.kind === 'biller' ? 'bill' : 'transfer',
          amountKobo: 123456,
          totalKobo: 123456,
          counterparty: r.cp,
        });
        const { code } = body<ReceiptView>(
          await issue({ ...p, ip: address() }, id).expect(200),
        ).data!;
        const html = (await page(code).expect(200)).text;
        const shown = Math.max(
          visibleDigits(dd(html, 'From')),
          visibleDigits(dd(html, 'To')),
        );
        expect({ name: r.name, visible: shown <= 4 }).toEqual({
          name: r.name,
          visible: true,
        });
        expect(html).toContain('₦1,234.56');
      }
    });

    it('a name with a stack of combining marks draws as an image and a PDF, with at most 2 marks a letter on the page (round 3)', async () => {
      const p = await withWallet('Ada Obi');
      const id = await record(p, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        totalKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'A' + '\u0301\u0302\u0303\u0304\u0308'.repeat(99),
          accountNumber: '1234567890',
          bankName: 'B' + '\u0335'.repeat(499),
        },
      });
      await drawn(p, id, 'image').expect(200);
      await drawn(p, id, 'pdf').expect(200);
      const { code } = body<ReceiptView>(await issue(p, id).expect(200)).data!;
      const html = (await page(code).expect(200)).text;
      expect(html).not.toMatch(/\p{M}{3}/u);
    });

    it('at most 2 receipts draw at once, whoever asks; the rest wait their turn (round 3)', async () => {
      const p = await withWallet('Ada Obi');
      const id = await record(p, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        totalKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'Bayo Ade',
          accountNumber: '1234567890',
          bankName: 'Opay',
        },
      });
      receipts.drawing.peak = 0;
      const answers = await Promise.all([
        ...Array.from({ length: 4 }, () => drawn(p, id, 'pdf')),
        ...Array.from({ length: 4 }, () => drawn(p, id, 'image')),
      ]);
      expect(answers.map((a) => a.status)).toEqual(Array(8).fill(200));
      expect(receipts.drawing.slots).toBe(2);
      expect(receipts.drawing.peak).toBe(2);
      expect(receipts.drawing.inFlight).toBe(0);
    });

    it('when no drawing slot comes free in time the answer is 503 with Retry-After and a sentence, and the slot is not lost (round 4)', async () => {
      const p = await withWallet('Ada Obi');
      const id = await record(p, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        totalKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'Bayo Ade',
          accountNumber: '1234567890',
          bankName: 'Opay',
        },
      });
      const held = receipts as unknown as { drawing: DrawLimiter };
      const real = held.drawing;
      held.drawing = new DrawLimiter(1, 100);
      let release!: () => void;
      const busy = held.drawing.run(
        () => new Promise<void>((r) => (release = r)),
      );
      try {
        for (const kind of ['image', 'pdf'] as const) {
          const res = await drawn(p, id, kind).expect(503);
          expect(res.headers['retry-after']).toBe('5');
          const env = JSON.parse(
            (res.body as Buffer).toString(),
          ) as Envelope<null>;
          expect(env.message).toBe(RECEIPT_BUSY_MESSAGE);
          expect(env.data).toBeNull();
        }
      } finally {
        release();
        await busy;
        held.drawing = real;
      }
      const ok = await drawn(p, id, 'image').expect(200);
      expect(ok.headers['retry-after']).toBeUndefined();
    });

    it('is throttled per address: 10 a minute, the 11th is 429, and another address is unaffected', async () => {
      const ip = address();
      const codes = Array.from({ length: 11 }, () => newReceiptCode());
      const statuses: number[] = [];
      for (const c of codes) statuses.push((await page(c, ip)).status);
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
      expect(statuses[10]).toBe(429);
      expect((await page(newReceiptCode(), address())).status).toBe(404);
    });
  });
});

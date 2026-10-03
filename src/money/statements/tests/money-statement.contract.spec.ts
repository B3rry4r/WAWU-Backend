import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
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
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import {
  NO_WALLET_MESSAGE,
  WALLET_OPENING_MESSAGE,
} from '../../gate/wallet-gate';
import type { LedgerMovementInput } from '../../ledger/ledger.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { HUB_THROTTLERS } from '../../../hub-throttlers';
import { MoneyModule } from '../../money.module';
import type {
  MonthlySummaryView,
  TransactionPage,
  TransactionView,
} from '../../money-view.type';
import { lagosToday } from '../statement-csv';
import type { StatementView } from '../statement-view.type';
import { STATEMENT_MAX_ROWS, statementTracker } from '../statement-config';
import {
  STATEMENT_TOO_LARGE_MESSAGE,
  STATEMENT_FUTURE_MESSAGE,
  STATEMENT_NOT_A_DAY_MESSAGE,
  STATEMENT_ORDER_MESSAGE,
  STATEMENT_TOO_LONG_MESSAGE,
} from '../statement.service';

/**
 * Statements over HTTP (task WALLET-27): the real MoneyModule, a real
 * database, real RS256 tokens checked against the stand-in WAWU ID's JWKS
 * (WAWU_ID_JWKS_URL), and rows written by the ledger's own writer
 * (LedgerService.record and applyReversal), so what a statement lists is
 * what the ledger stores. Every person is a brand-new wawuUserId with a
 * brand-new wallet; afterAll deletes their rows.
 *
 * The CSV is read back by the small RFC 4180 reader below, written apart
 * from the code under test.
 */

const BASE = '/api/hub/money/statements';
const HISTORY = '/api/hub/money/transactions';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `statement-${sub}@test.wawu.dev`,
      phone: '+2348000009996',
      firstName: 'Statement',
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

/** RFC 4180, read independently of the writer: quoted cells, doubled quotes, CRLF. */
function readCsv(text: string): string[][] {
  expect(text.startsWith('﻿')).toBe(true);
  const s = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += c;
    }
  }
  expect({ leftover: cell, row }).toEqual({ leftover: '', row: [] });
  return rows;
}

type Line = {
  date: string;
  time: string;
  description: string;
  counterparty: string;
  reference: string;
  note: string;
  moneyIn: string;
  moneyOut: string;
  fees: string;
};

const HEADER = [
  'Date',
  'Time',
  'Description',
  'Counterparty',
  'Reference',
  'Note',
  'Money in (₦)',
  'Money out (₦)',
  'Of which fees (₦)',
];

function linesOf(v: StatementView): Line[] {
  const [header, ...rows] = readCsv(v.content);
  expect(header).toEqual(HEADER);
  expect(rows).toHaveLength(v.rowCount);
  return rows.map((r) => {
    expect(r).toHaveLength(9);
    const [
      date,
      time,
      description,
      counterparty,
      reference,
      note,
      moneyIn,
      moneyOut,
      fees,
    ] = r;
    return {
      date,
      time,
      description,
      counterparty,
      reference,
      note,
      moneyIn,
      moneyOut,
      fees,
    };
  });
}

/** A text cell as the person wrote it: the quote mark put before a formula character taken off. */
const plain = (cell: string) => cell.replace(/^'(?=[=+\-@\t\r])/, '');

/** Naira text back to kobo, without a float. */
function kobo(naira: string): number {
  if (naira === '') return 0;
  const m = /^([0-9]+)\.([0-9]{2})$/.exec(naira);
  expect(m).not.toBeNull();
  return Number(m![1]) * 100 + Number(m![2]);
}

/** Midnight at the start of a Lagos day (Africa/Lagos is UTC+1, no summer time). */
const lagosMidnight = (day: string) => new Date(`${day}T00:00:00.000+01:00`);
const at = (iso: string) => new Date(iso);

let accountSeq = 0;
function nuban(): string {
  accountSeq += 1;
  return `8${String(Date.now()).slice(-6)}${String(accountSeq).padStart(3, '0')}`;
}

describe('GET /money/statements (WALLET-27) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  const users: string[] = [];
  const accounts: string[] = [];

  type Person = { id: string; auth: string };
  type Holder = Person & { account: string };

  function newUser(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}` };
  }

  async function withWallet(
    accountName: string | null = null,
  ): Promise<Holder> {
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

  /** One side of one movement on this person's wallet, through the ledger's writer. Returns our reference. */
  async function record(p: Holder, m: Move): Promise<string> {
    const { ref, ...rest } = m;
    const reference = ref ?? `W27-${randomUUID()}`;
    await ledger.record({
      ...rest,
      wallet: { kind: 'user', wawuUserId: p.id, accountNumber: p.account },
      references: { customerReference: reference },
      source: 'send',
    });
    return reference;
  }

  function get(auth: string | undefined, path: string) {
    const req = request(app.getHttpServer()).get(path);
    return auth ? req.set('Authorization', auth) : req;
  }

  async function statement(
    p: Person,
    from: string,
    to: string,
  ): Promise<StatementView> {
    const res = await get(
      p.auth,
      `${BASE}?from=${from}&to=${to}&format=csv`,
    ).expect(200);
    return body<StatementView>(res).data!;
  }

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { accountNumber: { in: accounts } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWalletOpening.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
  });

  describe('who can get a statement', () => {
    const SEPT = `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`;

    it('without a token: 401', async () => {
      await get(undefined, SEPT).expect(401);
    });

    it('no wallet yet: 409 wallet_not_open, before the query is even checked (R-6)', async () => {
      const u = newUser();
      for (const path of [SEPT, BASE, `${BASE}?from=nonsense`]) {
        const res = await get(u.auth, path).expect(409);
        expect(body(res).reason).toEqual({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
        expect(body(res).data).toBeNull();
      }
    });

    it('a wallet being opened: 409 wallet_opening', async () => {
      const u = newUser();
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: u.id,
          state: 'opening',
          bvnHash: `w27-${u.id}`,
          bvnVerifiedAt: new Date(),
          phone: `+23481${String(Date.now()).slice(-8)}`,
        },
      });
      const res = await get(u.auth, SEPT).expect(409);
      expect(body(res).reason).toEqual({
        code: 'wallet_opening',
        message: WALLET_OPENING_MESSAGE,
      });
    });

    it('only the caller’s own wallet: never another person’s rows, a row on another account, or WAWU’s merchant wallet', async () => {
      const a = await withWallet();
      const b = await withWallet();
      const when = at('2026-09-10T09:00:00.000Z');
      const mine = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        occurredAt: when,
      });
      const theirs = await record(b, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 2000,
        occurredAt: when,
      });
      // Each breaks exactly one of the three keys: b's id on a's account,
      // a's id on another account, a merchant row naming a.
      const other = nuban();
      accounts.push(other);
      for (const wallet of [
        { kind: 'user' as const, wawuUserId: b.id, accountNumber: a.account },
        { kind: 'user' as const, wawuUserId: a.id, accountNumber: other },
        { kind: 'merchant' as const, accountNumber: a.account },
      ]) {
        await ledger.record({
          wallet,
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 3000,
          references: { customerReference: `W27-X-${randomUUID()}` },
          source: 'send',
          occurredAt: when,
        });
      }
      await prisma.fintavaLedgerEntry.create({
        data: {
          walletKind: 'merchant',
          wawuUserId: a.id,
          accountNumber: a.account,
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 4000n,
          totalKobo: 4000n,
          customerReference: `W27-M-${randomUUID()}`,
          source: 'send',
          occurredAt: when,
        },
      });
      const sa = linesOf(await statement(a, '2026-09-01', '2026-09-30'));
      expect(sa.map((l) => [l.reference, l.moneyIn])).toEqual([
        [mine, '10.00'],
      ]);
      const sb = linesOf(await statement(b, '2026-09-01', '2026-09-30'));
      expect(sb.map((l) => [l.reference, l.moneyIn])).toEqual([
        [theirs, '20.00'],
      ]);
    });

    it('no request can name someone else: a person or wallet in the query is a 400, and nothing is read', async () => {
      const a = await withWallet();
      const b = await withWallet();
      await record(b, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        occurredAt: at('2026-09-10T09:00:00.000Z'),
      });
      for (const extra of [
        `wawuUserId=${b.id}`,
        `accountNumber=${b.account}`,
        `walletId=${randomUUID()}`,
        `userId=${b.id}`,
      ]) {
        const res = await get(a.auth, `${SEPT}&${extra}`).expect(400);
        expect(JSON.stringify(res.body)).not.toContain('W27-');
      }
    });
  });

  describe('capability: a statement for last month lists exactly last month’s transactions', () => {
    it('every completed movement from 00:00 on the 1st to the end of the last day, Lagos time, and nothing else', async () => {
      // Last month as the calendar in Lagos has it today.
      const [ty, tm] = lagosToday(new Date()).split('-').map(Number);
      const y = tm === 1 ? ty - 1 : ty;
      const m = tm === 1 ? 12 : tm - 1;
      const mm = String(m).padStart(2, '0');
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const first = `${y}-${mm}-01`;
      const last = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`;
      const startMs = lagosMidnight(first).getTime();
      const endMs = lagosMidnight(last).getTime() + 86_400_000; // exclusive
      const a = await withWallet();
      const b = await withWallet();

      const inMonth: Array<{ ref: string; ms: number }> = [];
      const add = async (ms: number, m: Omit<Move, 'occurredAt'>) => {
        const ref = await record(a, { ...m, occurredAt: new Date(ms) });
        return ref;
      };
      // The first and last instants of the month in Lagos, and between.
      for (const [ms, dir, amt] of [
        [startMs, 'in', 100_000],
        [startMs + 3_600_000 * 30, 'out', 25_000],
        [endMs - 86_400_000 + 3_600_000 * 23.5, 'in', 7_500], // 23:30 UTC-ish
        [endMs - 1, 'out', 1_234],
      ] as const) {
        inMonth.push({
          ms,
          ref: await add(ms, {
            direction: dir,
            status: 'completed',
            category: 'transfer',
            amountKobo: amt,
            feeKobo: dir === 'out' ? 4_000 : 0,
          }),
        });
      }
      // Just outside, either side.
      const before = await add(startMs - 1, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 900,
      });
      const after = await add(endMs, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 800,
      });
      // In the month, but not money that moved: pending, failed, reversed.
      await add(startMs + 86_400_000 * 3, {
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 50_000,
      });
      await add(startMs + 86_400_000 * 4, {
        direction: 'out',
        status: 'failed',
        category: 'transfer',
        amountKobo: 60_000,
      });
      const reversedRef = await add(startMs + 86_400_000 * 5, {
        direction: 'out',
        status: 'failed',
        category: 'transfer',
        amountKobo: 70_000,
        feeKobo: 4_000,
      });
      const rev = await ledger.applyReversal({
        references: [reversedRef],
        reversalReference: `REV-${reversedRef}`,
        amountKobo: 70_000,
        chargesKobo: 4_000,
        totalKobo: 74_000,
        at: new Date(startMs + 86_400_000 * 5 + 60_000),
      });
      expect(rev.state).toBe('applied');
      // Someone else's movement in the same month.
      await record(b, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 999_999,
        occurredAt: new Date(startMs + 86_400_000),
      });

      const v = await statement(a, first, last);
      const lines = linesOf(v);
      // Exactly the month's completed movements, oldest first.
      expect(lines.map((l) => l.reference)).toEqual(inMonth.map((x) => x.ref));
      expect(lines.map((l) => l.reference)).not.toContain(before);
      expect(lines.map((l) => l.reference)).not.toContain(after);
      expect(lines.map((l) => l.reference)).not.toContain(reversedRef);
      expect(lines[0]).toMatchObject({ date: first, time: '00:00' });
      expect(lines[lines.length - 1]).toMatchObject({
        date: last,
        time: '23:59',
      });
      for (const l of lines) {
        expect(l.date >= first && l.date <= last).toBe(true);
      }
      expect(v).toMatchObject({
        from: first,
        to: last,
        timeZone: 'Africa/Lagos',
        format: 'csv',
        rowCount: 4,
        fileName: `statement-${first}-to-${last}.csv`,
        contentType: 'text/csv; charset=utf-8',
      });

      // The month's lines add up to W26's In and Out for that month.
      const summary = body<MonthlySummaryView>(
        await get(a.auth, `${HISTORY}/summary?month=${y}-${mm}`).expect(200),
      ).data!;
      const sum = (k: 'moneyIn' | 'moneyOut') =>
        lines.reduce((s, l) => s + kobo(l[k]), 0);
      expect({ inKobo: sum('moneyIn'), outKobo: sum('moneyOut') }).toEqual({
        inKobo: summary.inKobo,
        outKobo: summary.outKobo,
      });
      expect(summary.inKobo).toBe(107_500);
      expect(summary.outKobo).toBe(25_000 + 4_000 + 1_234 + 4_000);
    });
  });

  describe('the period: both days included, in Africa/Lagos time', () => {
    let a: Holder;
    const refs: Record<string, string> = {};

    beforeAll(async () => {
      a = await withWallet();
      // Each instant's Lagos day is in its name.
      const instants: Record<string, string> = {
        aug30Late: '2026-08-30T22:59:59.999Z', // 30 Aug 23:59:59.999 Lagos
        aug31First: '2026-08-30T23:00:00.000Z', // 31 Aug 00:00 Lagos
        aug31Last: '2026-08-31T22:59:59.999Z', // 31 Aug 23:59:59.999 Lagos
        sep1First: '2026-08-31T23:00:00.000Z', // 1 Sep 00:00 Lagos
        sep1UtcAug31: '2026-08-31T23:30:00.000Z', // 31 Aug in UTC, 1 Sep in Lagos
        sep15: '2026-09-15T12:00:00.000Z',
        sep30Last: '2026-09-30T22:59:59.999Z', // 30 Sep 23:59:59.999 Lagos
        oct1UtcSep30: '2026-09-30T23:30:00.000Z', // 30 Sep in UTC, 1 Oct in Lagos
        oct1Last: '2026-10-01T22:59:59.999Z',
        oct2First: '2026-10-01T23:00:00.000Z',
      };
      for (const [name, iso] of Object.entries(instants)) {
        refs[name] = await record(a, {
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 100,
          occurredAt: at(iso),
          ref: `W27-${name}-${randomUUID()}`,
        });
      }
    });

    const listed = async (from: string, to: string) =>
      linesOf(await statement(a, from, to)).map(
        (l) =>
          Object.entries(refs).find(([, r]) => r === l.reference)?.[0] ?? '?',
      );

    it('a month: 00:00 on the 1st to 23:59:59.999 on the 30th, Lagos', async () => {
      expect(await listed('2026-09-01', '2026-09-30')).toEqual([
        'sep1First',
        'sep1UtcAug31',
        'sep15',
        'sep30Last',
      ]);
    });

    it('a range across the month boundary holds both sides of it', async () => {
      expect(await listed('2026-08-31', '2026-09-01')).toEqual([
        'aug31First',
        'aug31Last',
        'sep1First',
        'sep1UtcAug31',
      ]);
      expect(await listed('2026-09-30', '2026-10-01')).toEqual([
        'sep30Last',
        'oct1UtcSep30',
        'oct1Last',
      ]);
    });

    it('one day: from equal to to is that whole Lagos day', async () => {
      expect(await listed('2026-08-31', '2026-08-31')).toEqual([
        'aug31First',
        'aug31Last',
      ]);
      expect(await listed('2026-10-01', '2026-10-01')).toEqual([
        'oct1UtcSep30',
        'oct1Last',
      ]);
    });

    it('each line’s date and time are Lagos time', async () => {
      const lines = linesOf(await statement(a, '2026-08-31', '2026-09-01'));
      expect(lines.map((l) => `${l.date} ${l.time}`)).toEqual([
        '2026-08-31 00:00',
        '2026-08-31 23:59',
        '2026-09-01 00:00',
        '2026-09-01 00:30',
      ]);
    });

    it('a period with nothing in it is the header alone', async () => {
      const v = await statement(a, '2026-07-01', '2026-07-31');
      expect(v.rowCount).toBe(0);
      expect(readCsv(v.content)).toEqual([HEADER]);
    });
  });

  describe('each line says what the history says', () => {
    it('the same description, other side and reference as W26 and W27; unlocks one per line; fees as the receipt shows them', async () => {
      const a = await withWallet();
      const ada = randomUUID();
      users.push(ada);
      const handle = `adaw27${String(Date.now()).slice(-6)}`;
      await prisma.userProfile.create({
        data: { wawuUserId: ada, accountType: 'creator', handle },
      });
      const piece = randomUUID();
      const day = '2026-09-20T';
      const moves: Move[] = [
        // Three unlocks of one piece on one day: one grouped row on W26.
        ...[9, 10, 11].map((h): Move => ({
          direction: 'in',
          status: 'completed',
          category: 'earning',
          amountKobo: 250_000,
          link: {
            kind: 'content_unlock',
            targetId: piece,
            title: 'Lighting night shoots',
          },
          counterparty: { kind: 'wawu_user', name: null, wawuUserId: ada },
          occurredAt: at(`${day}${String(h).padStart(2, '0')}:00:00.000Z`),
        })),
        // A bank send with the fee split the sender quoted (R-10).
        {
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 2_500_000,
          feeKobo: 6_500,
          providerFeeKobo: 4_000,
          wawuFeeKobo: 2_500,
          counterparty: {
            kind: 'bank_account',
            name: 'Okoro, Chidinma "Chi"',
            accountNumber: '0123456789',
            bankCode: '058',
            bankName: 'GTBank',
          },
          note: '=1+1 rent\nSeptember',
          occurredAt: at(`${day}12:00:00.000Z`),
        },
        // A bill, named by the biller fallback.
        {
          direction: 'out',
          status: 'completed',
          category: 'bill',
          amountKobo: 500_000,
          feeKobo: 10_000,
          counterparty: { kind: 'biller', name: null },
          occurredAt: at(`${day}13:00:00.000Z`),
        },
      ];
      for (const m of moves) await record(a, m);

      const lines = linesOf(await statement(a, '2026-09-20', '2026-09-20'));
      expect(lines).toHaveLength(5);

      // Unlocks: one line each, though the history groups them. The history
      // groups only unlocks completed a few seconds before it is read
      // (MONEY-15, LEDGER_WRITE_MAX_MS), so these are aged a minute first.
      await prisma.$executeRaw`
        UPDATE "FintavaLedgerEntry"
           SET "completedAt" = "completedAt" - interval '60 seconds'
         WHERE "accountNumber" = ${a.account} AND "completedAt" IS NOT NULL`;
      const hist = body<TransactionPage>(
        await get(a.auth, `${HISTORY}?month=2026-09&limit=50`).expect(200),
      ).data!.items;
      const grouped = hist.find((i) => i.group !== null);
      expect(grouped?.group?.count).toBe(3);
      expect(lines.slice(0, 3).map((l) => l.description)).toEqual([
        'Unlock · Lighting night shoots',
        'Unlock · Lighting night shoots',
        'Unlock · Lighting night shoots',
      ]);
      // A handle starts with @, which a spreadsheet would run: written with
      // a quote mark first.
      expect(lines.slice(0, 3).map((l) => l.counterparty)).toEqual([
        `'@${handle}`,
        `'@${handle}`,
        `'@${handle}`,
      ]);

      // Every line equals its own receipt (W27) on the words and the money.
      for (const l of lines) {
        const one = await prisma.fintavaLedgerEntry.findFirstOrThrow({
          where: { accountNumber: a.account, customerReference: l.reference },
          select: { id: true },
        });
        const t = body<TransactionView>(
          await get(a.auth, `${HISTORY}/${one.id}`).expect(200),
        ).data!;
        expect({
          description: plain(l.description),
          counterparty: plain(l.counterparty),
          reference: plain(l.reference),
          note: plain(l.note),
          inKobo: kobo(l.moneyIn),
          outKobo: kobo(l.moneyOut),
          feeKobo: kobo(l.fees),
        }).toEqual({
          description: t.description,
          counterparty: t.counterparty?.name ?? '',
          reference: t.reference,
          note: t.note ?? '',
          inKobo: t.direction === 'in' ? t.totalKobo : 0,
          outKobo: t.direction === 'out' ? t.totalKobo : 0,
          feeKobo: t.direction === 'out' ? t.fee.totalFeeKobo : 0,
        });
      }

      const send = lines[3];
      expect(send).toMatchObject({
        description: 'Transfer · GTBank',
        counterparty: 'Okoro, Chidinma "Chi"',
        note: "'=1+1 rent\nSeptember",
        moneyIn: '',
        moneyOut: '25065.00',
        fees: '65.00',
      });
      expect(lines[4]).toMatchObject({
        description: 'Bill',
        counterparty: 'Biller',
        moneyOut: '5100.00',
        fees: '100.00',
      });
      // Only the last four of a bank account ever reach the history; the
      // statement shows none of it.
      expect(JSON.stringify(lines)).not.toContain('0123456789');
    });
  });

  describe('refusals: 400, in the one error shape', () => {
    it('a day written another way, a day that does not exist, the wrong order, the future, too long, another format', async () => {
      const a = await withWallet();
      const today = lagosToday(new Date());
      const [ty, tm, td] = today.split('-').map(Number);
      const tomorrow = new Date(Date.UTC(ty, tm - 1, td + 1))
        .toISOString()
        .slice(0, 10);
      const yearAgo = (back: number) =>
        new Date(Date.UTC(ty, tm - 1, td - back)).toISOString().slice(0, 10);
      const cases: Array<[string, string | RegExp]> = [
        [
          'from=2026-9-1&to=2026-09-30&format=csv',
          'from must look like 2026-09-01',
        ],
        [
          'from=01/09/2026&to=2026-09-30&format=csv',
          'from must look like 2026-09-01',
        ],
        [
          'from=2026-09-01T00:00:00Z&to=2026-09-30&format=csv',
          'from must look like 2026-09-01',
        ],
        [
          'from=2026-09-01&to=30-09-2026&format=csv',
          'to must look like 2026-09-30',
        ],
        ['from=2026-09-01&to=&format=csv', 'to must look like 2026-09-30'],
        ['to=2026-09-30&format=csv', 'from must look like 2026-09-01'],
        [
          'from=2026-02-30&to=2026-03-01&format=csv',
          STATEMENT_NOT_A_DAY_MESSAGE('from'),
        ],
        [
          'from=2026-02-01&to=2026-02-29&format=csv',
          STATEMENT_NOT_A_DAY_MESSAGE('to'),
        ],
        [
          'from=0000-01-01&to=0000-01-02&format=csv',
          STATEMENT_NOT_A_DAY_MESSAGE('from'),
        ],
        ['from=2026-09-30&to=2026-09-01&format=csv', STATEMENT_ORDER_MESSAGE],
        [`from=${today}&to=${tomorrow}&format=csv`, STATEMENT_FUTURE_MESSAGE],
        [
          `from=${yearAgo(366)}&to=${today}&format=csv`,
          STATEMENT_TOO_LONG_MESSAGE,
        ],
        ['from=2026-09-01&to=2026-09-30&format=pdf', /format must be one of/],
        ['from=2026-09-01&to=2026-09-30', /format must be one of/],
        ['from=2026-09-01&to=2026-09-30&format=CSV', /format must be one of/],
      ];
      for (const [q, message] of cases) {
        const res = await get(a.auth, `${BASE}?${q}`);
        const b = body(res);
        const text = Array.isArray(b.message)
          ? b.message.join(' | ')
          : b.message;
        expect({ q, status: res.status, data: b.data }).toEqual({
          q,
          status: 400,
          data: null,
        });
        const says =
          typeof message === 'string'
            ? text.includes(message)
            : message.test(text);
        expect({ q, text, says }).toEqual({ q, text, says: true });
        expect(text).not.toContain('—');
      }
      // 366 days, both counted, is the longest allowed; today is allowed.
      await get(
        a.auth,
        `${BASE}?from=${yearAgo(365)}&to=${today}&format=csv`,
      ).expect(200);
    });
  });

  describe('the reference is ours whenever the row has it (as W27)', () => {
    it('a row carrying our reference and every one of Fintava’s shows ours; without ours, Fintava’s reference comes next', async () => {
      const a = await withWallet();
      const ours = `W27-OURS-${randomUUID()}`;
      const fintavas = `FTV-${randomUUID()}`;
      const when = at('2026-09-12T10:00:00.000Z');
      for (const references of [
        {
          customerReference: ours,
          fintavaReference: `FTV-${randomUUID()}`,
          sessionId: `SES-${randomUUID()}`,
          fintavaTransactionId: randomUUID(),
          tagapayTransRef: `TGP-${randomUUID()}`,
        },
        {
          fintavaReference: fintavas,
          sessionId: `SES-${randomUUID()}`,
          fintavaTransactionId: randomUUID(),
          tagapayTransRef: `TGP-${randomUUID()}`,
        },
      ]) {
        await ledger.record({
          wallet: { kind: 'user', wawuUserId: a.id, accountNumber: a.account },
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 1000,
          references,
          source: 'send',
          occurredAt: when,
        });
      }
      const lines = linesOf(await statement(a, '2026-09-12', '2026-09-12'));
      expect(lines.map((l) => l.reference).sort()).toEqual(
        [ours, fintavas].sort(),
      );
      // And each equals its receipt's.
      const hist = body<TransactionPage>(
        await get(a.auth, `${HISTORY}?month=2026-09`).expect(200),
      ).data!.items;
      expect(hist.map((i) => i.reference).sort()).toEqual(
        lines.map((l) => l.reference).sort(),
      );
    });
  });

  describe('a period with more rows than one statement lists', () => {
    /** `count` completed movements on this wallet in September, written in one statement. */
    async function bulk(p: Holder, count: number) {
      await prisma.$executeRaw`
        INSERT INTO "FintavaLedgerEntry"
          ("id", "walletKind", "wawuUserId", "accountNumber", "direction",
           "status", "category", "amountKobo", "feeKobo", "totalKobo",
           "customerReference", "source", "occurredAt", "completedAt", "updatedAt")
        SELECT gen_random_uuid()::text, 'user', ${p.id}, ${p.account}, 'in',
               'completed', 'transfer', 100, 0, 100,
               'W27-BULK-' || ${p.id} || '-' || g, 'send',
               timestamp '2026-09-01 00:00:00' + (g * interval '30 seconds'),
               now(), now()
          FROM generate_series(1, ${count}::int) g`;
    }

    it(`50,001 rows: 400 statement_too_large after one count, before any row is read; 50,000 rows: the file`, async () => {
      expect(STATEMENT_MAX_ROWS).toBe(50_000);
      const over = await withWallet();
      await bulk(over, STATEMENT_MAX_ROWS + 1);
      const spy = jest.spyOn(prisma, '$queryRaw');
      try {
        const res = await get(
          over.auth,
          `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`,
        ).expect(400);
        expect(body(res)).toEqual({
          statusCode: 400,
          message: STATEMENT_TOO_LARGE_MESSAGE,
          data: null,
          reason: {
            code: 'statement_too_large',
            message: STATEMENT_TOO_LARGE_MESSAGE,
          },
        });
        // Only the gate's reads and the count ran: no row was selected.
        const sql = spy.mock.calls.map((c) =>
          JSON.stringify((c[0] as { strings?: string[] }).strings ?? c[0]),
        );
        expect(sql.filter((q) => q.includes('COUNT(*)'))).toHaveLength(1);
        expect(sql.filter((q) => q.includes('"cpRecordedName"'))).toHaveLength(
          0,
        );
      } finally {
        spy.mockRestore();
      }
      expect(STATEMENT_TOO_LARGE_MESSAGE).toBe(
        'This period has more than 50,000 movements, more than one statement lists. Pick a shorter range.',
      );
      // A shorter range of the same wallet is served.
      const day = await statement(over, '2026-09-01', '2026-09-01');
      // 00:00:30 to 22:59:30 UTC on 1 Sep, every 30 s: 2,759 rows that day in Lagos.
      expect(day.rowCount).toBe(2_759);

      const full = await withWallet();
      await bulk(full, STATEMENT_MAX_ROWS);
      const v = await statement(full, '2026-09-01', '2026-09-30');
      expect(v.rowCount).toBe(STATEMENT_MAX_ROWS);
      expect(v.content.split('\r\n')).toHaveLength(STATEMENT_MAX_ROWS + 2);
    }, 60_000);
  });

  it('is never cached: Cache-Control no-store', async () => {
    const a = await withWallet();
    const res = await get(
      a.auth,
      `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`,
    ).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const v = body<StatementView>(res).data!;
    expect(Date.parse(v.generatedAt)).not.toBeNaN();
    expect(v.content).not.toMatch(/\$|USD/);
  });
});

/**
 * The statement route's own rate limit (WALLET-27 round 2) behind the
 * app's real throttlers (HUB_THROTTLERS) and the global ThrottlerGuard, as
 * AppModule registers them. People without a wallet are used: the
 * throttle runs before the wallet gate, so each allowed call is the gate's
 * 409 and the next one is the throttle's 429, with nothing to read.
 */
describe('GET /money/statements is rate-limited per person per address (WALLET-27)', () => {
  let app: INestApplication<App>;

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
  });

  afterAll(async () => {
    await app.close();
  });

  const SEPT = `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`;
  const as = (sub: string, path = SEPT) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${mintToken(sub)}`);

  it('5 a minute for one person: the 6th is 429; someone else at the same address, and the person’s other wallet routes, are not held back', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const first = await as(a).expect(409);
    expect(first.headers['x-ratelimit-limit-short']).toBe('5');
    expect(first.headers['x-ratelimit-limit-medium']).toBe('30');
    for (let i = 1; i < 5; i += 1) await as(a).expect(409);
    await as(a).expect(429);
    // Another person from the same address has a bucket of their own.
    await as(b).expect(409);
    // The history is not the statement: its own limits are untouched.
    await as(a, HISTORY).expect(409);
  });

  it('the bucket is the person at the address: a token’s id, never another person’s', () => {
    const req = (sub: string | null, ip: string) => ({
      ip,
      headers: sub ? { authorization: `Bearer ${mintToken(sub)}` } : {},
    });
    const a = randomUUID();
    expect(statementTracker(req(a, '198.51.100.7'))).toBe(`198.51.100.7|${a}`);
    expect(statementTracker(req(a, '198.51.100.8'))).not.toBe(
      statementTracker(req(a, '198.51.100.7')),
    );
    expect(statementTracker(req(randomUUID(), '198.51.100.7'))).not.toBe(
      statementTracker(req(a, '198.51.100.7')),
    );
    expect(statementTracker(req(null, '198.51.100.7'))).toBe('198.51.100.7|');
    expect(
      statementTracker({
        ip: '198.51.100.7',
        headers: { authorization: 'Bearer not.a-token' },
      }),
    ).toBe('198.51.100.7|');
  });
});

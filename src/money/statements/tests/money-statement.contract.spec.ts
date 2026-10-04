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
import { MoneyStatementController } from '../money-statement.controller';
import { lagosToday } from '../statement-csv';
import type { StatementView } from '../statement-view.type';
import {
  STATEMENT_BUSY_MESSAGE,
  STATEMENT_MAX_ROWS,
  STATEMENT_RATE_LIMITED_MESSAGE,
  StatementRateLimiter,
  StatementSlots,
} from '../statement-config';
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
    // These tests read many statements per person: the per-person limit is
    // proved on its own below, with its own app.
    jest
      .spyOn(moduleRef.get(StatementRateLimiter), 'take')
      .mockImplementation(() => () => undefined);
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
      // Rows that land between the count and the read (verifier finding 4):
      // the count is made to answer 50,000, the read still stops past the
      // cap and the answer is the same 400.
      const realQuery = prisma.$queryRaw.bind(prisma);
      const late = jest
        .spyOn(prisma, '$queryRaw')
        .mockImplementation(((
          ...args: Parameters<PrismaService['$queryRaw']>
        ) =>
          JSON.stringify(args[0]).includes('COUNT(*)')
            ? Promise.resolve([{ n: STATEMENT_MAX_ROWS }])
            : realQuery(...args)) as PrismaService['$queryRaw']);
      try {
        const raced = await get(
          over.auth,
          `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`,
        ).expect(400);
        expect(body(raced).reason?.code).toBe('statement_too_large');
      } finally {
        late.mockRestore();
      }
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

/** The app as the specs above build it; `throttled` adds AppModule's real global throttlers. */
async function buildApp(throttled: boolean) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      ...(throttled ? [ThrottlerModule.forRoot([...HUB_THROTTLERS])] : []),
      PrismaModule,
      MoneyModule,
    ],
    providers: [
      WawuJwtStrategy,
      WawuIdClient,
      ...(throttled ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: new QuietLogger(),
  });
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
  return { app, moduleRef, prisma: moduleRef.get(PrismaService) };
}

const SEPT = `${BASE}?from=2026-09-01&to=2026-09-30&format=csv`;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token the stand-in WAWU ID never signed: a known key id, any `sub`. */
const forged = (sub: string) =>
  `Bearer ${b64({ alg: 'RS256', typ: 'JWT', kid: 'mock-wawu-id-key-1' })}.${b64({ sub, exp: 9_999_999_999 })}.${Buffer.from('nope').toString('base64url')}`;

/** People with an open wallet and no rows, for the limit tests. */
function walletMaker(prismaOf: () => PrismaService) {
  const users: string[] = [];
  return {
    users,
    async make() {
      const id = randomUUID();
      users.push(id);
      await prismaOf().fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: randomUUID(),
          walletId: randomUUID(),
          accountNumber: nuban(),
        },
      });
      return { id, auth: `Bearer ${mintToken(id)}` };
    },
    async clean() {
      await prismaOf().fintavaLedgerEntry.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prismaOf().fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    },
  };
}

/**
 * WALLET-27 round 3 (verifier round 2, defect 1): the app's global
 * per-address throttlers apply to this route exactly as to every other;
 * the per-person limit is counted only after the token is verified.
 */
describe('statement limits behind the real global throttlers (WALLET-27)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let limiter: StatementRateLimiter;
  const people = walletMaker(() => prisma);

  beforeAll(async () => {
    const built = await buildApp(true);
    app = built.app;
    prisma = built.prisma;
    limiter = built.moduleRef.get(StatementRateLimiter);
  });

  afterAll(async () => {
    await people.clean();
    await app.close();
  });

  const call = (auth: string, path = SEPT) =>
    request(app.getHttpServer()).get(path).set('Authorization', auth);

  it('forged tokens with a new sub each, from one address: 401 until the per-address limit, then 429, as on any route; the limiter makes no entry', async () => {
    const before = limiter.size;
    const statuses = await Promise.all(
      Array.from({ length: 30 }, () =>
        call(forged(randomUUID())).then((r) => r.status),
      ),
    );
    const count = (s: number) => statuses.filter((x) => x === s).length;
    expect({ unauthorised: count(401), limited: count(429) }).toEqual({
      unauthorised: 20,
      limited: 10,
    });
    expect(limiter.size).toBe(before);
    // The route sets no throttler of its own: the global headers are the app's.
    await new Promise((r) => setTimeout(r, 1_100));
    const one = await call(forged(randomUUID()));
    expect(one.status).toBe(401);
    expect(one.headers['x-ratelimit-limit-short']).toBe('20');
    expect(one.headers['x-ratelimit-limit-medium']).toBe('200');
  });

  it('a verified person gets 5, then 429 statement_rate_limited; another verified person at the same address is not held back; a minute later the first may ask again', async () => {
    await new Promise((r) => setTimeout(r, 1_100));
    const a = await people.make();
    const b = await people.make();
    for (let i = 0; i < 5; i += 1) await call(a.auth).expect(200);
    const sixth = await call(a.auth).expect(429);
    expect(body(sixth)).toEqual({
      statusCode: 429,
      message: STATEMENT_RATE_LIMITED_MESSAGE,
      data: null,
      reason: {
        code: 'statement_rate_limited',
        message: STATEMENT_RATE_LIMITED_MESSAGE,
        retryAfterSeconds: expect.any(Number) as number,
      },
    });
    const retry = body(sixth).reason!.retryAfterSeconds!;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    await call(b.auth).expect(200);
    const real = limiter.now;
    try {
      limiter.now = () => real() + 61_000;
      await call(a.auth).expect(200);
    } finally {
      limiter.now = real;
    }
  });
});

describe('the statement limiter, on its own (WALLET-27)', () => {
  it('5 a minute and 30 an hour, fixed windows from the first request', () => {
    const l = new StatementRateLimiter();
    let t = 1_000_000;
    l.now = () => t;
    const takes = (n: number) => {
      for (let i = 0; i < n; i += 1) l.take('p');
    };
    takes(5);
    expect(() => l.take('p')).toThrow(STATEMENT_RATE_LIMITED_MESSAGE);
    for (let m = 1; m < 6; m += 1) {
      t += 60_000;
      takes(5);
    }
    // 30 in the hour: the next minute's window is open, the hour's is not.
    t += 60_000;
    let err: unknown;
    try {
      l.take('p');
    } catch (e) {
      err = e;
    }
    expect(
      (
        err as {
          getResponse(): {
            reason: { code: string; retryAfterSeconds: number };
          };
        }
      ).getResponse().reason,
    ).toMatchObject({
      code: 'statement_rate_limited',
      retryAfterSeconds: 3_240,
    });
    t = 1_000_000 + 3_600_000;
    takes(5);
    // Someone else is untouched throughout.
    l.take('q');
  });

  it('rounds the wait up, never down, so a client told to wait is not refused again (X4)', async () => {
    const l = new StatementRateLimiter();
    let t = 2_000_000;
    l.now = () => t;
    for (let i = 0; i < 5; i += 1) l.take('p');
    // 500 ms into the minute: 59.5 s left, told 60, never 59.
    t += 500;
    let err: unknown;
    try {
      l.take('p');
    } catch (e) {
      err = e;
    }
    expect(
      (
        err as { getResponse(): { reason: { retryAfterSeconds: number } } }
      ).getResponse().reason.retryAfterSeconds,
    ).toBe(60);
    // A place given back is a place again; given back twice, still one.
    const l2 = new StatementRateLimiter();
    l2.now = () => t;
    for (let i = 0; i < 4; i += 1) l2.take('q');
    const giveBack = l2.take('q');
    giveBack();
    giveBack();
    l2.take('q');
    expect(() => l2.take('q')).toThrow(STATEMENT_RATE_LIMITED_MESSAGE);
    // The busy answer's wait is rounded up too: 1.5 s is 2.
    const slots = new StatementSlots();
    slots.waitMs = 1_500;
    const hold = () => new Promise((r) => setTimeout(r, 1_700));
    const results = await Promise.allSettled([
      slots.run(hold),
      slots.run(hold),
      slots.run(hold),
    ]);
    expect(
      (
        (results[2] as PromiseRejectedResult).reason as {
          getResponse(): { reason: { retryAfterSeconds: number } };
        }
      ).getResponse().reason.retryAfterSeconds,
    ).toBe(2);
  });

  it('stays bounded: 10,000 people in an hour, then one more an hour later, leaves one entry', () => {
    const l = new StatementRateLimiter();
    let t = 5_000_000;
    l.now = () => t;
    for (let i = 0; i < 10_000; i += 1) l.take(`p${i}`);
    expect(l.size).toBe(10_000);
    t += 3_600_000;
    l.take('late');
    expect(l.size).toBe(1);
  });

  it('two places: the third waits its turn and gets the place freed; past the wait it is statement_busy', async () => {
    const slots = new StatementSlots();
    expect([slots.max, slots.waitMs]).toEqual([2, 5_000]);
    slots.waitMs = 200;
    let inside = 0;
    let most = 0;
    const work = (ms: number) =>
      slots.run(async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, ms));
        inside -= 1;
        return ms;
      });
    // 50 ms each: the third and fourth wait less than 200 ms and run.
    expect(await Promise.all([work(50), work(50), work(50), work(50)])).toEqual(
      [50, 50, 50, 50],
    );
    expect(most).toBe(2);
    // 500 ms each: the third waits 200 ms and is refused, the place is not lost.
    const results = await Promise.allSettled([work(500), work(500), work(500)]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
    const reason = (results[2] as PromiseRejectedResult).reason as {
      getResponse(): { reason: unknown };
      getStatus(): number;
    };
    expect(reason.getStatus()).toBe(503);
    expect(reason.getResponse().reason).toEqual({
      code: 'statement_busy',
      message: STATEMENT_BUSY_MESSAGE,
      retryAfterSeconds: 1,
    });
    expect(await work(10)).toBe(10);
    expect(slots.peak).toBe(2);
  });
});

describe('statements over HTTP: forged floods and two at once (WALLET-27)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let limiter: StatementRateLimiter;
  let slots: StatementSlots;
  const people = walletMaker(() => prisma);

  beforeAll(async () => {
    const built = await buildApp(false);
    app = built.app;
    prisma = built.prisma;
    limiter = built.moduleRef.get(StatementRateLimiter);
    slots = built.moduleRef.get(StatementSlots);
  });

  afterAll(async () => {
    await people.clean();
    await app.close();
  });

  it('10,000 forged tokens, each a different sub: every one 401, and the limiter holds no more entries than before', async () => {
    const before = limiter.size;
    const server = app.getHttpServer();
    const counts: Record<number, number> = {};
    let next = 0;
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        while (next < 10_000) {
          next += 1;
          const r = await request(server)
            .get(SEPT)
            .set('Authorization', forged(randomUUID()));
          counts[r.status] = (counts[r.status] ?? 0) + 1;
        }
      }),
    );
    expect(counts).toEqual({ 401: 10_000 });
    expect(limiter.size).toBe(before);
  }, 180_000);

  it('5 people at once while each statement takes a while: at most 2 build; with a short wait the others are 503 statement_busy, with the normal wait all 5 are served', async () => {
    const five = await Promise.all(
      Array.from({ length: 5 }, () => people.make()),
    );
    const realQuery = prisma.$queryRaw.bind(prisma);
    const slow = (ms: number) =>
      jest.spyOn(prisma, '$queryRaw').mockImplementation(((
        ...args: Parameters<PrismaService['$queryRaw']>
      ) => {
        const q = JSON.stringify(args[0]);
        const run = () => realQuery(...args);
        return q.includes('COUNT(*)')
          ? new Promise((r) => setTimeout(r, ms)).then(run)
          : run();
      }) as PrismaService['$queryRaw']);

    const spy1 = slow(600);
    slots.waitMs = 200;
    slots.peak = 0;
    try {
      const res = await Promise.all(
        five.map((p) =>
          request(app.getHttpServer()).get(SEPT).set('Authorization', p.auth),
        ),
      );
      const statuses = res.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 503, 503, 503]);
      for (const r of res.filter((x) => x.status === 503)) {
        expect(body(r).reason).toEqual({
          code: 'statement_busy',
          message: STATEMENT_BUSY_MESSAGE,
          retryAfterSeconds: 1,
        });
      }
      expect(slots.peak).toBe(2);
    } finally {
      spy1.mockRestore();
    }

    const spy2 = slow(300);
    slots.waitMs = 5_000;
    slots.peak = 0;
    try {
      const res = await Promise.all(
        five.map((p) =>
          request(app.getHttpServer()).get(SEPT).set('Authorization', p.auth),
        ),
      );
      expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(slots.peak).toBe(2);
    } finally {
      spy2.mockRestore();
    }
  }, 60_000);

  it('the route’s own 400s never count against the person: each sent five times, then a good request is 200, and the limit still holds after (defect 2)', async () => {
    const p = await people.make();
    const acct = (
      await prisma.fintavaWallet.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      })
    ).accountNumber;
    // 50,001 completed rows in September: that month is too large.
    await prisma.$executeRaw`
      INSERT INTO "FintavaLedgerEntry"
        ("id", "walletKind", "wawuUserId", "accountNumber", "direction",
         "status", "category", "amountKobo", "feeKobo", "totalKobo",
         "customerReference", "source", "occurredAt", "completedAt", "updatedAt")
      SELECT gen_random_uuid()::text, 'user', ${p.id}, ${acct}, 'in',
             'completed', 'transfer', 100, 0, 100,
             'W27-R4-' || ${p.id} || '-' || g, 'send',
             timestamp '2026-09-01 00:00:00' + (g * interval '30 seconds'),
             now(), now()
        FROM generate_series(1, ${STATEMENT_MAX_ROWS + 1}::int) g`;
    const today = lagosToday(new Date());
    const [ty, tm, td] = today.split('-').map(Number);
    const day = (back: number) =>
      new Date(Date.UTC(ty, tm - 1, td - back)).toISOString().slice(0, 10);
    const refusals: Array<[string, string]> = [
      ['from=2026-02-30&to=2026-03-01&format=csv', 'not a day'],
      ['from=2026-09-30&to=2026-09-01&format=csv', 'from after to'],
      [`from=${today}&to=${day(-1)}&format=csv`, 'to in the future'],
      [`from=${day(366)}&to=${today}&format=csv`, 'more than 366 days'],
      ['from=2026-09-01&to=2026-09-30&format=csv', 'statement_too_large'],
    ];
    const server = app.getHttpServer();
    for (const [q, why] of refusals) {
      for (let i = 0; i < 5; i += 1) {
        const r = await request(server)
          .get(`${BASE}?${q}`)
          .set('Authorization', p.auth);
        expect({ why, i, status: r.status }).toEqual({ why, i, status: 400 });
      }
    }
    const good = `${BASE}?from=2026-07-01&to=2026-07-31&format=csv`;
    // None of those 25 counted: five good ones, then the sixth is 429.
    for (let i = 0; i < 5; i += 1)
      await request(server).get(good).set('Authorization', p.auth).expect(200);
    const sixth = await request(server)
      .get(good)
      .set('Authorization', p.auth)
      .expect(429);
    expect(body(sixth).reason?.code).toBe('statement_rate_limited');
  }, 60_000);

  it('the generated contract documents every refusal the route gives (N4)', () => {
    const spec = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../contract/openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<
        string,
        { get: { responses: Record<string, { description: string }> } }
      >;
    };
    const responses = spec.paths['/api/hub/money/statements'].get.responses;
    expect({
      400: responses['400']?.description,
      409: responses['409']?.description,
      423: responses['423']?.description,
      429: responses['429']?.description,
      503: responses['503']?.description,
    }).toEqual({
      400: 'reason.code: statement_too_large',
      409: 'reason.code: wallet_not_open, wallet_opening',
      423: 'reason.code: wallet_frozen',
      429: 'reason.code: statement_rate_limited',
      503: 'reason.code: statement_busy',
    });
    // And the code that writes it: the route's own declared responses, as
    // `contract:build` reads them (so a change here fails before a rebuild).
    const declared = Reflect.getMetadata(
      'swagger/apiResponse',
      (MoneyStatementController.prototype as unknown as Record<string, object>)
        .statement,
    ) as Record<string, { description: string }>;
    expect(
      Object.fromEntries(
        Object.entries(declared).map(([k, v]) => [k, v.description]),
      ),
    ).toEqual({
      400: 'reason.code: statement_too_large',
      409: 'reason.code: wallet_not_open, wallet_opening',
      423: 'reason.code: wallet_frozen',
      429: 'reason.code: statement_rate_limited',
      503: 'reason.code: statement_busy',
    });
  });
});

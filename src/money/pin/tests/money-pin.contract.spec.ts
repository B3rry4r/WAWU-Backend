import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  Logger,
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
import { MoneyModule } from '../../money.module';
import type { PinStateView } from '../../money-view.type';
import { PIN_MAX_TRIES } from '../transaction-pin.service';

/**
 * The transaction PIN over HTTP (task MONEY-09), against a real database and
 * real RS256 tokens verified over the mock WAWU ID's JWKS (port 4001, as every
 * contract spec here). Each test signs in as a brand-new wawuUserId, so it
 * owns its rows; afterAll deletes them.
 *
 * The lock length is set to 7 minutes here so the test can tell config from
 * the provisional default.
 */

const LOCK_MINUTES = 7;
const BASE = '/api/hub/money/pin';
const HEADER = 'X-Transaction-Pin';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `pin-${sub}@test.wawu.dev`,
      phone: '+2348000009999',
      firstName: 'Pin',
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

/** Everything any part of the app printed while a block ran. */
class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push(level: string, args: unknown[]) {
    this.lines.push(`${level} ${args.map((a) => stringify(a)).join(' ')}`);
  }
  log(...args: unknown[]) {
    this.push('log', args);
  }
  error(...args: unknown[]) {
    this.push('error', args);
  }
  warn(...args: unknown[]) {
    this.push('warn', args);
  }
  debug(...args: unknown[]) {
    this.push('debug', args);
  }
  verbose(...args: unknown[]) {
    this.push('verbose', args);
  }
  fatal(...args: unknown[]) {
    this.push('fatal', args);
  }
}

/** The response envelope (ResponseInterceptor, AllExceptionsFilter). */
type Envelope = {
  statusCode: number;
  message: string;
  data: PinStateView | null;
  reason?: MoneyErrorReason;
};
const envelope = (res: Response): Envelope => res.body as Envelope;
const data = (res: Response): PinStateView => envelope(res).data!;
const reason = (res: Response): MoneyErrorReason => envelope(res).reason!;

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

describe('Transaction PIN (MONEY-09) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const logger = new CapturingLogger();
  const users: string[] = [];
  const previousLock = process.env.PIN_LOCK_MINUTES;

  /** A new person, with a token, and nothing in the database yet. */
  function newUser(): { id: string; auth: string } {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}` };
  }

  async function withPin(pin: string) {
    const user = newUser();
    await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', user.auth)
      .send({ pin, pinConfirmation: pin })
      .expect(201);
    return user;
  }

  function verify(auth: string, pin?: string) {
    const req = request(app.getHttpServer())
      .post(`${BASE}/verify`)
      .set('Authorization', auth);
    return pin === undefined ? req : req.set(HEADER, pin);
  }

  function state(auth: string) {
    return request(app.getHttpServer()).get(BASE).set('Authorization', auth);
  }

  beforeAll(async () => {
    process.env.PIN_LOCK_MINUTES = String(LOCK_MINUTES);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();

    app = moduleRef.createNestApplication({ logger });
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
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.transactionPin.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
    if (previousLock === undefined) delete process.env.PIN_LOCK_MINUTES;
    else process.env.PIN_LOCK_MINUTES = previousLock;
  });

  describe('GET /money/pin', () => {
    it('a person without a PIN reads not set, every try left, no lock', async () => {
      const user = newUser();
      const res = await state(user.auth).expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: {
          isSet: false,
          changedAt: null,
          triesLeft: PIN_MAX_TRIES,
          lockedUntil: null,
        },
      });
    });

    it('no token is 401 (the token, not the PIN)', async () => {
      await request(app.getHttpServer()).get(BASE).expect(401);
    });
  });

  describe('POST /money/pin (set)', () => {
    it('a user can set a PIN; it is stored only as an argon2id hash with its own salt', async () => {
      const a = newUser();
      const b = newUser();
      const before = Date.now();
      for (const user of [a, b]) {
        const res = await request(app.getHttpServer())
          .post(BASE)
          .set('Authorization', user.auth)
          .send({ pin: '2580', pinConfirmation: '2580' })
          .expect(201);
        expect(data(res)).toMatchObject({
          isSet: true,
          triesLeft: PIN_MAX_TRIES,
          lockedUntil: null,
        });
        expect(Date.parse(data(res).changedAt ?? '')).toBeGreaterThanOrEqual(
          before - 1000,
        );
        expect(JSON.stringify(res.body)).not.toContain('2580');
      }
      const rows = await prisma.transactionPin.findMany({
        where: { wawuUserId: { in: [a.id, b.id] } },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.pinHash.startsWith('$argon2id$')).toBe(true);
        expect(row.pinHash).not.toContain('2580');
      }
      // Same PIN, different salt, different hash.
      expect(rows[0].pinHash).not.toBe(rows[1].pinHash);
    });

    it('two different entries are 400 pin_mismatch, and nothing is stored', async () => {
      const user = newUser();
      const res = await request(app.getHttpServer())
        .post(BASE)
        .set('Authorization', user.auth)
        .send({ pin: '1357', pinConfirmation: '1358' })
        .expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        data: null,
        reason: { code: 'pin_mismatch' },
      });
      expect(
        await prisma.transactionPin.findUnique({
          where: { wawuUserId: user.id },
        }),
      ).toBeNull();
    });

    it('a second set is 409 pin_already_set and keeps the first PIN', async () => {
      const user = await withPin('4444');
      const res = await request(app.getHttpServer())
        .post(BASE)
        .set('Authorization', user.auth)
        .send({ pin: '5555', pinConfirmation: '5555' })
        .expect(409);
      expect(reason(res)).toMatchObject({ code: 'pin_already_set' });
      await verify(user.auth, '4444').expect(200);
    });

    it.each([['123'], ['12345'], ['12a4'], [1234]])(
      'a PIN that is not four digits (%p) is a validation 400 without reason',
      async (pin) => {
        const user = newUser();
        const res = await request(app.getHttpServer())
          .post(BASE)
          .set('Authorization', user.auth)
          .send({ pin, pinConfirmation: pin })
          .expect(400);
        expect(reason(res)).toBeUndefined();
        expect(envelope(res).message).toBe('A PIN is four digits.');
      },
    );
  });

  describe('POST /money/pin/verify', () => {
    it('the right PIN answers 200 with the PIN state', async () => {
      const user = await withPin('0912');
      const res = await verify(user.auth, '0912').expect(200);
      expect(data(res)).toMatchObject({
        isSet: true,
        triesLeft: PIN_MAX_TRIES,
        lockedUntil: null,
      });
    });

    it('without the header it is 403 pin_required, and no try is used', async () => {
      const user = await withPin('0912');
      const res = await verify(user.auth).expect(403);
      expect(reason(res)).toEqual({
        code: 'pin_required',
        message: 'Enter your 4-digit transaction PIN.',
      });
      const malformed = await verify(user.auth, '12345').expect(403);
      expect(reason(malformed).code).toBe('pin_required');
      expect(data(await state(user.auth)).triesLeft).toBe(PIN_MAX_TRIES);
    });

    it('a person without a PIN is 409 pin_not_set', async () => {
      const user = newUser();
      const res = await verify(user.auth, '1111').expect(409);
      expect(reason(res).code).toBe('pin_not_set');
    });

    it('five wrong tries lock it: 403 with tries left four times, then 423 with lockedUntil', async () => {
      const user = await withPin('7777');
      for (const left of [4, 3, 2, 1]) {
        const res = await verify(user.auth, '1234').expect(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          data: null,
          reason: { code: 'pin_incorrect', triesLeft: left },
        });
      }
      const before = Date.now();
      const locked = await verify(user.auth, '1234').expect(423);
      expect(reason(locked).code).toBe('pin_locked');
      const until = Date.parse(reason(locked).lockedUntil ?? '');
      expect(reason(locked).lockedUntil).toBe(new Date(until).toISOString());
      // PIN_LOCK_MINUTES from config, not the default.
      expect(until - before).toBeGreaterThan(LOCK_MINUTES * 60_000 - 5_000);
      expect(until - before).toBeLessThanOrEqual(LOCK_MINUTES * 60_000 + 5_000);

      // Locked means locked: the right PIN is refused too, with the same end.
      const right = await verify(user.auth, '7777').expect(423);
      expect(reason(right)).toMatchObject({
        code: 'pin_locked',
        lockedUntil: reason(locked).lockedUntil,
      });
      expect(data(await state(user.auth))).toMatchObject({
        triesLeft: 0,
        lockedUntil: reason(locked).lockedUntil,
      });
    });

    it('when the lock ends, the right PIN works and every try is back', async () => {
      const user = await withPin('3141');
      for (let i = 0; i < PIN_MAX_TRIES; i++) {
        await verify(user.auth, '0000');
      }
      await verify(user.auth, '3141').expect(423);
      // The lock's end passes.
      await prisma.transactionPin.update({
        where: { wawuUserId: user.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      expect(data(await state(user.auth))).toMatchObject({
        triesLeft: PIN_MAX_TRIES,
        lockedUntil: null,
      });
      await verify(user.auth, '3141').expect(200);
      // And a wrong try after it counts from the start again.
      const res = await verify(user.auth, '0000').expect(403);
      expect(reason(res).triesLeft).toBe(PIN_MAX_TRIES - 1);
    });

    it('a wrong try after an ended lock (with no right PIN between) also starts the count again', async () => {
      const user = await withPin('3141');
      for (let i = 0; i < PIN_MAX_TRIES; i++) {
        await verify(user.auth, '0000');
      }
      await prisma.transactionPin.update({
        where: { wawuUserId: user.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      const res = await verify(user.auth, '0000').expect(403);
      expect(reason(res).triesLeft).toBe(PIN_MAX_TRIES - 1);
    });

    it('the right PIN puts the count back to the start', async () => {
      const user = await withPin('2468');
      await verify(user.auth, '0000').expect(403);
      await verify(user.auth, '0000').expect(403);
      expect(data(await state(user.auth)).triesLeft).toBe(3);
      await verify(user.auth, '2468').expect(200);
      expect(data(await state(user.auth)).triesLeft).toBe(PIN_MAX_TRIES);
      const res = await verify(user.auth, '0000').expect(403);
      expect(reason(res).triesLeft).toBe(PIN_MAX_TRIES - 1);
    });

    it('ten wrong tries sent at once get exactly five compared: four 403s, then six 423s', async () => {
      const user = await withPin('8642');
      const results = await Promise.all(
        Array.from({ length: 10 }, () => verify(user.auth, '1111')),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([
        403, 403, 403, 403, 423, 423, 423, 423, 423, 423,
      ]);
      const row = await prisma.transactionPin.findUniqueOrThrow({
        where: { wawuUserId: user.id },
      });
      expect(row.failedTries).toBe(PIN_MAX_TRIES);
      expect(row.lockedUntil).not.toBeNull();
      await verify(user.auth, '8642').expect(423);
    });

    it('a PIN refusal is never a 401', async () => {
      const user = await withPin('1212');
      const codes = [
        (await verify(user.auth)).status,
        (await verify(user.auth, '0000')).status,
        (await verify(newUser().auth, '0000')).status,
      ];
      for (let i = 0; i < PIN_MAX_TRIES; i++) {
        codes.push((await verify(user.auth, '0000')).status);
      }
      expect(codes).not.toContain(401);
      expect(new Set(codes)).toEqual(new Set([403, 409, 423]));
    });
  });

  describe('PUT /money/pin (change)', () => {
    function change(auth: string, current: string | undefined, body: object) {
      const req = request(app.getHttpServer())
        .put(BASE)
        .set('Authorization', auth);
      return (current === undefined ? req : req.set(HEADER, current)).send(
        body,
      );
    }

    it('a user can change the PIN with the current one; the old PIN stops working', async () => {
      const user = await withPin('1029');
      const before = await prisma.transactionPin.findUniqueOrThrow({
        where: { wawuUserId: user.id },
      });
      const res = await change(user.auth, '1029', {
        newPin: '5647',
        newPinConfirmation: '5647',
      }).expect(200);
      expect(data(res)).toMatchObject({
        isSet: true,
        triesLeft: PIN_MAX_TRIES,
        lockedUntil: null,
      });
      expect(Date.parse(data(res).changedAt ?? '')).toBeGreaterThanOrEqual(
        before.setAt.getTime(),
      );
      const after = await prisma.transactionPin.findUniqueOrThrow({
        where: { wawuUserId: user.id },
      });
      expect(after.pinHash).not.toBe(before.pinHash);
      expect(after.setAt.getTime()).toBeGreaterThan(before.setAt.getTime());
      await verify(user.auth, '1029').expect(403);
      await verify(user.auth, '5647').expect(200);
    });

    it('the current PIN is required: no header is 403 pin_required and nothing changes', async () => {
      const user = await withPin('1029');
      const res = await change(user.auth, undefined, {
        newPin: '5647',
        newPinConfirmation: '5647',
      }).expect(403);
      expect(reason(res).code).toBe('pin_required');
      await verify(user.auth, '1029').expect(200);
    });

    it('a wrong current PIN is 403 pin_incorrect, uses a try, and changes nothing', async () => {
      const user = await withPin('1029');
      const res = await change(user.auth, '9999', {
        newPin: '5647',
        newPinConfirmation: '5647',
      }).expect(403);
      expect(reason(res)).toMatchObject({
        code: 'pin_incorrect',
        triesLeft: PIN_MAX_TRIES - 1,
      });
      await verify(user.auth, '5647').expect(403);
      await verify(user.auth, '1029').expect(200);
    });

    it('new entries that differ are 400 pin_mismatch, and the PIN stays the same', async () => {
      const user = await withPin('1029');
      const res = await change(user.auth, '1029', {
        newPin: '5647',
        newPinConfirmation: '5648',
      }).expect(400);
      expect(reason(res).code).toBe('pin_mismatch');
      await verify(user.auth, '1029').expect(200);
    });

    it('a locked PIN cannot be changed: 423 pin_locked', async () => {
      const user = await withPin('1029');
      for (let i = 0; i < PIN_MAX_TRIES; i++) {
        await verify(user.auth, '0000');
      }
      const res = await change(user.auth, '1029', {
        newPin: '5647',
        newPinConfirmation: '5647',
      }).expect(423);
      expect(reason(res).code).toBe('pin_locked');
    });

    it('a person without a PIN is 409 pin_not_set', async () => {
      const user = newUser();
      const res = await change(user.auth, '1029', {
        newPin: '5647',
        newPinConfirmation: '5647',
      }).expect(409);
      expect(reason(res).code).toBe('pin_not_set');
    });
  });

  describe('the PIN never reaches a log or a response', () => {
    it('across set, wrong tries, a lock, a change and a failed request, no output carries the digits', async () => {
      const pin = '6093';
      const wrong = '8157';
      const newPin = '7248';
      const printed: string[] = [];
      const streamSpies = [process.stdout, process.stderr].map((stream) =>
        jest
          .spyOn(stream, 'write')
          .mockImplementation((chunk: string | Uint8Array) => {
            printed.push(
              typeof chunk === 'string'
                ? chunk
                : Buffer.from(chunk).toString('utf8'),
            );
            return true;
          }),
      );
      const consoleSpies = (
        ['log', 'info', 'warn', 'error', 'debug'] as const
      ).map((level) =>
        jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          printed.push(args.map(stringify).join(' '));
        }),
      );
      logger.lines = [];
      const bodies: string[] = [];
      try {
        // A positive control: the capture really sees what the app logs.
        new Logger('PinLogProbe').warn('probe line');

        const user = newUser();
        const responses = [
          await request(app.getHttpServer())
            .post(BASE)
            .set('Authorization', user.auth)
            .send({ pin, pinConfirmation: pin }),
          await verify(user.auth, wrong),
          await request(app.getHttpServer())
            .put(BASE)
            .set('Authorization', user.auth)
            .set(HEADER, pin)
            .send({ newPin, newPinConfirmation: newPin }),
          await verify(user.auth, pin),
          // A malformed body after a right PIN: validation refuses it.
          await request(app.getHttpServer())
            .put(BASE)
            .set('Authorization', user.auth)
            .set(HEADER, newPin)
            .send({ newPin: wrong, newPinConfirmation: wrong, extra: wrong }),
        ];
        for (let i = 0; i < PIN_MAX_TRIES; i++) {
          responses.push(await verify(user.auth, wrong));
        }
        responses.push(await verify(user.auth, newPin));
        // A request that fails inside the app (not a refusal): the database
        // is unreachable for one call, so the exception filter logs it.
        const spy = jest
          .spyOn(prisma.transactionPin, 'updateMany')
          .mockRejectedValueOnce(new Error('database went away'));
        responses.push(await verify(user.auth, newPin));
        spy.mockRestore();

        expect(responses.map((r) => r.status)).toEqual([
          201, 403, 200, 403, 400, 403, 403, 403, 403, 423, 423, 500,
        ]);
        for (const r of responses) {
          bodies.push(r.text);
          bodies.push(JSON.stringify(r.headers));
        }
      } finally {
        streamSpies.forEach((s) => s.mockRestore());
        consoleSpies.forEach((s) => s.mockRestore());
      }

      const logged = [...logger.lines, ...printed].join('\n');
      expect(logged).toContain('probe line');
      expect(logged).toContain('database went away');
      for (const digits of [pin, wrong, newPin]) {
        expect(logged).not.toContain(digits);
        for (const body of bodies) expect(body).not.toContain(digits);
      }
    });
  });
});

import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { AppModule } from '../../../app.module';
import { MoneyError } from '../../money-error';
import {
  takeTransactionPin,
  TRANSACTION_PIN_HEADER,
  TransactionPinGuard,
} from '../transaction-pin.guard';
import {
  DEFAULT_PIN_LOCK_MINUTES,
  PIN_MAX_TRIES,
  pinLockMinutes,
  pinStateView,
  type TransactionPinService,
} from '../transaction-pin.service';

/**
 * Unit tests for the transaction PIN (task MONEY-09) that need no database:
 * the X-Transaction-Pin guard, how it takes the header out of the request,
 * the PIN state view, and the lock length from config. The behaviour against
 * a real database (set, change, verify, the lock and its end, concurrent
 * tries, nothing in the logs) is money-pin.contract.spec.ts.
 */

/**
 * Where @ApiHeader on a method keeps its entry (@nestjs/swagger's
 * DECORATORS.API_PARAMETERS, with `in: 'header'`; the package's exports do
 * not expose its constants file).
 */
const API_PARAMETERS_METADATA = 'swagger/apiParameters';

function fakeRequest(headers: Record<string, string | string[]>): Request {
  const rawHeaders: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      rawHeaders.push(name, v);
    }
  }
  const lower: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value;
  }
  return { headers: lower, rawHeaders } as unknown as Request;
}

function contextFor(req: Request): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('takeTransactionPin', () => {
  it('reads a four-digit PIN and removes the header from headers and rawHeaders', () => {
    const req = fakeRequest({
      Authorization: 'Bearer t',
      'X-Transaction-Pin': '0427',
    });
    expect(takeTransactionPin(req)).toBe('0427');
    expect(req.headers[TRANSACTION_PIN_HEADER]).toBeUndefined();
    expect(req.rawHeaders).toEqual(['Authorization', 'Bearer t']);
    expect(JSON.stringify(req.headers)).not.toContain('0427');
  });

  it.each([
    ['missing', {}],
    ['empty', { 'X-Transaction-Pin': '' }],
    ['three digits', { 'X-Transaction-Pin': '123' }],
    ['five digits', { 'X-Transaction-Pin': '12345' }],
    ['letters', { 'X-Transaction-Pin': '12a4' }],
    ['spaces', { 'X-Transaction-Pin': ' 1234' }],
    ['sent twice', { 'X-Transaction-Pin': ['1234', '1234'] }],
  ])(
    'answers null when the header is %s, and still removes it',
    (_, headers) => {
      const req = fakeRequest(headers);
      expect(takeTransactionPin(req)).toBeNull();
      expect(req.headers[TRANSACTION_PIN_HEADER]).toBeUndefined();
      expect(
        req.rawHeaders.filter(
          (h) => h.toLowerCase() === TRANSACTION_PIN_HEADER,
        ),
      ).toEqual([]);
    },
  );
});

describe('TransactionPinGuard', () => {
  const user = { sub: '11111111-1111-4111-8111-111111111111' };

  function guardWith(verify: jest.Mock) {
    return new TransactionPinGuard({
      verify,
    } as unknown as TransactionPinService);
  }

  it('refuses a request without the header with 403 pin_required, before checking anything', async () => {
    const verify = jest.fn();
    const req = Object.assign(fakeRequest({}), { user });
    const err = await guardWith(verify)
      .canActivate(contextFor(req))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).getStatus()).toBe(403);
    expect((err as MoneyError).getResponse()).toEqual({
      message: 'Enter your 4-digit transaction PIN.',
      reason: {
        code: 'pin_required',
        message: 'Enter your 4-digit transaction PIN.',
      },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a PIN that is not four digits as pin_required, using no try', async () => {
    const verify = jest.fn();
    const req = Object.assign(fakeRequest({ 'X-Transaction-Pin': '99999' }), {
      user,
    });
    const err = await guardWith(verify)
      .canActivate(contextFor(req))
      .catch((e: unknown) => e);
    expect((err as MoneyError).code).toBe('pin_required');
    expect(verify).not.toHaveBeenCalled();
  });

  it("checks the header's PIN for the caller in the token, then lets the request through without the header", async () => {
    const verify = jest.fn().mockResolvedValue({});
    const req = Object.assign(fakeRequest({ 'X-Transaction-Pin': '5512' }), {
      user,
    });
    await expect(guardWith(verify).canActivate(contextFor(req))).resolves.toBe(
      true,
    );
    expect(verify).toHaveBeenCalledWith(user.sub, '5512');
    expect(req.headers[TRANSACTION_PIN_HEADER]).toBeUndefined();
  });

  it("passes the service's refusal through unchanged (never a 401)", async () => {
    const refusal = new MoneyError(
      'pin_incorrect',
      'Wrong PIN. 3 tries left.',
      {
        triesLeft: 3,
      },
    );
    const verify = jest.fn().mockRejectedValue(refusal);
    const req = Object.assign(fakeRequest({ 'X-Transaction-Pin': '5512' }), {
      user,
    });
    await expect(guardWith(verify).canActivate(contextFor(req))).rejects.toBe(
      refusal,
    );
    expect(refusal.getStatus()).toBe(403);
  });

  it('fails loudly when no signed-in caller is on the request (WawuAuthGuard missing)', async () => {
    const verify = jest.fn();
    const req = fakeRequest({ 'X-Transaction-Pin': '5512' });
    await expect(
      guardWith(verify).canActivate(contextFor(req)),
    ).rejects.toThrow('WawuAuthGuard must run first');
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('every mounted route that documents X-Transaction-Pin uses the guard', () => {
  /** Every module AppModule reaches through `imports`. */
  function reachable(root: unknown): Set<unknown> {
    const seen = new Set<unknown>();
    const stack: unknown[] = [root];
    while (stack.length) {
      let mod = stack.pop();
      if (mod && typeof mod === 'object' && 'forwardRef' in mod) {
        mod = (mod as { forwardRef: () => unknown }).forwardRef();
      }
      if (mod && typeof mod === 'object' && 'module' in mod) {
        stack.push(...((mod as { imports?: unknown[] }).imports ?? []));
        mod = mod.module;
      }
      if (!mod || seen.has(mod)) continue;
      seen.add(mod);
      stack.push(
        ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ??
          []) as unknown[]),
      );
    }
    return seen;
  }

  it('finds the PIN routes, and each one runs TransactionPinGuard', () => {
    const withHeader: string[] = [];
    const missingGuard: string[] = [];
    for (const mod of reachable(AppModule)) {
      const controllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        mod as object,
      ) ?? []) as Array<{ name: string; prototype: object }>;
      for (const controller of controllers) {
        const proto = controller.prototype as Record<string, unknown>;
        for (const key of Object.getOwnPropertyNames(proto)) {
          const handler = proto[key];
          if (key === 'constructor' || typeof handler !== 'function') continue;
          const params = (Reflect.getMetadata(
            API_PARAMETERS_METADATA,
            handler,
          ) ?? []) as Array<{ name?: string; in?: string }>;
          if (
            !params.some(
              (p) =>
                p.in === 'header' &&
                p.name?.toLowerCase() === TRANSACTION_PIN_HEADER,
            )
          ) {
            continue;
          }
          const where = `${controller.name}.${key}`;
          withHeader.push(where);
          const guards = [
            ...((Reflect.getMetadata(GUARDS_METADATA, controller) ??
              []) as unknown[]),
            ...((Reflect.getMetadata(GUARDS_METADATA, handler) ??
              []) as unknown[]),
          ];
          if (!guards.includes(TransactionPinGuard)) missingGuard.push(where);
        }
      }
    }
    expect(withHeader.sort()).toEqual(
      expect.arrayContaining([
        'MoneyPinController.change',
        'MoneyPinController.verify',
      ]),
    );
    expect(missingGuard).toEqual([]);
  });
});

describe('pinStateView', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const setAt = new Date('2026-10-01T09:30:00.000Z');

  it('no row: not set, every try left, no lock', () => {
    expect(pinStateView(null, now)).toEqual({
      isSet: false,
      changedAt: null,
      triesLeft: PIN_MAX_TRIES,
      lockedUntil: null,
    });
  });

  it('set with two wrong tries: three left, changedAt is when it was set', () => {
    expect(
      pinStateView(
        { pinHash: 'h', failedTries: 2, lockedUntil: null, setAt },
        now,
      ),
    ).toEqual({
      isSet: true,
      changedAt: setAt.toISOString(),
      triesLeft: 3,
      lockedUntil: null,
    });
  });

  it('locked: no tries left and the time it ends', () => {
    const until = new Date('2026-10-02T12:30:00.000Z');
    expect(
      pinStateView(
        { pinHash: 'h', failedTries: 5, lockedUntil: until, setAt },
        now,
      ),
    ).toMatchObject({ triesLeft: 0, lockedUntil: until.toISOString() });
  });

  it('a lock that has ended reads as no lock, with every try back', () => {
    const ended = new Date('2026-10-02T11:59:59.000Z');
    expect(
      pinStateView(
        { pinHash: 'h', failedTries: 5, lockedUntil: ended, setAt },
        now,
      ),
    ).toMatchObject({ triesLeft: PIN_MAX_TRIES, lockedUntil: null });
  });

  it('never carries the hash', () => {
    const view = pinStateView(
      { pinHash: '$argon2id$secret', failedTries: 0, lockedUntil: null, setAt },
      now,
    );
    expect(JSON.stringify(view)).not.toContain('argon2');
  });
});

describe('pinLockMinutes (PIN_LOCK_MINUTES)', () => {
  it('uses the provisional default when unset or empty', () => {
    expect(pinLockMinutes(undefined)).toBe(DEFAULT_PIN_LOCK_MINUTES);
    expect(pinLockMinutes('  ')).toBe(DEFAULT_PIN_LOCK_MINUTES);
  });

  it('reads whole minutes from config', () => {
    expect(pinLockMinutes('15')).toBe(15);
    expect(pinLockMinutes('1440')).toBe(1440);
  });

  it.each(['0', '-5', '2.5', 'thirty', '15m'])(
    'refuses %s rather than locking for a length nobody chose',
    (raw) => {
      expect(() => pinLockMinutes(raw)).toThrow('PIN_LOCK_MINUTES');
    },
  );
});

import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { MoneyError } from '../../money-error';
import {
  APPROVAL_MESSAGE_TAG,
  approvalMessage,
  type ApprovalDeviceService,
  readApprovalKey,
} from '../approval-device.service';
import {
  DEFAULT_DEVICE_APPROVAL_SECONDS,
  PIN_RESET_DEFAULTS,
  PinResetSettings,
  RESET_CODE_DIGITS,
  RESET_TRIES_PER_CODE,
  wholeSetting,
} from '../pin-reset-config';
import { maskPhone, resetCodeText } from '../pin-reset.service';
import {
  ALLOWS_DEVICE_APPROVAL,
  takeDeviceApproval,
  TransactionPinGuard,
} from '../transaction-pin.guard';
import {
  DEFAULT_PIN_LOCK_MINUTES,
  PIN_MAX_TRIES,
  type TransactionPinService,
} from '../transaction-pin.service';
import type { ConfigService } from '@nestjs/config';

/**
 * Unit tests for task MONEY-14 that need no database: how strong a reset
 * code is next to the PIN, the settings, the masked phone and the text, the
 * approval message a phone signs, which keys are accepted, and how the guard
 * takes `X-Device-Approval` out of a request. The routes against a real
 * database are pin-reset.contract.spec.ts and device-approval.contract.spec.ts.
 */

function config(values: Record<string, string>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function fakeRequest(
  headers: Record<string, string | string[]>,
  extra: Partial<Request> & { rawBody?: Buffer } = {},
): Request {
  const rawHeaders: string[] = [];
  const lower: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      rawHeaders.push(name, v);
    }
    lower[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    headers: lower,
    rawHeaders,
    method: 'POST',
    originalUrl: '/api/hub/money/approval/verify',
    user: { sub: 'user-1' },
    ...extra,
  } as unknown as Request;
}

function contextFor(req: Request, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('a reset code is never the easier way in (MONEY-14)', () => {
  it('a code gets no more tries than the PIN, from a space a hundred times larger', () => {
    expect(RESET_TRIES_PER_CODE).toBe(PIN_MAX_TRIES);
    expect(RESET_CODE_DIGITS).toBe(6);
    expect(10 ** RESET_CODE_DIGITS).toBe(100 * 10 ** 4);
  });

  it("at the defaults, a day's guesses at codes have a smaller chance than a day's guesses at the PIN", () => {
    const pinGuessesPerDay =
      PIN_MAX_TRIES * ((24 * 60) / DEFAULT_PIN_LOCK_MINUTES);
    const pinChance = pinGuessesPerDay / 10 ** 4;
    const codeGuessesPerDay =
      PIN_RESET_DEFAULTS.textsPerDay * RESET_TRIES_PER_CODE;
    const codeChance = codeGuessesPerDay / 10 ** RESET_CODE_DIGITS;
    expect(pinGuessesPerDay).toBe(240);
    expect(codeGuessesPerDay).toBe(25);
    expect(codeChance).toBeLessThan(pinChance / 100);
  });

  it('the largest settings allowed still keep it so', () => {
    // PIN_RESET_TEXTS_PER_DAY is capped at 20 (pin-reset-config.ts).
    const worst = (20 * RESET_TRIES_PER_CODE) / 10 ** RESET_CODE_DIGITS;
    const pin = (PIN_MAX_TRIES * 48) / 10 ** 4;
    expect(worst).toBeLessThan(pin);
    expect(
      () => new PinResetSettings(config({ PIN_RESET_TEXTS_PER_DAY: '21' })),
    ).toThrow('PIN_RESET_TEXTS_PER_DAY');
  });
});

describe('PinResetSettings', () => {
  it('uses the provisional defaults when nothing is set', () => {
    const s = new PinResetSettings(config({}));
    expect(s.codeMs).toBe(PIN_RESET_DEFAULTS.codeSeconds * 1000);
    expect(s.resendMs).toBe(PIN_RESET_DEFAULTS.resendSeconds * 1000);
    expect(s.textsPerDay).toBe(PIN_RESET_DEFAULTS.textsPerDay);
    expect(s.approvalMs).toBe(DEFAULT_DEVICE_APPROVAL_SECONDS * 1000);
  });

  it('reads whole numbers from config', () => {
    const s = new PinResetSettings(
      config({
        PIN_RESET_CODE_SECONDS: '600',
        PIN_RESET_RESEND_SECONDS: '90',
        PIN_RESET_TEXTS_PER_DAY: '3',
        DEVICE_APPROVAL_SECONDS: '45',
      }),
    );
    expect([s.codeMs, s.resendMs, s.textsPerDay, s.approvalMs]).toEqual([
      600_000, 90_000, 3, 45_000,
    ]);
  });

  it.each([
    ['PIN_RESET_CODE_SECONDS', '0'],
    ['PIN_RESET_CODE_SECONDS', '12.5'],
    ['PIN_RESET_RESEND_SECONDS', 'soon'],
    ['PIN_RESET_TEXTS_PER_DAY', '0'],
    ['DEVICE_APPROVAL_SECONDS', '601'],
  ])('stops the app on %s=%s', (key, value) => {
    expect(() => new PinResetSettings(config({ [key]: value }))).toThrow(key);
  });

  it('refuses a resend gap longer than the code lives', () => {
    expect(
      () =>
        new PinResetSettings(
          config({
            PIN_RESET_CODE_SECONDS: '120',
            PIN_RESET_RESEND_SECONDS: '300',
          }),
        ),
    ).toThrow('PIN_RESET_RESEND_SECONDS');
  });

  it('wholeSetting falls back only when unset or empty', () => {
    expect(wholeSetting('K', undefined, 7, 1, 9)).toBe(7);
    expect(wholeSetting('K', ' ', 7, 1, 9)).toBe(7);
    expect(wholeSetting('K', '9', 7, 1, 9)).toBe(9);
  });
});

describe('what the person sees and is sent', () => {
  it('masks the phone to its last 4 digits', () => {
    expect(maskPhone('+2348031234412')).toBe('+234 *** *** 4412');
  });

  it('the text names the code and its life, with no em-dash and no WAWU', () => {
    const text = resetCodeText('042917', 5);
    expect(text).toContain('042917');
    expect(text).toContain('5 minutes');
    expect(text).not.toMatch(/\u2014|WAWU/);
  });
});

describe('the approval a phone signs', () => {
  const request = {
    method: 'post',
    url: '/api/hub/money/approval/verify',
    body: Buffer.from('{"a":1}'),
  };

  it('binds the scheme, the challenge, the phone and the exact request', () => {
    const msg = approvalMessage({
      challengeId: 'c-1',
      challenge: 'abc',
      deviceId: 'd-1',
      request,
    });
    expect(msg.split('\n')).toEqual([
      APPROVAL_MESSAGE_TAG,
      'c-1',
      'abc',
      'd-1',
      'POST',
      '/api/hub/money/approval/verify',
      createHash('sha256').update('{"a":1}').digest('hex'),
    ]);
  });

  it('changes with any byte of the body', () => {
    const a = approvalMessage({
      challengeId: 'c',
      challenge: 'x',
      deviceId: 'd',
      request,
    });
    const b = approvalMessage({
      challengeId: 'c',
      challenge: 'x',
      deviceId: 'd',
      request: { ...request, body: Buffer.from('{"a":2}') },
    });
    expect(a).not.toBe(b);
  });
});

describe('readApprovalKey', () => {
  const spki = (key: KeyObject) =>
    key.export({ format: 'der', type: 'spki' }).toString('base64url');

  it('accepts a P-256 public key', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(readApprovalKey(spki(publicKey))).not.toBeNull();
  });

  it('refuses other curves, other key types and anything that is not a key', () => {
    const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const ed = generateKeyPairSync('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(readApprovalKey(spki(k1.publicKey))).toBeNull();
    expect(readApprovalKey(spki(ed.publicKey))).toBeNull();
    expect(readApprovalKey(spki(rsa.publicKey))).toBeNull();
    expect(readApprovalKey('A'.repeat(122))).toBeNull();
    expect(readApprovalKey('')).toBeNull();
  });

  it('refuses a P-256 key whose point is not on the curve', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ format: 'der', type: 'spki' });
    der[der.length - 1] ^= 0x01; // the last byte of y
    expect(readApprovalKey(der.toString('base64url'))).toBeNull();
  });
});

describe('takeDeviceApproval', () => {
  it('reads the header and removes it from headers and rawHeaders', () => {
    const req = fakeRequest({ 'X-Device-Approval': 'v1.abc.def', Other: 'x' });
    expect(takeDeviceApproval(req)).toEqual({
      kind: 'sent',
      value: 'v1.abc.def',
    });
    expect(req.headers['x-device-approval']).toBeUndefined();
    expect(req.rawHeaders).toEqual(['Other', 'x']);
  });

  it('absent when not sent; unusable when empty or sent twice', () => {
    expect(takeDeviceApproval(fakeRequest({}))).toEqual({ kind: 'absent' });
    expect(
      takeDeviceApproval(fakeRequest({ 'X-Device-Approval': '' })),
    ).toEqual({ kind: 'unusable' });
    const twice = fakeRequest({ 'X-Device-Approval': ['a', 'b'] });
    expect(takeDeviceApproval(twice)).toEqual({ kind: 'unusable' });
    expect(twice.rawHeaders).toEqual([]);
  });
});

describe('TransactionPinGuard with biometric approval', () => {
  const allowed = () => undefined;
  const pinOnly = () => undefined;
  const reflector = new Reflector();
  Reflect.defineMetadata(ALLOWS_DEVICE_APPROVAL, true, allowed);

  function guard(verify: jest.Mock, approve: jest.Mock) {
    return new TransactionPinGuard(
      { verify } as unknown as TransactionPinService,
      reflector,
      { approve } as unknown as ApprovalDeviceService,
    );
  }

  it('on a route that allows it, checks only the approval, with the exact body, and uses no PIN try', async () => {
    const verify = jest.fn();
    const approve = jest.fn().mockResolvedValue(undefined);
    const body = Buffer.from('{"x":1}');
    const req = fakeRequest(
      { 'X-Device-Approval': 'v1.a.b', 'X-Transaction-Pin': '1234' },
      { rawBody: body } as Partial<Request>,
    );
    await expect(
      guard(verify, approve).canActivate(contextFor(req, allowed)),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledWith('user-1', 'v1.a.b', {
      method: 'POST',
      url: '/api/hub/money/approval/verify',
      body,
    });
    // Both headers are gone once read.
    expect(req.headers['x-transaction-pin']).toBeUndefined();
    expect(req.headers['x-device-approval']).toBeUndefined();
  });

  it('a refused approval is device_approval_refused, and the PIN is never tried', async () => {
    const verify = jest.fn();
    const approve = jest
      .fn()
      .mockRejectedValue(new MoneyError('device_approval_refused', 'no'));
    const req = fakeRequest({ 'X-Device-Approval': 'v1.a.b' });
    await expect(
      guard(verify, approve).canActivate(contextFor(req, allowed)),
    ).rejects.toMatchObject({ code: 'device_approval_refused' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('a body it did not keep byte for byte cannot be approved', async () => {
    const approve = jest.fn();
    const req = fakeRequest({
      'X-Device-Approval': 'v1.a.b',
      'Content-Length': '7',
    });
    await expect(
      guard(jest.fn(), approve).canActivate(contextFor(req, allowed)),
    ).rejects.toMatchObject({ code: 'device_approval_refused' });
    expect(approve).not.toHaveBeenCalled();
  });

  it('on a PIN-only route, an approval header is dropped and the PIN is required', async () => {
    const verify = jest.fn();
    const approve = jest.fn();
    const req = fakeRequest({ 'X-Device-Approval': 'v1.a.b' });
    await expect(
      guard(verify, approve).canActivate(contextFor(req, pinOnly)),
    ).rejects.toMatchObject({ code: 'pin_required' });
    expect(approve).not.toHaveBeenCalled();
    expect(req.headers['x-device-approval']).toBeUndefined();
  });

  it('without the approval service nothing is approved by a device', async () => {
    const g = new TransactionPinGuard(
      { verify: jest.fn() } as unknown as TransactionPinService,
      reflector,
    );
    const req = fakeRequest({ 'X-Device-Approval': 'v1.a.b' });
    await expect(g.canActivate(contextFor(req, allowed))).rejects.toMatchObject(
      { code: 'device_approval_refused' },
    );
  });

  it('a signature made by Node over the message verifies the way the service checks it', () => {
    // The scheme end to end without a database: what the app signs is what
    // the server rebuilds.
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const message = approvalMessage({
      challengeId: 'c',
      challenge: 'x',
      deviceId: 'd',
      request: { method: 'POST', url: '/u', body: Buffer.alloc(0) },
    });
    const signature = sign('sha256', Buffer.from(message), {
      key: privateKey,
      dsaEncoding: 'der',
    });
    const key = readApprovalKey(
      publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    )!;
    const { verify } =
      jest.requireActual<typeof import('node:crypto')>('node:crypto');
    expect(
      verify(
        'sha256',
        Buffer.from(message),
        { key, dsaEncoding: 'der' },
        signature,
      ),
    ).toBe(true);
  });
});

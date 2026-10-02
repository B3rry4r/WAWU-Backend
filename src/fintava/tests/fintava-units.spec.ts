import { HttpException } from '@nestjs/common';
import { MoneyError } from '../../money/money-error';
import {
  FintavaAmountError,
  fintavaAmountToKobo,
  fintavaAmountToKoboOrNull,
  koboToFintavaAmount,
} from '../fintava-amount';
import {
  FINTAVA_SANDBOX_BASE_URL,
  FintavaConfigError,
  readFintavaSettings,
} from '../fintava-config';
import {
  classifyFintavaFailure,
  FintavaError,
  maskFintavaText,
  readFintavaMessages,
} from '../fintava-error';
import { toFintavaLocalPhone } from '../fintava-client';
import { decideFintavaRetry } from '../fintava-reconcile';
import type {
  FintavaReconciliation,
  FintavaTransaction,
} from '../fintava.interface';

/** MONEY-06: the pure parts of the Fintava client. */

describe('Fintava amounts: naira at the boundary, kobo everywhere else', () => {
  it.each([
    ['100.00', 10000],
    ['5.00', 500],
    ['900', 90000],
    ['0', 0],
    ['2.5', 250],
    [' 12.34 ', 1234],
    [49960, 4996000],
    [2.75, 275],
    [7.5, 750],
    [0, 0],
    [-10, -1000],
  ])('reads %p as %p kobo', (naira, kobo) => {
    expect(fintavaAmountToKobo(naira)).toBe(kobo);
  });

  it.each([
    ['1.234'],
    ['1e3'],
    ['abc'],
    [''],
    ['12,000'],
    [0.1 + 0.2],
    [1e21],
    [Number.NaN],
    [Infinity],
    [null],
    [undefined],
    [{}],
    ['99999999999999999'],
  ])('refuses %p rather than rounding it', (bad) => {
    expect(() => fintavaAmountToKobo(bad)).toThrow(FintavaAmountError);
  });

  it('keeps an absent amount null', () => {
    expect(fintavaAmountToKoboOrNull(null)).toBeNull();
    expect(fintavaAmountToKoboOrNull(undefined)).toBeNull();
    expect(fintavaAmountToKoboOrNull('7.50')).toBe(750);
  });

  it.each([
    [1000, 10],
    [1050, 10.5],
    [1, 0.01],
    [29, 0.29],
    [30000, 300],
    [100000000000, 1000000000],
  ])('writes %p kobo as %p naira', (kobo, naira) => {
    expect(koboToFintavaAmount(kobo)).toBe(naira);
    // What JSON carries reads back as exactly the same kobo.
    expect(fintavaAmountToKobo(JSON.parse(JSON.stringify(naira)))).toBe(kobo);
  });

  it.each([[0], [-5], [1.5], [Number.MAX_SAFE_INTEGER + 2]])(
    'refuses to send %p kobo',
    (kobo) => {
      expect(() => koboToFintavaAmount(kobo)).toThrow(RangeError);
    },
  );
});

describe('Fintava settings: sandbox by default, live from config only', () => {
  const read = (values: Record<string, string>, nodeEnv = 'test') =>
    readFintavaSettings((k) => values[k], nodeEnv);

  it('uses the sandbox when FINTAVA_BASE_URL is not set', () => {
    const s = read({});
    expect(s.baseUrl).toBe(FINTAVA_SANDBOX_BASE_URL);
    expect(s.environment).toBe('sandbox');
    expect(s).toEqual({
      baseUrl: 'https://dev.fintavapay.com/api/dev',
      environment: 'sandbox',
      readTimeoutMs: 15000,
      moneyTimeoutMs: 30000,
      checkTimeoutMs: 30000,
      resendSafetyMs: 600000,
    });
  });

  it('reaches live only when config names it', () => {
    const s = read({
      FINTAVA_BASE_URL: 'https://live.fintavapay.com/api/dev/',
    });
    expect(s.environment).toBe('live');
    expect(s.baseUrl).toBe('https://live.fintavapay.com/api/dev');
  });

  it('refuses to guess in production', () => {
    expect(() => read({}, 'production')).toThrow(FintavaConfigError);
    expect(() =>
      read({ FINTAVA_BASE_URL: 'http://127.0.0.1:9/api/dev' }, 'production'),
    ).toThrow(FintavaConfigError);
  });

  it.each([
    ['https://example.com/api/dev'],
    ['http://dev.fintavapay.com/api/dev'],
    ['https://dev.fintavapay.com.evil.example/api/dev'],
    ['https://user:pw@dev.fintavapay.com/api/dev'],
    ['https://dev.fintavapay.com/api/dev?x=1'],
    ['not a url'],
  ])('never sends the key to %p', (url) => {
    expect(() => read({ FINTAVA_BASE_URL: url })).toThrow(FintavaConfigError);
  });

  it.each([
    ['constructor'],
    ['__proto__'],
    ['toString'],
    ['hasOwnProperty'],
    ['valueOf'],
    ['isPrototypeOf'],
  ])(
    'refuses the object-key host https://%s, in test and in production',
    (host) => {
      for (const env of ['test', 'production']) {
        expect(() =>
          read({ FINTAVA_BASE_URL: `https://${host}/api/dev` }, env),
        ).toThrow(FintavaConfigError);
      }
    },
  );

  it('reads the resend safety window, never below a minute', () => {
    expect(read({ FINTAVA_RESEND_SAFETY_MS: '120000' }).resendSafetyMs).toBe(
      120000,
    );
    for (const bad of ['0', '59999', 'soon', '-1']) {
      expect(() => read({ FINTAVA_RESEND_SAFETY_MS: bad })).toThrow(
        FintavaConfigError,
      );
    }
  });

  it('allows a double on this machine outside production', () => {
    expect(
      read({ FINTAVA_BASE_URL: 'http://127.0.0.1:4555/api/dev' }),
    ).toMatchObject({
      environment: 'local',
      baseUrl: 'http://127.0.0.1:4555/api/dev',
    });
  });

  it('reads the timeouts and refuses nonsense', () => {
    expect(
      read({
        FINTAVA_TIMEOUT_MS: '2000',
        FINTAVA_MONEY_TIMEOUT_MS: '40000',
        FINTAVA_CHECK_TIMEOUT_MS: '9000',
      }),
    ).toMatchObject({
      readTimeoutMs: 2000,
      moneyTimeoutMs: 40000,
      checkTimeoutMs: 9000,
    });
    for (const bad of ['0', '-1', '1.5', 'soon', '999999999']) {
      expect(() => read({ FINTAVA_TIMEOUT_MS: bad })).toThrow(
        FintavaConfigError,
      );
    }
  });
});

describe('Fintava error bodies: string, array and nested messages', () => {
  it('reads every shape the sandbox and the docs show', () => {
    expect(readFintavaMessages({ status: 400, message: ['a', 'b'] })).toEqual({
      messages: ['a', 'b'],
      nested: false,
    });
    expect(
      readFintavaMessages({
        status: 400,
        message: {
          statusCode: 400,
          message: ['x should not be empty'],
          error: 'Bad Request',
        },
      }),
    ).toEqual({ messages: ['x should not be empty'], nested: true });
    expect(
      readFintavaMessages({
        statusCode: 401,
        message: 'Invalid API Key',
        error: 'Unauthorized',
      }),
    ).toEqual({ messages: ['Invalid API Key'], nested: false });
    expect(
      readFintavaMessages({
        statusCode: 400,
        message: { message: 'one string' },
      }),
    ).toEqual({ messages: ['one string'], nested: true });
    expect(readFintavaMessages('<html>')).toEqual({
      messages: [],
      nested: false,
    });
    expect(readFintavaMessages(null)).toEqual({ messages: [], nested: false });
  });

  it('never keeps `path`, which echoes a BVN from the query', () => {
    const { messages } = classifyFintavaFailure({
      httpStatus: 400,
      body: {
        status: 400,
        message: ['Invalid BVN or BVN does not exist'],
        path: '/api/dev/compliance/verify/bvn?bvn=22212345678',
      },
      call: 'check',
    });
    expect(JSON.stringify(messages)).not.toContain('22212345678');
  });

  it('masks any run of 8 or more characters of a secret, not just all of it', () => {
    const key = 'live_sk_Zq9Xw7Vb5Nm3Lk1Jh8Gf6Ds4Ap2';
    expect(maskFintavaText(`echo ${key.slice(0, 20)} end`, [key])).toBe(
      'echo [secret] end',
    );
    expect(maskFintavaText(`mid ${key.slice(10, 18)}!`, [key])).toBe(
      'mid [secret]!',
    );
    // Seven characters in a row is not a run; a short tail is not either.
    expect(maskFintavaText(`x ${key.slice(3, 10)} y`, [key])).toBe(
      `x ${key.slice(3, 10)} y`,
    );
    expect(maskFintavaText('service not currently available', [key])).toBe(
      'service not currently available',
    );
  });

  it('masks an image echoed back (a run of 40 or more base64 characters), but not ordinary text (KYC-02)', () => {
    const image = `/9j/4AAQSkZJRgABAQ${'AAAQABAAD/2wBDAAgGBgcGBQgHBwcJ'.repeat(40)}==`;
    const masked = maskFintavaText(`Face not matched for image ${image}`);
    expect(masked).toBe('Face not matched for image [data]');
    expect(masked).not.toContain('/9j/');
    // 39 base64 characters in a row is not a run.
    const short = 'A'.repeat(39);
    expect(maskFintavaText(`ref ${short}`)).toBe(`ref ${short}`);
    expect(maskFintavaText('Request failed with status code 404')).toBe(
      'Request failed with status code 404',
    );
  });

  it('masks long digit runs and emails', () => {
    expect(maskFintavaText('BVN 22212345678 for ada@example.com')).toBe(
      'BVN *******5678 for ***@example.com',
    );
    expect(maskFintavaText('Airtime amount is less than 100')).toBe(
      'Airtime amount is less than 100',
    );
  });

  const cases: Array<
    [string, number, unknown, 'read' | 'write' | 'check', string]
  > = [
    [
      'no key',
      401,
      { status: 401, message: ['API Key is required'] },
      'read',
      'auth',
    ],
    [
      'a wrong key without live_ (400)',
      400,
      { status: 400, message: ['Invalid API key'] },
      'read',
      'auth',
    ],
    [
      'a wrong key with live_ (404)',
      404,
      { status: 404, message: ['Invalid API Key'] },
      'read',
      'auth',
    ],
    [
      'a wrong key on a send',
      400,
      { status: 400, message: ['Invalid API key'] },
      'write',
      'auth',
    ],
    [
      'the documented 401',
      401,
      { statusCode: 401, message: 'Invalid API Key', error: 'Unauthorized' },
      'write',
      'auth',
    ],
    [
      'an inactive merchant',
      403,
      { status: 403, message: ['Merchant is not active'] },
      'write',
      'merchant_inactive',
    ],
    [
      'a blacklisted NIN (403)',
      403,
      {
        status: 403,
        message: [
          'This NIN is blacklisted',
          'please contact support for assistance.',
        ],
      },
      'write',
      'identity_refused',
    ],
    [
      'validation',
      400,
      {
        status: 400,
        message: {
          statusCode: 400,
          message: ['amount must be a positive number'],
          error: 'Bad Request',
        },
      },
      'write',
      'validation',
    ],
    [
      'insufficient funds',
      400,
      {
        status: 400,
        message: [
          'Insufficient balance on source wallet to complete this transfer.',
        ],
      },
      'write',
      'insufficient_funds',
    ],
    [
      'a frozen wallet',
      400,
      {
        status: 400,
        message: ['Kindly confirm both customer accounts are active'],
      },
      'write',
      'wallet_inactive',
    ],
    [
      'a repeated reference (wallet to wallet)',
      400,
      { status: 400, message: ['customerReference already exists'] },
      'write',
      'duplicate_reference',
    ],
    [
      'a repeated reference (bank)',
      400,
      { status: 400, message: ['CustomerReference Already Exists'] },
      'write',
      'duplicate_reference',
    ],
    [
      'the payout blocker',
      400,
      { status: 400, message: ['Unable to find customers'] },
      'write',
      'payouts_blocked',
    ],
    [
      'airtime below ₦100',
      400,
      { status: 400, message: ['Airtime amount is less than 100'] },
      'write',
      'below_minimum',
    ],
    [
      'a wallet not found (400)',
      400,
      { status: 400, message: ['Wallet not found'] },
      'read',
      'not_found',
    ],
    [
      'no wallet for the customer (404)',
      404,
      { status: 404, message: ['No wallet exists for the customer'] },
      'write',
      'not_found',
    ],
    [
      'an unknown reference',
      404,
      { status: 404, message: ['Transaction not found!'] },
      'read',
      'not_found',
    ],
    [
      'an unknown BVN',
      400,
      { status: 400, message: ['Invalid BVN or BVN does not exist'] },
      'check',
      'identity_refused',
    ],
    [
      'a failed selfie',
      400,
      { status: 400, message: ['Request failed with status code 404'] },
      'check',
      'identity_refused',
    ],
    [
      'an unknown phone',
      400,
      { status: 400, message: ['Phone Number not Found'] },
      'check',
      'identity_refused',
    ],
    [
      'a leaked JS error',
      400,
      {
        status: 400,
        message: [
          "Cannot read properties of undefined (reading 'accountName')",
        ],
      },
      'read',
      'refused',
    ],
    [
      'a bad meter',
      400,
      { status: 400, message: ['Http Exception'] },
      'read',
      'refused',
    ],
    [
      'ECONNRESET on a send',
      500,
      { status: 500, message: ['read ECONNRESET'] },
      'write',
      'outcome_unknown',
    ],
    [
      'ECONNRESET on a read',
      500,
      { status: 500, message: ['read ECONNRESET'] },
      'read',
      'unavailable',
    ],
    [
      'a gateway page on a send',
      502,
      '<html>bad gateway</html>',
      'write',
      'outcome_unknown',
    ],
    [
      'a framework route 404 on a send',
      404,
      {
        statusCode: 404,
        message: 'Cannot POST /api/dev/bank/credit',
        error: 'Not Found',
      },
      'write',
      'outcome_unknown',
    ],
    ['an empty 404 on a send', 404, null, 'write', 'outcome_unknown'],
    ['an empty 404 on a read', 404, null, 'read', 'unavailable'],
    ['rate limited', 429, null, 'read', 'rate_limited'],
    [
      'cable "service not currently available" in a 201',
      201,
      { status: 200, message: 'service not currently available' },
      'write',
      'not_confirmed',
    ],
    ['an empty 2xx on a read', 200, {}, 'read', 'bad_response'],
  ];
  it.each(cases)('%s is %s %s', (_name, httpStatus, body, call, kind) => {
    expect(classifyFintavaFailure({ httpStatus, body, call }).kind).toBe(kind);
  });
});

describe('Fintava errors in the backend error shape', () => {
  const err = (kind: ConstructorParameters<typeof FintavaError>[0]['kind']) =>
    new FintavaError({ kind, operation: 'wallet to wallet', httpStatus: 400 });

  it.each([
    ['insufficient_funds', 402, 'insufficient_funds'],
    ['wallet_inactive', 423, 'wallet_frozen'],
    ['not_found', 404, 'not_found'],
    ['below_minimum', 400, 'amount_out_of_range'],
    ['auth', 503, 'provider_unreachable'],
    ['unavailable', 503, 'provider_unreachable'],
    ['outcome_unknown', 503, 'provider_unreachable'],
    ['payouts_blocked', 503, 'provider_unreachable'],
    ['duplicate_reference', 503, 'provider_unreachable'],
    ['not_configured', 503, 'provider_unreachable'],
  ] as const)('%s answers %s %s', (kind, status, code) => {
    const http = err(kind).toHttpException();
    expect(http).toBeInstanceOf(MoneyError);
    expect(http.getStatus()).toBe(status);
    const body = http.getResponse() as {
      message: string;
      reason: { code: string };
    };
    expect(body.reason.code).toBe(code);
    expect(body.message).not.toMatch(/fintava|loma|—/i);
  });

  it('an identity refusal is a plain 422', () => {
    const http = err('identity_refused').toHttpException();
    expect(http).toBeInstanceOf(HttpException);
    expect(http).not.toBeInstanceOf(MoneyError);
    expect(http.getStatus()).toBe(422);
  });

  it('a 503 says when to try again', () => {
    const body = err('unavailable').toHttpException().getResponse() as {
      reason: { retryAfterSeconds: number };
    };
    expect(body.reason.retryAfterSeconds).toBe(30);
  });

  it('marks what may have left a record', () => {
    expect(err('outcome_unknown').recordMayExist).toBe(true);
    expect(err('not_confirmed').recordMayExist).toBe(true);
    expect(err('duplicate_reference').recordMayExist).toBe(true);
    expect(err('insufficient_funds').recordMayExist).toBe(false);
  });
});

describe('phones in the form Fintava takes', () => {
  it.each([
    ['+2348031234567', '08031234567'],
    ['2348031234567', '08031234567'],
    ['08031234567', '08031234567'],
    ['8031234567', '08031234567'],
    ['+234 (803) 123-4567', '08031234567'],
    ['07012345678', '07012345678'],
  ])('%s is %s', (input, local) => {
    expect(toFintavaLocalPhone(input)).toBe(local);
  });
  it.each([['0803123456'], ['+14155550123'], ['06031234567'], ['']])(
    'refuses %p',
    (input) => {
      expect(toFintavaLocalPhone(input)).toBeNull();
    },
  );
});

describe('what may be done with a send whose answer was lost', () => {
  const t = (status: string): FintavaTransaction => ({
    id: 'id',
    createdAt: '2026-10-02T09:41:37.284Z',
    updatedAt: '2026-10-02T09:41:37.284Z',
    amountKobo: 1000,
    transType: 'AATRANSFER',
    entry: 'DEBIT',
    status,
    customerReference: 'REF',
    fintavaReference: 'x',
    tagapayTransRef: null,
    narration: null,
    senderDetails: null,
    recipientDetails: null,
    senderBank: null,
    receiverBank: null,
    sessionId: null,
    customerId: null,
    platformCommKobo: null,
    merchantCommKobo: null,
    lomaChargeKobo: null,
    meterToken: null,
    meterNumber: null,
    discoRef: null,
  });
  const attemptedAt = new Date('2026-10-02T10:00:00Z');
  const later = {
    attemptedAt,
    now: new Date('2026-10-02T10:05:00Z'),
    resendAfterMs: 30000,
  };
  const soon = {
    attemptedAt,
    now: new Date('2026-10-02T10:00:10Z'),
    resendAfterMs: 30000,
  };
  const found = (status: string): FintavaReconciliation => ({
    state: 'found',
    source: 'lookup',
    transaction: t(status),
  });

  it('never sends again what went through', () => {
    for (const kind of ['wallet_to_wallet', 'bank_transfer'] as const) {
      expect(decideFintavaRetry(kind, found('SUCCESS'), later).action).toBe(
        'settled',
      );
    }
  });

  it('waits on a pending send, never resends it', () => {
    for (const status of ['PENDING', 'ONGOING', 'SOMETHING_NEW']) {
      expect(decideFintavaRetry('bank_transfer', found(status), later)).toEqual(
        {
          action: 'wait',
          why: 'pending',
        },
      );
    }
  });

  it('a failed record has used its reference up', () => {
    expect(
      decideFintavaRetry('wallet_to_wallet', found('FAILURE'), later),
    ).toMatchObject({
      action: 'resend_new_reference',
      why: 'failed',
    });
    expect(
      decideFintavaRetry('bank_transfer', found('CANCELLED'), later).action,
    ).toBe('resend_new_reference');
  });

  it('absent: same reference for wallet to wallet, a new one for a bank send', () => {
    expect(
      decideFintavaRetry('wallet_to_wallet', { state: 'absent' }, later),
    ).toEqual({
      action: 'resend_same_reference',
    });
    expect(
      decideFintavaRetry('bank_transfer', { state: 'absent' }, later),
    ).toEqual({
      action: 'resend_new_reference',
      why: 'absent',
      transaction: null,
    });
  });

  it('absent inside the money timeout plus the safety window: wait', () => {
    const window = {
      attemptedAt,
      now: new Date('2026-10-02T10:09:00Z'),
      resendAfterMs: 30_000 + 600_000,
    };
    for (const kind of ['wallet_to_wallet', 'bank_transfer'] as const) {
      expect(decideFintavaRetry(kind, { state: 'absent' }, window)).toEqual({
        action: 'wait',
        why: 'too_soon',
      });
    }
  });

  it('absent too soon after sending is not proof: wait', () => {
    expect(
      decideFintavaRetry('wallet_to_wallet', { state: 'absent' }, soon),
    ).toEqual({
      action: 'wait',
      why: 'too_soon',
    });
  });

  it('a `{}` lookup is never "safe to resend"', () => {
    for (const kind of ['wallet_to_wallet', 'bank_transfer'] as const) {
      expect(
        decideFintavaRetry(
          kind,
          { state: 'unknown', why: 'empty_lookup' },
          later,
        ),
      ).toEqual({ action: 'wait', why: 'empty_lookup' });
      expect(
        decideFintavaRetry(
          kind,
          { state: 'unknown', why: 'unreachable' },
          later,
        ),
      ).toEqual({ action: 'wait', why: 'unreachable' });
    }
  });
});

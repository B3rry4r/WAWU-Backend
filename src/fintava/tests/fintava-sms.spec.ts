import { Logger } from '@nestjs/common';
import {
  FintavaDouble,
  fintavaConfig,
  fintavaError,
  fintavaValidation,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';

/**
 * `FintavaClient.sendSms` (task MONEY-14: the PIN reset code), over a socket
 * to the stand-in. What the sandbox really answered is in the mobile repo's
 * `docs/fintava/sandbox/35-money14-pin-reset.md`: a `400` business error
 * ("amount must be greater than or equal to 1") for the documented example
 * number, and a nested validation `400` for a number without its country
 * code. The reference page documents `200 {}` for a text sent.
 */

const KEY = 'live_test_m14_sms_0123456789FAKEKEY';
const TEXT = 'Your code is 482913. It expires in 5 minutes.';
const double = new FintavaDouble();

function client(extra: Record<string, string> = {}): FintavaClient {
  return new FintavaClient(
    fintavaConfig({
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: KEY,
      FINTAVA_MONEY_TIMEOUT_MS: '2000',
      ...extra,
    }),
  );
}

async function failure(p: Promise<unknown>): Promise<FintavaError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FintavaError) return e;
    throw e;
  }
  throw new Error('expected a FintavaError');
}

const logged: string[] = [];
beforeAll(async () => {
  await double.start();
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
  }
});
afterAll(async () => {
  jest.restoreAllMocks();
  await double.stop();
});
beforeEach(() => double.reset());

describe('FintavaClient.sendSms', () => {
  it('posts { to, sms } with the country code and the key, and resolves on 200 {}', async () => {
    double.on('POST', '/sms/send', { status: 200, body: {} });
    await client().sendSms('0803 123 4412', TEXT);
    expect(double.seen).toHaveLength(1);
    const seen = double.seen[0];
    expect(seen.body).toEqual({ to: '+2348031234412', sms: TEXT });
    expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('refuses a number that is not a Nigerian mobile before sending anything', async () => {
    const e = await failure(client().sendSms('+447700900123', TEXT));
    expect(e.kind).toBe('validation');
    expect(e.recordMayExist).toBe(false);
    expect(double.seen).toHaveLength(0);
  });

  it("the sandbox's refusal is a text that was not sent, and the code is in no message or log", async () => {
    double.on('POST', '/sms/send', {
      status: 400,
      body: fintavaError(400, 'amount must be greater than or equal to 1'),
    });
    const e = await failure(client().sendSms('+2349036652198', TEXT));
    expect(e.kind).toBe('refused');
    expect(e.recordMayExist).toBe(false);
    expect(e.httpStatus).toBe(400);
  });

  it('a refusal that echoes the text has the text and its code masked out', async () => {
    double.on('POST', '/sms/send', {
      status: 400,
      body: fintavaValidation(`sms "${TEXT}" is too long`),
    });
    logged.length = 0;
    const e = await failure(client().sendSms('+2349036652198', TEXT));
    expect(e.kind).toBe('validation');
    const everything = [...e.messages, e.message, ...logged].join('\n');
    expect(everything).not.toContain('482913');
    expect(everything).not.toContain(TEXT);
  });

  it('a 2xx whose body carries an error status was not sent', async () => {
    double.on('POST', '/sms/send', {
      status: 201,
      body: { status: 400, message: 'service not currently available' },
    });
    const e = await failure(client().sendSms('+2349036652198', TEXT));
    expect(e.kind).toBe('refused');
    expect(e.recordMayExist).toBe(false);
  });

  it('a 5xx, a dropped connection or no answer in time may have sent it: outcome_unknown', async () => {
    double.on('POST', '/sms/send', {
      status: 502,
      body: '<html>bad gateway</html>',
    });
    expect((await failure(client().sendSms('+2349036652198', TEXT))).kind).toBe(
      'outcome_unknown',
    );
    double.on('POST', '/sms/send', { status: 200, hangUp: true });
    expect((await failure(client().sendSms('+2349036652198', TEXT))).kind).toBe(
      'outcome_unknown',
    );
    double.on('POST', '/sms/send', { status: 200, body: {}, delayMs: 2_500 });
    const late = await failure(client().sendSms('+2349036652198', TEXT));
    expect(late.kind).toBe('outcome_unknown');
    expect(late.recordMayExist).toBe(true);
  });

  it('without a key nothing is sent', async () => {
    const unconfigured = new FintavaClient(fintavaConfig({}));
    const e = await failure(unconfigured.sendSms('+2349036652198', TEXT));
    expect(['not_configured']).toContain(e.kind);
    expect(double.seen).toHaveLength(0);
  });
});

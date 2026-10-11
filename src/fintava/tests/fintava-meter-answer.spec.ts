import {
  FintavaDouble,
  fintavaConfig,
  fintavaError,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';
import { readMeterAnswer } from '../fintava-meter-answer';
import {
  NOT_GREEN_BODIES,
  PLACEHOLDER_NAMES,
} from '../../../test/bills/not-green-bodies';

/**
 * How the Fintava client reads a meter preview (BILLS-01 round 2, D2). The success body has never been seen (question
 * 11), so "found" needs an owner's name under a key a person's name is kept under, in the `data` object, and nothing
 * else counts: not a 2xx that carries Fintava's own failure, not a body that names no one, not a body the client
 * cannot read. Fintava styles a failure inside a 2xx (`sandbox/21-`: `201 { status: 200, message: "service not
 * currently available" }`; a `200` whose body says `status: 400`).
 */

describe('readMeterAnswer: the body of a 2xx preview', () => {
  const owner = (data: Record<string, unknown>, more = {}) => ({
    status: 200,
    message: 'Meter details fetched',
    data,
    ...more,
  });

  it.each([
    ['Customer_Name', { Customer_Name: 'Ada Eze' }],
    ['customerName', { customerName: 'Ada Eze' }],
    ['name', { name: 'Ada Eze' }],
    ['CUSTOMER NAME', { 'CUSTOMER NAME': 'Ada Eze' }],
    ['accountName', { accountName: 'Ada Eze' }],
    ['consumer-name', { 'consumer-name': 'Ada Eze' }],
    ['fullName', { fullName: 'Ada Eze' }],
    ['customerFullName', { customerFullName: 'Ada Eze' }],
  ])('names an owner from the key %s', (_k, data) => {
    expect(readMeterAnswer(owner(data))).toMatchObject({
      kind: 'owner',
      name: 'Ada Eze',
      address: null,
    });
  });

  it.each([
    ['address', { address: '1 Road' }],
    ['customerAddress', { customerAddress: '1 Road' }],
    ['Consumer_Address', { Consumer_Address: '1 Road' }],
    ['service address', { 'service address': '1 Road' }],
  ])('reads the address from the key %s', (_k, extra) => {
    expect(readMeterAnswer(owner({ name: 'Ada Eze', ...extra }))).toMatchObject(
      { kind: 'owner', name: 'Ada Eze', address: '1 Road' },
    );
  });

  it('trims the name and the address, and an empty address is none', () => {
    expect(
      readMeterAnswer(owner({ name: '  Ada Eze ', address: '   ' })),
    ).toMatchObject({ kind: 'owner', name: 'Ada Eze', address: null });
  });

  it.each([
    ['a string', 'x'],
    ['a number', 1],
    ['an array', [{ name: 'A' }]],
    ['true', true],
  ])('cannot read data that is %s', (_k, data) => {
    expect(readMeterAnswer({ status: 200, data })).toEqual({
      kind: 'unreadable',
    });
  });

  it.each([
    ['no data at all', { status: 200, message: 'ok' }],
    ['an owner beside, not inside, data', { status: 200, name: 'Ada Eze' }],
    ['an object with no name key', owner({ meter: '0412', units: 5 })],
    ['a nested owner', owner({ customer: { name: 'Ada Eze' } })],
    ['a name that is a number', owner({ name: 12345 })],
    ['a name that is an object', owner({ name: { first: 'Ada' } })],
    ['a name that is blank', owner({ name: '   ' })],
  ])('cannot read a body with %s', (_k, body) => {
    expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['null', null],
    ['text', '<html>nope</html>'],
    ['an array', [1]],
    ['a number', 7],
  ])('cannot read a body that is %s', (_k, body) => {
    expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['null', { status: 200, data: null }],
    ['an empty object', { status: 200, data: {} }],
  ])(
    'names no one when data is %s: Fintava has no one on that meter',
    (_k, body) => {
      expect(readMeterAnswer(body)).toEqual({ kind: 'not_found' });
    },
  );

  it.each([
    ['"service not currently available"', 'service not currently available'],
    ['"Service Not Currently Available."', 'Service Not Currently Available.'],
    ['"service unavailable"', 'service unavailable'],
    ['"temporarily unavailable"', 'This is temporarily unavailable'],
  ])('is the bills service saying it is off: %s', (_k, message) => {
    expect(readMeterAnswer({ status: 200, message })).toEqual({
      kind: 'service_unavailable',
    });
    // Even with an owner beside it: a body that contradicts itself is not green.
    expect(
      readMeterAnswer({ status: 200, message, data: { name: 'Ada Eze' } }),
    ).toEqual({ kind: 'service_unavailable' });
  });

  it.each([
    [
      'status 400 "Meter not found"',
      { status: 400, message: 'Meter not found' },
    ],
    [
      'a message "Meter not found" beside status 200',
      { status: 200, message: 'Meter not found', data: null },
    ],
    ['a message list', { status: 200, message: ['Invalid meter number'] }],
    [
      'an owner beside "meter not found"',
      { status: 200, message: 'meter not found', data: { name: 'Ada Eze' } },
    ],
    ['status 404 "no such meter"', { status: 404, message: 'no such meter' }],
  ])('is no such meter: %s', (_k, body) => {
    expect(readMeterAnswer(body)).toEqual({ kind: 'not_found' });
  });

  it.each([
    ['a status 400 "Http Exception"', 400, 'Http Exception', 'refused'],
    ['a status 401', 401, 'Invalid API key', 'auth'],
    ['a status 403', 403, 'Merchant is not active', 'merchant_inactive'],
    ['a status 429', 429, 'Too many requests', 'rate_limited'],
    ['a status 500', 500, 'read ECONNRESET', 'unavailable'],
  ])(
    'is the failure Fintava would have sent as a real status: %s',
    (_k, status, message, failure) => {
      const got = readMeterAnswer({ status, message: [message] });
      expect(got).toMatchObject({ kind: 'failed', failure, status });
    },
  );

  it('reads a status that is text too', () => {
    expect(
      readMeterAnswer({ status: '401', message: ['Invalid API key'] }),
    ).toMatchObject({ kind: 'failed', failure: 'auth' });
  });

  it('does not take a status below 400 for a failure', () => {
    expect(
      readMeterAnswer({ status: 201, data: { name: 'Ada Eze' } }),
    ).toMatchObject({ kind: 'owner' });
  });
});

describe('readMeterAnswer: what is never a green found meter (BILLS-01 round 3, R2-1)', () => {
  const owner = (data: Record<string, unknown>, more = {}) => ({
    status: 200,
    message: 'Meter details fetched',
    data,
    ...more,
  });

  it('has the verifier’s 22 bodies, no more and no fewer', () => {
    expect(NOT_GREEN_BODIES).toHaveLength(22);
  });

  it.each(NOT_GREEN_BODIES)(
    'cannot read %s as a meter found',
    (_label, body) => {
      expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
    },
  );

  describe('a name that is a placeholder or a failure word', () => {
    it.each(PLACEHOLDER_NAMES)('%s', (name) => {
      expect(readMeterAnswer(owner({ Customer_Name: name }))).toEqual({
        kind: 'unreadable',
      });
    });

    it.each([
      ['capitals', 'N/a'],
      ['all capitals', 'UNKNOWN'],
      ['all small', 'meter not found'],
      ['spaces round it', '   Unknown   '],
      ['spaces inside it', 'Customer   not   found'],
      ['a full stop after it', 'Unknown.'],
      ['an exclamation mark after it', 'N/A!'],
      ['a question mark after it', 'Unknown?'],
      ['a colon after it', 'Unknown:'],
      ['a semicolon after it', 'Unknown;'],
      ['a comma after it', 'Unknown,'],
      ['several marks after it', 'Unknown...'],
      ['a failure word', 'Failed'],
      ['a long gap between words', 'Not        Available'],
      ['a tab between words', 'Not\tAvailable'],
      ['an invisible character inside it', 'Un\u200bknown'],
      ['a no-break space', 'Not\u00a0Available'],
      ['"none"', 'None'],
      ['"nil"', 'nil'],
      ['a failure sentence', 'Invalid meter number supplied'],
      ['"service not currently available"', 'Service not currently available'],
    ])('is a placeholder with %s', (_k, name) => {
      expect(readMeterAnswer(owner({ name }))).toEqual({ kind: 'unreadable' });
    });

    it.each([
      'Ada Unknown Eze',
      'Nil Okoro',
      'Null Obi',
      'Chidinma Okoro',
      'Ọlá Adéwálé',
    ])('still names the owner %s', (name) => {
      expect(readMeterAnswer(owner({ name }))).toMatchObject({
        kind: 'owner',
        name,
      });
    });
  });

  describe('a name that is blank once invisible characters are taken out', () => {
    it.each([
      ['a zero-width space', '\u200b'],
      ['a zero-width non-joiner', '\u200c'],
      ['a zero-width joiner', '\u200d'],
      ['a byte order mark', '\ufeff'],
      ['a soft hyphen', '\u00ad'],
      ['a word joiner', '\u2060'],
      ['a no-break space', '\u00a0'],
      ['a line separator', '\u2028'],
      ['a tab and a newline', '\t\n'],
      ['a Braille blank', '\u2800'],
      ['a Hangul filler', '\u3164'],
      ['a Hangul choseong filler', '\u115f'],
      ['a Hangul jungseong filler', '\u1160'],
      ['a halfwidth Hangul filler', '\uffa0'],
      ['a combining grapheme joiner', '\u034f'],
      ['several kinds together', ' \u200b\u2800\u3164\ufeff\u00a0 '],
    ])('%s is no name', (_k, name) => {
      expect(readMeterAnswer(owner({ name }))).toEqual({ kind: 'unreadable' });
    });

    it('an address of invisible characters is no address', () => {
      expect(
        readMeterAnswer(owner({ name: 'Ada Eze', address: '\u200b\u2800' })),
      ).toMatchObject({ kind: 'owner', name: 'Ada Eze', address: null });
    });

    it('skips a blank name key and reads the next one that holds a name', () => {
      expect(
        readMeterAnswer(owner({ Customer_Name: '\u200b', name: 'Ada Eze' })),
      ).toMatchObject({ kind: 'owner', name: 'Ada Eze' });
    });
  });

  describe('a body that flags a failure beside a name', () => {
    const named = { name: 'Ada Eze' };
    it.each([
      ['success false', { success: false, data: named }],
      ['success "false"', { success: 'false', data: named }],
      ['error true', { error: true, data: named }],
      ['error text', { error: 'oops', data: named }],
      ['error object', { error: { code: 1 }, data: named }],
      ['error 1', { error: 1, data: named }],
      ['data.error true', { data: { ...named, error: true } }],
      ['data.error text', { data: { ...named, error: 'oops' } }],
      ['statusCode 400', { statusCode: 400, data: named }],
      ['statusCode 404', { statusCode: 404, data: named }],
      ['statusCode 499', { statusCode: 499, data: named }],
      ['statusCode 500', { statusCode: 500, data: named }],
      ['statusCode 599', { statusCode: 599, data: named }],
      ['statusCode "500" as text', { statusCode: '500', data: named }],
      ['data.statusCode 500', { data: { ...named, statusCode: 500 } }],
      ['status "failed"', { status: 'failed', data: named }],
      ['status "Failed" in capitals', { status: 'Failed', data: named }],
      ['status " failure "', { status: ' failure ', data: named }],
      ['status "error"', { status: 'ERROR', data: named }],
      ['data.status "failed"', { data: { ...named, status: 'failed' } }],
      ['data.status "error"', { data: { ...named, status: 'Error' } }],
      ['data.status 400', { data: { ...named, status: 400 } }],
      ['data.status 500', { data: { ...named, status: 500 } }],
    ])('%s is not green', (_k, body) => {
      expect(readMeterAnswer(body)).toEqual({ kind: 'unreadable' });
    });

    it.each([
      ['success true', { success: true, data: named }],
      ['error false', { error: false, data: named }],
      ['error null', { error: null, data: named }],
      ['error empty text', { error: '', data: named }],
      ['error 0', { error: 0, data: named }],
      ['data.error null', { data: { ...named, error: null } }],
      ['statusCode 200', { statusCode: 200, data: named }],
      ['statusCode 399', { statusCode: 399, data: named }],
      ['status "success"', { status: 'success', data: named }],
      ['status "ok"', { status: 'ok', data: named }],
      ['data.status "active"', { data: { ...named, status: 'active' } }],
      ['data.status 200', { data: { ...named, status: 200 } }],
      ['data.status 399', { data: { ...named, status: 399 } }],
    ])('%s is still green', (_k, body) => {
      expect(readMeterAnswer(body)).toMatchObject({
        kind: 'owner',
        name: 'Ada Eze',
      });
    });

    it('answers "no such meter" or "service off" first when the body says so too', () => {
      expect(
        readMeterAnswer({
          error: true,
          message: 'Meter not found',
          data: named,
        }),
      ).toEqual({ kind: 'not_found' });
      expect(
        readMeterAnswer({
          success: false,
          message: 'service not currently available',
          data: named,
        }),
      ).toEqual({ kind: 'service_unavailable' });
    });
  });

  describe('which name key wins, and what an empty data array is (round 2 test gaps V5 and V6)', () => {
    it('an empty data array is unreadable, not nobody', () => {
      expect(readMeterAnswer({ status: 200, data: [] })).toEqual({
        kind: 'unreadable',
      });
    });

    it('takes the first of the name keys in this order: customer name, name, account name, consumer name, full name', () => {
      const order = [
        ['Customer_Name', 'A'],
        ['name', 'B'],
        ['accountName', 'C'],
        ['consumerName', 'D'],
        ['fullName', 'E'],
        ['customerFullName', 'F'],
      ] as const;
      for (let i = 0; i < order.length; i += 1) {
        const data = Object.fromEntries(order.slice(i));
        // Written in reverse, so the object’s own order cannot be what decides.
        const reversed = Object.fromEntries(Object.entries(data).reverse());
        expect(readMeterAnswer(owner(reversed))).toMatchObject({
          kind: 'owner',
          name: order[i][1],
        });
      }
    });

    it('takes the first of the address keys in this order', () => {
      const keys = [
        'address',
        'customerAddress',
        'consumerAddress',
        'serviceAddress',
      ];
      for (let i = 0; i < keys.length; i += 1) {
        // Written in reverse, so the object’s own order cannot be what decides.
        const data = Object.fromEntries(
          keys
            .slice(i)
            .map((k, j) => [k, String(i + j + 1)])
            .reverse(),
        ) as Record<string, string>;
        expect(
          readMeterAnswer(owner({ name: 'Ada Eze', ...data })),
        ).toMatchObject({ address: String(i + 1) });
      }
    });
  });
});

describe('FintavaClient.previewMeter reads the answer over the wire', () => {
  const double = new FintavaDouble();
  const client = () =>
    new FintavaClient(
      fintavaConfig({
        FINTAVA_BASE_URL: double.baseUrl,
        FINTAVA_API_KEY: 'live_test_meter_0123456789FAKEKEY',
      }),
    );
  const ask = () =>
    client().previewMeter({
      meterNumber: '04123456789',
      disco: 'AEDC',
      planType: 'prepaid',
    });
  const answer = (status: number, body: unknown) =>
    double.on('POST', '/billing/preview-meter', { status, body });
  const failure = async (p: Promise<unknown>): Promise<FintavaError> => {
    try {
      await p;
    } catch (e) {
      return e as FintavaError;
    }
    throw new Error('expected a FintavaError');
  };

  beforeAll(() => double.start());
  afterAll(() => double.stop());
  beforeEach(() => double.reset());

  it('gives the owner and the address for a body that names one', async () => {
    answer(200, {
      data: { Customer_Name: 'Chidinma Okoro', Address: '14 Admiralty Way' },
      status: 200,
    });
    expect(await ask()).toMatchObject({
      ownerName: 'Chidinma Okoro',
      ownerAddress: '14 Admiralty Way',
    });
  });

  it('keeps the address out of `details`, which drops address fields on purpose', async () => {
    answer(200, {
      data: { customerName: 'Ada Eze', address: '14 Admiralty Way', units: 5 },
      status: 200,
    });
    expect((await ask())?.details).toEqual({
      customerName: 'Ada Eze',
      units: 5,
    });
  });

  it('is null for a 2xx that says no such meter, as for the bare 400', async () => {
    answer(200, { status: 400, message: 'Meter not found', data: null });
    expect(await ask()).toBeNull();
  });

  it('is null for a 2xx that names no one', async () => {
    answer(200, { status: 200, data: {} });
    expect(await ask()).toBeNull();
  });

  it('is a FintavaError marked `serviceNotAvailable` for a 201 "service not currently available"', async () => {
    answer(201, { status: 201, message: 'service not currently available' });
    const e = await failure(ask());
    expect(e).toBeInstanceOf(FintavaError);
    expect(e.kind).toBe('unavailable');
    expect(e.serviceNotAvailable).toBe(true);
    expect(e.httpStatus).toBe(201);
  });

  it('marks nothing else as `serviceNotAvailable`', async () => {
    answer(500, fintavaError(500, 'read ECONNRESET'));
    const e = await failure(ask());
    expect(e.kind).toBe('unavailable');
    expect(e.serviceNotAvailable).toBe(false);
  });

  it.each([
    ['data a string', 200, { data: 'x', status: 200 }],
    ['data an array', 200, { data: [{ name: 'A' }], status: 200 }],
    ['an object with no name', 200, { data: { units: 4 }, status: 200 }],
    ['no data', 200, { status: 200, message: 'ok' }],
    ['an HTML page', 200, '<html>bad gateway</html>'],
    ['JSON cut short', 200, '{"data": {"name": "Brok'],
    ['an empty body', 200, ''],
  ])(
    'is `bad_response` for %s, and logs nothing of it',
    async (_k, status, body) => {
      answer(status, body);
      const e = await failure(ask());
      expect(e.kind).toBe('bad_response');
      expect(e.messages.join(' ')).not.toMatch(/Brok|bad gateway/);
    },
  );

  it('turns a body that carries a real failure status into that failure', async () => {
    answer(200, { status: 403, message: ['Merchant is not active'] });
    expect((await failure(ask())).kind).toBe('merchant_inactive');
    answer(200, { status: 401, message: ['Invalid API key'] });
    expect((await failure(ask())).kind).toBe('auth');
    answer(200, { status: 500, message: ['read ECONNRESET'] });
    expect((await failure(ask())).kind).toBe('unavailable');
  });

  it('is null for a body that carries status 400 "Http Exception", as for the bare 400', async () => {
    answer(200, { status: 400, message: ['Http Exception'] });
    expect(await ask()).toBeNull();
  });
});

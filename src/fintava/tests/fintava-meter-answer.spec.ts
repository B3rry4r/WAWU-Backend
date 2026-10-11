import {
  FintavaDouble,
  fintavaConfig,
  fintavaError,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';
import { readMeterAnswer } from '../fintava-meter-answer';

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

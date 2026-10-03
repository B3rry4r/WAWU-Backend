import {
  CUSTOMER_A,
  CUSTOMER_BY_ID,
  CUSTOMER_DETAILS,
  FintavaDouble,
  fintavaConfig,
  fintavaError,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';

/**
 * The two customer reads account opening (MONEY-12) reconciles a lost
 * create with, through the real client against the local double:
 * `lookupCustomerByPhone` (three answers, `absent` only for Fintava's own
 * `404 ["Customer not found"]`, seen in the sandbox on 3 Oct 2026, mobile
 * repo `docs/fintava/sandbox/32-money12-account.md`) and
 * `listCustomerSightings` (who and when, from the newest-first list).
 */

const KEY = 'live_test_m12_lookup_0123456789FAKEKEY';
const double = new FintavaDouble();

function client(): FintavaClient {
  return new FintavaClient(
    fintavaConfig({ FINTAVA_BASE_URL: double.baseUrl, FINTAVA_API_KEY: KEY }),
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

beforeAll(() => double.start());
afterAll(() => double.stop());
beforeEach(() => double.reset());

describe('lookupCustomerByPhone', () => {
  it('found: details (no wallet) then the customer by id, phone sent in local form', async () => {
    double.on('GET', '/customers/details', {
      status: 200,
      body: CUSTOMER_DETAILS,
    });
    double.on('GET', `/customers/${CUSTOMER_A.customerId}`, {
      status: 200,
      body: CUSTOMER_BY_ID,
    });
    const out = await client().lookupCustomerByPhone('+2348031230101');
    expect(double.seen[0].query).toEqual({ phone: '08031230101' });
    expect(out.state).toBe('found');
    expect(out.state === 'found' && out.customer).toMatchObject({
      customerId: CUSTOMER_A.customerId,
      walletId: CUSTOMER_A.walletId,
      accountNumber: CUSTOMER_A.accountNumber,
    });
  });

  it('absent only for Fintava\'s own 404 ["Customer not found"] (the sandbox\'s body)', async () => {
    double.on('GET', '/customers/details', {
      status: 404,
      body: fintavaError(404, 'Customer not found'),
    });
    expect(await client().lookupCustomerByPhone('08031230101')).toEqual({
      state: 'absent',
    });
    expect(double.seen).toHaveLength(1);
  });

  it.each([
    [
      'a 404 with another message',
      404,
      fintavaError(404, 'No wallet exists for the customer'),
    ],
    [
      'a 404 with two messages',
      404,
      fintavaError(404, 'Customer not found', 'try again'),
    ],
    [
      'a framework 404',
      404,
      {
        statusCode: 404,
        message: 'Cannot GET /api/dev/customers/details',
        error: 'Not Found',
      },
    ],
    ['an empty 404', 404, ''],
    ['an HTML 404', 404, '<html>Not Found</html>'],
    ['a 500', 500, 'boom'],
    ['a key refused as 404', 404, fintavaError(404, 'Invalid API Key')],
  ])('%s is never absent: it throws', async (_name, status, body) => {
    double.on('GET', '/customers/details', { status, body });
    const e = await failure(client().lookupCustomerByPhone('08031230101'));
    expect(e).toBeInstanceOf(FintavaError);
  });

  it.each([
    ['{}', {}],
    ['data: null', { data: null, status: 200 }],
    ['data without userInfo', { data: { id: 'x' }, status: 200 }],
    ['userInfo without id', { data: { userInfo: {} }, status: 200 }],
  ])(
    'a 2xx without a customer (%s) is unknown, never absent',
    async (_n, body) => {
      double.on('GET', '/customers/details', { status: 200, body });
      expect(await client().lookupCustomerByPhone('08031230101')).toEqual({
        state: 'unknown',
        why: 'empty_answer',
      });
    },
  );

  it('a phone that is not a Nigerian mobile is refused before anything is sent', async () => {
    const e = await failure(client().lookupCustomerByPhone('+441234567890'));
    expect(e.kind).toBe('validation');
    expect(double.seen).toHaveLength(0);
  });
});

describe('listCustomerSightings', () => {
  const row = (id: string, phone: unknown, createdAt: unknown) => ({
    id: `record-${id}`,
    createdAt,
    phone,
    userInfo: { id, phoneNumber: phone, createdAt },
  });

  it('reads each row as customer id, local phone and time', async () => {
    double.on('GET', '/customers/list', {
      status: 200,
      body: {
        data: [
          row('c-1', '08031230101', '2026-10-03T05:00:00.000Z'),
          row('c-2', '+2348031230202', '2026-10-03T04:00:00.000Z'),
          { id: 'r-3', userInfo: { id: 'c-3' } },
        ],
        meta: {
          page: '2',
          take: '100',
          itemCount: 203,
          pageCount: 3,
          hasNextPage: true,
        },
        status: 200,
      },
    });
    const page = await client().listCustomerSightings({ page: 2, take: 100 });
    expect(double.seen[0].query).toEqual({ page: '2', take: '100' });
    expect(page).toMatchObject({ page: 2, take: 100, hasNextPage: true });
    expect(page.items).toEqual([
      {
        customerId: 'c-1',
        phone: '08031230101',
        createdAt: '2026-10-03T05:00:00.000Z',
      },
      {
        customerId: 'c-2',
        phone: '08031230202',
        createdAt: '2026-10-03T04:00:00.000Z',
      },
      { customerId: 'c-3', phone: null, createdAt: null },
    ]);
  });

  it('a row without a customer id makes the page unreadable', async () => {
    double.on('GET', '/customers/list', {
      status: 200,
      body: {
        data: [{ id: 'r', userInfo: { phoneNumber: '08031230101' } }],
        meta: { page: 1, take: 10, itemCount: 1, pageCount: 1 },
      },
    });
    const e = await failure(client().listCustomerSightings());
    expect(e.kind).toBe('bad_response');
  });
});

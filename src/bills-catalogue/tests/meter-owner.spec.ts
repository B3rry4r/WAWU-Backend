import {
  FintavaDouble,
  fintavaConfig,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../../fintava/fintava-client';

/**
 * What the Fintava client reads off a meter preview's success body (BILLS-01). The real body has never been seen (no
 * sandbox meter is known, question 11), so the keys are a list of likely ones read whatever their capitals or separators;
 * these tests pin that list, and that an unknown body gives nulls rather than a guess.
 */
const double = new FintavaDouble();
const client = () =>
  new FintavaClient(
    fintavaConfig({
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_owner_0123456789FAKEKEY',
    }),
  );
const ask = () =>
  client().previewMeter({
    meterNumber: '04123456789',
    disco: 'AEDC',
    planType: 'prepaid',
  });
const answer = (body: unknown) =>
  double.on('POST', '/billing/preview-meter', { status: 200, body });

beforeAll(() => double.start());
afterAll(() => double.stop());
beforeEach(() => double.reset());

describe('previewMeter reads the owner of a meter', () => {
  it.each([
    [
      'Customer_Name and Address',
      { Customer_Name: 'Chidinma Okoro', Address: '14 Admiralty Way' },
    ],
    [
      'customerName and customerAddress',
      { customerName: 'Chidinma Okoro', customerAddress: '14 Admiralty Way' },
    ],
    [
      'name and address',
      { name: 'Chidinma Okoro', address: '14 Admiralty Way' },
    ],
    [
      'CUSTOMER NAME and customer-address',
      {
        'CUSTOMER NAME': 'Chidinma Okoro',
        'customer-address': '14 Admiralty Way',
      },
    ],
    [
      'accountName and consumerAddress',
      { accountName: 'Chidinma Okoro', consumerAddress: '14 Admiralty Way' },
    ],
  ])('from %s', async (_label, data) => {
    answer({ data, status: 200 });
    const preview = await ask();
    expect(preview).toMatchObject({
      ownerName: 'Chidinma Okoro',
      ownerAddress: '14 Admiralty Way',
    });
  });

  it('trims the text, and reads a name that has no address', async () => {
    answer({ data: { name: '  Ada Eze ', address: '   ' }, status: 200 });
    expect(await ask()).toMatchObject({
      ownerName: 'Ada Eze',
      ownerAddress: null,
    });
  });

  it('reads the owner off the body itself when the answer has no data object', async () => {
    answer({ status: 200, message: 'ok', customerName: 'Ada Eze' });
    expect(await ask()).toMatchObject({
      ownerName: 'Ada Eze',
      ownerAddress: null,
    });
  });

  it('gives nulls for a body that names no owner, and for values that are not text', async () => {
    answer({
      data: { meter: '04123456789', name: 12345, address: { line: 'x' } },
      status: 200,
    });
    expect(await ask()).toMatchObject({ ownerName: null, ownerAddress: null });
  });

  it('keeps the address out of `details`, which drops address fields on purpose', async () => {
    answer({
      data: { customerName: 'Ada Eze', address: '14 Admiralty Way', units: 5 },
      status: 200,
    });
    const preview = await ask();
    expect(preview?.details).toEqual({ customerName: 'Ada Eze', units: 5 });
  });
});

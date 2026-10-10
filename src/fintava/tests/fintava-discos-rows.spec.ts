import {
  DISCOS,
  FintavaDouble,
  fintavaConfig,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../fintava-client';
import { FintavaError } from '../fintava-error';

/**
 * `GET /billing/discos` with a row Fintava got wrong (BILLS-01 round 2, D7): the row is skipped and the skip is logged,
 * and the rest of the list is still read. A list in which no row can be read is a list that cannot be read.
 */

const KEY = 'live_test_discos_0123456789FAKEKEY';
const double = new FintavaDouble();

describe('listDiscos with a malformed row', () => {
  const warned: string[] = [];
  const client = () => {
    const c = new FintavaClient(
      fintavaConfig({ FINTAVA_BASE_URL: double.baseUrl, FINTAVA_API_KEY: KEY }),
    );
    const logger = (c as unknown as { logger: { warn: (m: string) => void } })
      .logger;
    jest.spyOn(logger, 'warn').mockImplementation((m: string) => {
      warned.push(m);
    });
    return c;
  };
  const good = DISCOS.data[0];
  const rows = (...r: unknown[]) =>
    double.on('GET', '/billing/discos', {
      status: 200,
      body: { data: r, status: 200, message: 'Discos records fetched' },
    });

  beforeAll(() => double.start());
  afterAll(() => double.stop());
  beforeEach(() => {
    double.reset();
    warned.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['a null minimum', { ...good, code: 'Bad_One', minimum_value: null }],
    [
      'a minimum that is words',
      { ...good, code: 'Bad_One', minimum_value: 'ask' },
    ],
    [
      'a maximum of 3 decimals',
      { ...good, code: 'Bad_One', maximum_value: '1.005' },
    ],
    ['no code', { ...good, code: undefined }],
    ['a row that is a string', 'AEDC'],
    ['a row that is null', null],
  ])('skips a row with %s and reads the others', async (_k, bad) => {
    rows(good, bad, DISCOS.data[1]);
    const list = await client().listDiscos();
    expect(list.map((d) => d.code)).toEqual([good.code, DISCOS.data[1].code]);
  });

  it('logs the skip with the row’s place and code, never the row', async () => {
    rows(good, { ...good, code: 'Bad_One', minimum_value: 'SECRET-TEXT' });
    await client().listDiscos();
    const line = warned.join('\n');
    expect(line).toMatch(/list discos/);
    expect(line).toMatch(/skipped/);
    expect(line).toMatch(/Bad_One/);
    expect(line).not.toMatch(/SECRET-TEXT/);
  });

  it('keeps every good row when only the last is malformed', async () => {
    rows(...DISCOS.data, { code: 'X', minimum_value: null });
    expect(await client().listDiscos()).toHaveLength(DISCOS.data.length);
  });

  it('is still `bad_response` when no row can be read', async () => {
    rows({ ...good, minimum_value: null }, 'x');
    await expect(client().listDiscos()).rejects.toMatchObject({
      kind: 'bad_response',
    });
    rows({ ...good, minimum_value: null });
    await expect(client().listDiscos()).rejects.toBeInstanceOf(FintavaError);
  });

  it('is an empty list for an empty list, as before', async () => {
    rows();
    expect(await client().listDiscos()).toEqual([]);
  });

  it('is still `bad_response` when `data` is not a list', async () => {
    double.on('GET', '/billing/discos', {
      status: 200,
      body: { data: { not: 'a list' } },
    });
    await expect(client().listDiscos()).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});

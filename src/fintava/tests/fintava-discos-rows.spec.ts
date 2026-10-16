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

  describe('a company no amount fits (BILLS-01 round 3, R2-4)', () => {
    it.each([
      ['a negative minimum', { minimum_value: '-5', maximum_value: '777.77' }],
      ['a negative maximum', { minimum_value: '0', maximum_value: '-777.77' }],
      ['both limits negative', { minimum_value: '-9', maximum_value: '-5' }],
      [
        'a minimum above its maximum',
        { minimum_value: '900.5', maximum_value: '777.77' },
      ],
      [
        'a minimum a kobo above its maximum',
        { minimum_value: '777.78', maximum_value: '777.77' },
      ],
      [
        'a minimum of nothing and a maximum of nothing (R3-5)',
        { minimum_value: '0', maximum_value: '0' },
      ],
      [
        'a minimum of nothing and a maximum of nothing, written with kobo',
        { minimum_value: '0.00', maximum_value: '0.00' },
      ],
      [
        'a minimum above a maximum of nothing',
        { minimum_value: '5', maximum_value: '0' },
      ],
    ])('skips a row with %s and reads the others', async (_k, limits) => {
      rows(good, { ...good, code: 'Odd_One', ...limits }, DISCOS.data[1]);
      const list = await client().listDiscos();
      expect(list.map((d) => d.code)).toEqual([good.code, DISCOS.data[1].code]);
    });

    it.each([
      [
        'a minimum equal to its maximum',
        { minimum_value: '777', maximum_value: '777' },
      ],
      ['a minimum of nothing', { minimum_value: '0', maximum_value: '777.77' }],
      ['a maximum of one kobo', { minimum_value: '0', maximum_value: '0.01' }],
      [
        'kobo in both limits',
        { minimum_value: '1000.50', maximum_value: '1000.51' },
      ],
    ])('lists a row with %s', async (_k, limits) => {
      rows(good, { ...good, code: 'Odd_One', ...limits });
      const list = await client().listDiscos();
      expect(list.map((d) => d.code)).toEqual([good.code, 'Odd_One']);
    });

    it('warns once for each such row on each refresh, with its place and code and none of its amounts', async () => {
      const odd = (code: string, limits: Record<string, string>) => ({
        code,
        description: code,
        is_available: 'Yes',
        ...limits,
      });
      rows(
        good,
        odd('Neg_Row', { minimum_value: '-123.45', maximum_value: '777.77' }),
        odd('Inv_Row', { minimum_value: '987.65', maximum_value: '12.34' }),
      );
      const c = client();
      await c.listDiscos();
      const lines = warned.filter((l) => /skipped/.test(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/row 2 "Neg_Row"/);
      expect(lines[1]).toMatch(/row 3 "Inv_Row"/);
      expect(warned.join('\n')).not.toMatch(/123|777|987|12\.34|-/);
      // The next refresh warns again, once for each row, not once for the life of the process.
      await c.listDiscos();
      expect(warned.filter((l) => /skipped/.test(l))).toHaveLength(4);
    });

    it('is still `bad_response` when every row is one of them', async () => {
      rows({ ...good, minimum_value: '5', maximum_value: '1' });
      await expect(client().listDiscos()).rejects.toMatchObject({
        kind: 'bad_response',
      });
    });
  });

  it('never logs the values of a skipped row, however short its code (BILLS-01 round 2, survivor V18)', async () => {
    rows(good, {
      code: 'B1',
      minimum_value: 'SECRET-TEXT',
      maximum_value: '1',
    });
    await client().listDiscos();
    const line = warned.join('\n');
    expect(line).toMatch(/skipped row 2 "B1"/);
    expect(line).not.toMatch(/SECRET-TEXT|minimum_value|\{/);
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

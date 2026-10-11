import {
  SANDBOX_DISCO_ROWS,
  SANDBOX_DISCOS,
} from '../../../test/bills/sandbox-discos';
import {
  FintavaDouble,
  fintavaConfig,
} from '../../../test/fintava/fintava-double';
import { FintavaClient } from '../../fintava/fintava-client';
import {
  hasVisibleText,
  readMeterAnswer,
  withoutLeadingInvisible,
} from '../../fintava/fintava-meter-answer';
import type {
  FintavaDisco,
  FintavaMeterPreview,
} from '../../fintava/fintava.interface';
import {
  BillsCatalogueService,
  clipProviderText,
} from '../bills-catalogue.service';

/**
 * A provider text of millions of invisible characters (BILLS-01 hotfix 2). The pattern that took the invisible start off
 * a name, `^(?:\s|[...])+`, kept one entry on the regular expression engine's backtrack stack for every character it
 * matched, and the engine's stack is a fixed 64 MB, so a text of some millions threw `RangeError: Maximum call stack size
 * exceeded` out of the meter check instead of the answer `meter_unconfirmed`. It passed on the machine it was built on
 * (the limit there is about 8.4 million characters) and failed on the deploy's test runner at 5,000,000.
 *
 * These tests ask the same question of every function on the path with 1 MB and 5 MB of blanks, with and without a
 * visible name after them: it answers in under a second and never throws. A 12 MB case is above the limit on any machine
 * that has the old pattern, so it fails there however big its stack is; run the file small as well:
 * `node --stack-size=128 node_modules/.bin/jest --runInBand src/bills-catalogue/tests/invisible-flood.spec.ts`.
 */

const SECOND = 1000;

/** Each is a space or an invisible character the name rule knows; the last two are above U+FFFF (two UTF-16 units each). */
const BLANKS: [string, string][] = [
  ['zero-width spaces', '\u200b'],
  ['Braille blanks', '\u2800'],
  ['Hangul fillers', '\u3164'],
  ['spaces', ' '],
  ['byte order marks', '\ufeff'],
  ['no-break spaces', '\u00a0'],
  ['null controls', '\u0000'],
  ['tag characters', String.fromCodePoint(0xe0020)],
  ['musical symbol begin beam', String.fromCodePoint(0x1d173)],
];

/** Sizes in UTF-16 units: 1 MB and 5 MB of text, for every kind of blank. */
const SIZES: [string, number][] = [
  ['1 MB', 1_000_000],
  ['5 MB', 5_000_000],
];
/** 12 MB is above the engine's stack for the old pattern on any machine, so it is asked of three kinds of blank. */
const ABOVE_THE_ENGINES_STACK = 12_000_000;

/** `blank` repeated to about `units` UTF-16 units. */
const flood = (blank: string, units: number) =>
  blank.repeat(Math.ceil(units / blank.length));

/** Runs `fn`, and says how long it took in milliseconds. */
function timed<T>(fn: () => T): { value: T; took: number } {
  const started = Date.now();
  const value = fn();
  return { value, took: Date.now() - started };
}

describe.each(SIZES)('%s of invisible characters', (_label, units) => {
  describe.each(BLANKS)('%s', (_name, blank) => {
    // Built inside each test, so no more than one flood is alive at a time.
    const blanks = () => flood(blank, units);

    it('withoutLeadingInvisible: nothing when there is nothing to see, the name when there is one', () => {
      const none = timed(() => withoutLeadingInvisible(blanks()));
      expect(none.value).toBe('');
      expect(none.took).toBeLessThan(SECOND);
      const named = timed(() => withoutLeadingInvisible(`${blanks()}Ada Eze`));
      expect(named.value).toBe('Ada Eze');
      expect(named.took).toBeLessThan(SECOND);
    });

    it('hasVisibleText: no without a name, yes with one', () => {
      const none = timed(() => hasVisibleText(blanks()));
      expect(none.value).toBe(false);
      expect(none.took).toBeLessThan(SECOND);
      const named = timed(() => hasVisibleText(`${blanks()}Ada Eze`));
      expect(named.value).toBe(true);
      expect(named.took).toBeLessThan(SECOND);
    });

    it('clipProviderText: nothing without a name, the name with one', () => {
      const none = timed(() => clipProviderText(blanks()));
      expect(none.value).toBe('');
      expect(none.took).toBeLessThan(SECOND);
      const named = timed(() => clipProviderText(`${blanks()}Ada Eze`));
      expect(named.value).toBe('Ada Eze');
      expect(named.took).toBeLessThan(SECOND);
    });

    it('readMeterAnswer: reads the body without throwing, and never takes blanks for an owner', () => {
      for (const name of [blanks(), `${blanks()}Ada Eze`]) {
        const read = timed(() =>
          readMeterAnswer({
            status: 200,
            data: { customerName: name, address: blanks() },
          }),
        );
        expect(read.took).toBeLessThan(SECOND);
        // A name made of blanks only is no owner. A name behind a very long blank start is refused as well or read, but
        // the answer is one of these two and is never an error.
        expect(['unreadable', 'owner']).toContain(read.value.kind);
        if (!name.endsWith('Ada Eze'))
          expect(read.value.kind).toBe('unreadable');
      }
    });
  });
});

describe('12 MB of invisible characters (above the limit of the old pattern on any machine)', () => {
  it.each([
    ['zero-width spaces', '\u200b'],
    ['Braille blanks', '\u2800'],
    ['spaces', ' '],
  ])(
    '%s: every function on the path answers, in under two seconds together',
    (_name, blank) => {
      const blanks = flood(blank, ABOVE_THE_ENGINES_STACK);
      const named = `${blanks}Ada Eze`;
      const all = timed(() => [
        withoutLeadingInvisible(blanks),
        withoutLeadingInvisible(named),
        hasVisibleText(blanks),
        hasVisibleText(named),
        clipProviderText(blanks),
        clipProviderText(named),
        readMeterAnswer({ status: 200, data: { name: blanks } }).kind,
      ]);
      expect(all.value).toEqual([
        '',
        'Ada Eze',
        false,
        true,
        '',
        'Ada Eze',
        'unreadable',
      ]);
      expect(all.took).toBeLessThan(2 * SECOND);
      // Spaces are trimmed off a name, so the one behind them is read; invisible characters are not, and a name behind
      // this many is refused (the placeholder rule reads only its first 2,000 characters: R4-4). Either is an answer, not
      // an error.
      const read = timed(() =>
        readMeterAnswer({ status: 200, data: { name: named } }),
      );
      expect(['owner', 'unreadable']).toContain(read.value.kind);
      expect(read.took).toBeLessThan(SECOND);
    },
  );
});

describe('the meter check answers a flood of invisible characters, it does not throw', () => {
  const discos: FintavaDisco[] = SANDBOX_DISCO_ROWS.map((r) => ({
    code: r.code,
    description: r.description,
    minimumKobo: Number(r.minimum_value) * 100,
    maximumKobo: Number(r.maximum_value) * 100,
    available: r.is_available === 'Yes',
  }));

  /** The service on a client that answers a meter with `ownerName` and `ownerAddress` and the disco list as sandboxed. */
  const check = (ownerName: string, ownerAddress: string | null) => {
    const client = {
      listDiscos: () => Promise.resolve(discos),
      previewMeter: (): Promise<FintavaMeterPreview> =>
        Promise.resolve({ details: {}, ownerName, ownerAddress }),
    } as unknown as FintavaClient;
    const config = { get: () => undefined } as never;
    return new BillsCatalogueService(client, config).previewMeter('person-1', {
      code: 'AEDC',
      meterNumber: '04123456789',
    });
  };

  it.each(SIZES)(
    'is `meter_unconfirmed` for %s of invisible characters as the name',
    async (_label, units) => {
      const started = Date.now();
      await expect(check(flood('\u2800', units), 'x')).rejects.toMatchObject({
        code: 'meter_unconfirmed',
      });
      expect(Date.now() - started).toBeLessThan(SECOND);
    },
  );

  it.each(SIZES)(
    'is the name behind %s of invisible characters, and no address when the address is invisible characters only',
    async (_label, units) => {
      const started = Date.now();
      const got = await check(
        `${flood('\u200b', units)}Ada Eze`,
        flood('\u3164', units),
      );
      expect(got).toMatchObject({ name: 'Ada Eze', address: null });
      expect(Date.now() - started).toBeLessThan(SECOND);
    },
  );

  it.each([...SIZES, ['12 MB', ABOVE_THE_ENGINES_STACK]] as [string, number][])(
    'keeps the address behind %s of invisible characters',
    async (_label, units) => {
      const started = Date.now();
      const got = await check(
        'Ada Eze',
        `${flood('\u2800', units)}14 Admiralty Way`,
      );
      expect(got).toMatchObject({
        name: 'Ada Eze',
        address: '14 Admiralty Way',
      });
      expect(Date.now() - started).toBeLessThan(SECOND);
    },
  );
});

describe('over HTTP, through the real Fintava client and the service (5 MB each way)', () => {
  const double = new FintavaDouble();
  const service = () => {
    const config = fintavaConfig({
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_flood_0123456789FAKEKEY',
      // The module's own timeout is for small answers; ten megabytes of JSON need longer on a loaded machine.
      FINTAVA_TIMEOUT_MS: '30000',
    });
    return new BillsCatalogueService(new FintavaClient(config), config);
  };
  const check = (data: Record<string, string>) => {
    double.on('GET', '/billing/discos', { status: 200, body: SANDBOX_DISCOS });
    double.on('POST', '/billing/preview-meter', {
      status: 200,
      body: { data, status: 200, message: 'Meter details fetched' },
    });
    return service().previewMeter('person-1', {
      code: 'AEDC',
      meterNumber: '04123456789',
    });
  };

  beforeAll(() => double.start());
  afterAll(() => double.stop());
  beforeEach(() => double.reset());

  it('answers the name and the address behind a flood in the address', async () => {
    const got = await check({
      Customer_Name: 'Ada Eze',
      Address: `${flood('\u2800', 5_000_000)}14 Admiralty Way`,
    });
    expect(got).toMatchObject({ name: 'Ada Eze', address: '14 Admiralty Way' });
  }, 30_000);

  it('answers `meter_unconfirmed` for a flood as the name', async () => {
    await expect(
      check({
        Customer_Name: flood('\u200b', 5_000_000),
        Address: '14 Admiralty Way',
      }),
    ).rejects.toMatchObject({ code: 'meter_unconfirmed' });
  }, 30_000);

  it('answers `meter_unconfirmed` when a flood is followed by a name (the rule refuses a name behind this many)', async () => {
    await expect(
      check({
        Customer_Name: `${flood('\u200b', 5_000_000)}Ada Eze`,
        Address: '14 Admiralty Way',
      }),
    ).rejects.toMatchObject({ code: 'meter_unconfirmed' });
  }, 30_000);
});

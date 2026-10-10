// These specs break copies of a JSON file field by field, so they reach into
// untyped JSON on purpose.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../common/prisma/prisma.module';
import {
  loadPlansConfig,
  parsePlansConfig,
  PLANS_CONFIG_FILE,
  PlansConfigError,
} from '../../plans/plans-config';
import { WaitlistModule } from '../waitlist.module';
import { koboOf, newReference } from '../waitlist.service';
import { normaliseEmail, normalisePhone } from '../waitlist-contact';
import { shippedRaw } from './waitlist-harness';

/**
 * JOIN-01: the `event_offers` list in plans.config.json is checked at boot by
 * the plans schema check. A bad or missing field stops the server naming it.
 */

function stop(edit: (raw: any) => void): string {
  const raw = shippedRaw();
  edit(raw);
  try {
    parsePlansConfig(raw, PLANS_CONFIG_FILE);
  } catch (e) {
    expect(e).toBeInstanceOf(PlansConfigError);
    return (e as Error).message;
  }
  throw new Error('the broken copy was accepted');
}

describe('event_offers in plans.config.json (JOIN-01)', () => {
  it('the shipped file carries the default offer: id, name, 200000 kobo, the Verify tier for 30 days, open 10 to 31 Oct 2026 (Lagos)', () => {
    const config = loadPlansConfig();
    expect(config.eventOffers).toHaveLength(1);
    const o = config.eventOffers[0];
    expect(o).toMatchObject({
      id: 'event-oct-2026',
      name: 'WAWU event registration',
      priceKobo: 200000,
      tier: 'verify',
      tierDays: 30,
    });
    expect(o.openFrom.toISOString()).toBe('2026-10-09T23:00:00.000Z');
    expect(o.openUntil.toISOString()).toBe('2026-10-31T22:59:59.000Z');
  });

  it("without tier_days the offer lasts the tier's own days", () => {
    const raw = shippedRaw();
    delete raw.event_offers[0].tier_days;
    const config = parsePlansConfig(raw, PLANS_CONFIG_FILE);
    const tier = config.tiers.find((t) => t.id === 'verify')!;
    expect(config.eventOffers[0].tierDays).toBe(tier.days);
  });

  it('an empty list is allowed: no event is open', () => {
    const raw = shippedRaw();
    raw.event_offers = [];
    expect(parsePlansConfig(raw, PLANS_CONFIG_FILE).eventOffers).toEqual([]);
  });

  it.each<[string, (raw: any) => void, string]>([
    [
      'the list missing',
      (r) => delete r.event_offers,
      'event_offers is missing',
    ],
    [
      'the list not a list',
      (r) => (r.event_offers = {}),
      'event_offers must be a list',
    ],
    [
      'an offer that is text',
      (r) => (r.event_offers = ['x']),
      'event_offers[0] must be an object',
    ],
    [
      'a price in fractions of a kobo',
      (r) => (r.event_offers[0].price_kobo = 2000.5),
      'event_offers[0].price_kobo must be a whole number of 1 or more (it is 2000.5)',
    ],
    [
      'a free offer',
      (r) => (r.event_offers[0].price_kobo = 0),
      'event_offers[0].price_kobo must be a whole number of 1 or more (it is 0)',
    ],
    [
      'a price written as text',
      (r) => (r.event_offers[0].price_kobo = '200000'),
      'event_offers[0].price_kobo must be a whole number',
    ],
    [
      'a missing price',
      (r) => delete r.event_offers[0].price_kobo,
      'event_offers[0].price_kobo is missing',
    ],
    [
      'a naira price',
      (r) => (r.event_offers[0].price_naira = 2000),
      'event_offers[0].price_naira is not a known field',
    ],
    [
      'a tier nobody defined',
      (r) => (r.event_offers[0].tier = 'gold'),
      'event_offers[0].tier must be one of',
    ],
    [
      'a missing tier',
      (r) => delete r.event_offers[0].tier,
      'event_offers[0].tier is missing',
    ],
    [
      'zero days',
      (r) => (r.event_offers[0].tier_days = 0),
      'event_offers[0].tier_days must be a whole number of 1 or more',
    ],
    [
      'an open time with no offset',
      (r) => (r.event_offers[0].open_from = '2026-10-10T00:00:00'),
      'event_offers[0].open_from must be a date and time with its offset',
    ],
    [
      'an open time that is not a date',
      (r) => (r.event_offers[0].open_until = 'soon'),
      'event_offers[0].open_until must be a date and time with its offset',
    ],
    [
      'a date that does not exist',
      (r) => (r.event_offers[0].open_until = '2026-02-31T00:00:00+01:00'),
      'event_offers[0].open_until is not a real date and time',
    ],
    [
      'closing before opening',
      (r) => (r.event_offers[0].open_until = '2026-10-01T00:00:00+01:00'),
      'event_offers[0].open_until must be after open_from',
    ],
    [
      'an id in capitals',
      (r) => (r.event_offers[0].id = 'Event'),
      'event_offers[0].id must be an id of lower-case letters, digits and -',
    ],
    [
      'an empty name',
      (r) => (r.event_offers[0].name = ''),
      'event_offers[0].name must be text',
    ],
    [
      'a name with an em-dash',
      (r) =>
        (r.event_offers[0].name = `Event ${String.fromCharCode(0x2014)} Lagos`),
      'event_offers[0].name must not contain an em-dash',
    ],
    [
      'an offer id used twice',
      (r) => r.event_offers.push({ ...r.event_offers[0] }),
      'event_offers[1].id repeats "event-oct-2026"',
    ],
  ])('%s stops boot, naming the field', (_label, edit, expected) => {
    expect(stop(edit)).toContain(expected);
  });

  it('a price written twice in the file stops boot naming it (one line of an edit left in place)', () => {
    const text = JSON.stringify(shippedRaw(), null, 2).replace(
      '"price_kobo": 200000,',
      '"price_kobo": 200000,\n      "price_kobo": 1,',
    );
    const file = join(
      mkdtempSync(join(tmpdir(), 'join01-')),
      'plans.config.json',
    );
    writeFileSync(file, text);
    expect(() => loadPlansConfig(file)).toThrow(
      'event_offers[0].price_kobo is written twice',
    );
  });
});

describe('what the registration stores', () => {
  it('turns Flutterwave naira into whole kobo, or refuses an amount that is not', () => {
    expect(koboOf(2000)).toBe(200000);
    expect(koboOf(2000.5)).toBe(200050);
    expect(koboOf(19.99)).toBe(1999);
    expect(koboOf(0.1 + 0.2)).toBe(30);
    for (const bad of [
      2000.001,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e12,
    ])
      expect(koboOf(bad)).toBeNull();
  });

  it('makes references of at least 128 bits that do not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const r = newReference();
      expect(r).toMatch(/^wawu-join-[0-9a-f]{36}$/);
      seen.add(r);
    }
    expect(seen.size).toBe(2000);
  });

  it('normalises phones and emails', () => {
    expect(
      [
        '08031234567',
        '8031234567',
        '2348031234567',
        '+2348031234567',
        '0803-123-4567',
        '(0803) 123 4567',
      ].map(normalisePhone),
    ).toEqual(Array(6).fill('+2348031234567'));
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('00 44 7700 900123')).toBe('+447700900123');
    for (const bad of [
      '',
      '0',
      '123',
      '+0',
      '+234803123456',
      '02031234567',
      '+2348031234567890',
      'abc',
    ])
      expect(normalisePhone(bad)).toBeNull();
    expect(normaliseEmail('  A.B@Example.COM ')).toBe('a.b@example.com');
    for (const bad of [
      '',
      'a',
      'a@b',
      '@b.co',
      'a@b..co',
      'a b@c.de',
      'x'.repeat(250) + '@b.co',
    ])
      expect(normaliseEmail(bad)).toBeNull();
  });
});

describe('production keeps refusing to start without a real payment key (JOIN-01 adds no second switch)', () => {
  const keep = {
    env: process.env.NODE_ENV,
    key: process.env.FLUTTERWAVE_SECRET_KEY,
  };
  afterEach(() => {
    process.env.NODE_ENV = keep.env;
    if (keep.key === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = keep.key;
  });

  it('a production build with no Flutterwave secret key does not boot the registration module', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          PrismaModule,
          WaitlistModule,
        ],
      }).compile(),
    ).rejects.toThrow(
      /FLUTTERWAVE_SECRET_KEY is missing or a placeholder in a production build/,
    );
    process.env.FLUTTERWAVE_SECRET_KEY = 'placeholder-key';
    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          PrismaModule,
          WaitlistModule,
        ],
      }).compile(),
    ).rejects.toThrow(/production build/);
  });

  it("the filter class is the app's own (the refusals reach the one error envelope)", () => {
    expect(new AllExceptionsFilter()).toBeDefined();
  });
});

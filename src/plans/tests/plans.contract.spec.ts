// configCopy edits an untyped copy of the JSON file on purpose, and
// expect.any() is typed any.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EXPORT_SECTIONS } from '../../data-export-request/data-export-sections';
import { BillingCurrencyService } from '../billing-currency.service';
import { MakerTierService } from '../maker-tier.service';
import {
  loadPlansConfig,
  PLANS_CONFIG,
  PLANS_CONFIG_FILE,
  type PlansConfig,
} from '../plans-config';
import { PlansModule } from '../plans.module';
import type { MyTierView, PlansView } from '../plans-view.type';

/**
 * TIER-01 over HTTP: GET /plans and GET /me/tier on the real PlansModule,
 * a real database, and real RS256 tokens checked against the stand-in WAWU
 * ID's JWKS (WAWU_ID_JWKS_URL). Tokens are minted with the stand-in's key so
 * each person's phone can be chosen. Every figure the specs compare with is
 * read from the config, never written here.
 */

const DAY = 86_400_000;
const NIGERIAN = '+2348031234567';
const ABROAD = '+447700900123';

function mintToken(sub: string, phone: unknown, country: unknown): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `plans-${sub}@test.wawu.dev`,
      phone,
      firstName: 'Plans',
      lastName: 'Tester',
      country,
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

type Envelope<T> = { statusCode: number; data: T };
const data = <T>(res: Response): T => (res.body as Envelope<T>).data;

/** A config copy on disk with one change, for the restart and boot checks. */
function configCopy(edit: (raw: any) => void): string {
  const raw = JSON.parse(readFileSync(PLANS_CONFIG_FILE, 'utf8')) as unknown;
  edit(raw);
  const file = join(mkdtempSync(join(tmpdir(), 'plans-')), 'plans.config.json');
  writeFileSync(file, JSON.stringify(raw, null, 2));
  return file;
}

async function boot(file?: string): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      PlansModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  });
  if (file)
    builder = builder
      .overrideProvider(PLANS_CONFIG)
      .useFactory({ factory: () => loadPlansConfig(file) });
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: false,
  });
  app.setGlobalPrefix('api/hub');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.listen(0, '127.0.0.1');
  return app;
}

describe('GET /plans and GET /me/tier (TIER-01) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let billing: BillingCurrencyService;
  let tiers: MakerTierService;
  let config: PlansConfig;
  const users: string[] = [];
  let walletSeq = 0;

  const person = () => {
    const id = randomUUID();
    users.push(id);
    return id;
  };
  const auth = (id: string, phone: unknown, country: unknown = 'Nigeria') =>
    `Bearer ${mintToken(id, phone, country)}`;
  const plans = (
    id: string,
    phone: unknown,
    on = app,
    country: unknown = 'Nigeria',
  ) =>
    request(on.getHttpServer())
      .get('/api/hub/plans')
      .set('Authorization', auth(id, phone, country))
      .expect(200)
      .then((r) => data<PlansView>(r));
  const myTier = (id: string) =>
    request(app.getHttpServer())
      .get('/api/hub/me/tier')
      .set('Authorization', auth(id, NIGERIAN))
      .expect(200)
      .then((r) => data<MyTierView>(r));

  async function openWallet(id: string): Promise<void> {
    walletSeq += 1;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: `7${String(Date.now()).slice(-6)}${String(walletSeq).padStart(3, '0')}`,
        accountName: null,
      },
    });
  }

  async function seedTier(
    id: string,
    tierIndex: number,
    untilInDays: number,
    extra = 0,
  ): Promise<void> {
    const t = config.tiers[tierIndex];
    const now = Date.now();
    await prisma.makerTier.create({
      data: {
        wawuUserId: id,
        tierId: t.id,
        activeFrom: new Date(now - t.days * DAY),
        activeUntil: new Date(now + untilInDays * DAY),
        productsIncluded: t.products,
        extraProducts: extra,
        pointsIncluded: t.bonusPoints,
        voiceIntroIncluded: t.firstVoiceIntro,
      },
    });
  }

  beforeAll(async () => {
    app = await boot();
    prisma = app.get(PrismaService);
    billing = app.get(BillingCurrencyService);
    tiers = app.get(MakerTierService);
    config = app.get<PlansConfig>(PLANS_CONFIG);
  });

  afterAll(async () => {
    const where = { wawuUserId: { in: users } };
    await prisma.personBilling.deleteMany({ where });
    await prisma.makerTier.deleteMany({ where });
    await prisma.eventPass.deleteMany({ where });
    await prisma.fintavaWallet.deleteMany({ where });
    await app.close();
  });

  it('both routes refuse a request with no sign-in', async () => {
    await request(app.getHttpServer()).get('/api/hub/plans').expect(401);
    await request(app.getHttpServer()).get('/api/hub/me/tier').expect(401);
  });

  describe('a person billed in naira sees naira, a person billed in dollars sees dollars', () => {
    it('a person with a Nigerian phone gets every price in kobo and nothing in dollars', async () => {
      const v = await plans(person(), NIGERIAN);
      expect(v.currency).toBe('NGN');
      expect(v.currencyFixed).toBe(false);
      expect(v.tiers.map((t) => t.priceMinor)).toEqual(
        config.tiers.map((t) => t.price.kobo),
      );
      expect(v.extraProducts.priceMinor).toBe(config.extraProducts.price.kobo);
      expect(v.packs.map((p) => [p.id, p.points, p.priceMinor])).toEqual(
        config.packs.map((p) => [p.id, p.points.NGN, p.price.kobo]),
      );
      expect(v.checkoutBump).toEqual({
        points: config.checkoutBump.points.NGN,
        priceMinor: config.checkoutBump.price.kobo,
      });
      // One currency: no field names the other, and no dollar price is in it.
      const text = JSON.stringify(v);
      expect(text).not.toMatch(/USD|cents|kobo/);
      for (const t of config.tiers)
        if (t.price.cents !== t.price.kobo)
          expect(v.tiers.map((x) => x.priceMinor)).not.toContain(t.price.cents);
    });

    it('a person with a phone outside Nigeria and no wallet gets every price in cents', async () => {
      const v = await plans(person(), ABROAD);
      expect(v.currency).toBe('USD');
      expect(v.tiers.map((t) => t.priceMinor)).toEqual(
        config.tiers.map((t) => t.price.cents),
      );
      expect(v.extraProducts.priceMinor).toBe(config.extraProducts.price.cents);
      expect(v.packs.map((p) => [p.id, p.points, p.priceMinor])).toEqual(
        config.packs.map((p) => [p.id, p.points.USD, p.price.cents]),
      );
      expect(v.checkoutBump).toEqual({
        points: config.checkoutBump.points.USD,
        priceMinor: config.checkoutBump.price.cents,
      });
      expect(JSON.stringify(v)).not.toMatch(/NGN|cents|kobo/);
    });

    it('a person with a naira wallet is billed in naira whatever their phone', async () => {
      const id = person();
      await openWallet(id);
      expect((await plans(id, ABROAD)).currency).toBe('NGN');
    });

    it.each([
      // A Nigerian country code decides, whatever the country claim says.
      ['+2348031234567', 'United States', 'NGN'],
      ['+234 803 123 4567', null, 'NGN'],
      ['2348031234567', 'United Kingdom', 'NGN'],
      ['002348031234567', '', 'NGN'],
      // Any other country code decides too.
      ['+14155550100', 'Nigeria', 'USD'],
      ['+447700900123', 'NG', 'USD'],
      ['0044 7700 900123', 'Nigeria', 'USD'],
      // No country code: the country claim breaks the tie (lead ruling N1).
      ['08031234567', 'Nigeria', 'NGN'],
      ['8031234567', ' nigeria ', 'NGN'],
      ['08031234567', 'NGA', 'NGN'],
      ['08031234567', 'United States', 'USD'],
      ['07123456789', 'United Kingdom', 'USD'],
      ['08031234567', null, 'USD'],
      ['', 'Nigeria', 'NGN'],
      ['', 'United States', 'USD'],
    ])(
      'reads the phone %p with the country %p as %s',
      async (phone, country, currency) => {
        expect((await plans(person(), phone, app, country)).currency).toBe(
          currency,
        );
      },
    );

    it('a United States web sign-up (a local number, dial code apart) is billed in dollars', async () => {
      // WAWU ID's web register keeps the phone as typed and the dial code
      // apart: ten digits that look like a Nigerian mobile.
      const v = await plans(person(), '(803) 555-0100', app, 'United States');
      expect(v.currency).toBe('USD');
      expect(v.tiers.map((t) => t.priceMinor)).toEqual(
        config.tiers.map((t) => t.price.cents),
      );
    });

    it.each([
      ['a number', 8031234567],
      ['a list', ['+2348031234567']],
      ['an object', { number: '+2348031234567' }],
      ['null', null],
    ])(
      'a phone claim that is %s is read as no phone, never a 500',
      async (_kind, phone) => {
        expect((await plans(person(), phone, app, 'Nigeria')).currency).toBe(
          'NGN',
        );
        expect(
          (await plans(person(), phone, app, 'United States')).currency,
        ).toBe('USD');
        expect((await plans(person(), phone, app, 42)).currency).toBe('USD');
      },
    );

    it('both answers are personal and say no-store', async () => {
      const id = person();
      for (const route of ['/api/hub/plans', '/api/hub/me/tier']) {
        const res = await request(app.getHttpServer())
          .get(route)
          .set('Authorization', auth(id, NIGERIAN))
          .expect(200);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('serves the rest of the plan from the config: tiers, actions and caps', async () => {
      const v = await plans(person(), NIGERIAN);
      expect(
        v.tiers.map((t) => [
          t.id,
          t.name,
          t.days,
          t.products,
          t.bonusPoints,
          t.bonusPointsExpireDays,
          t.eventPass.id,
          t.badge,
          t.packBonusPercent,
          t.firstVoiceIntroIncluded,
          t.preselected,
        ]),
      ).toEqual(
        config.tiers.map((t) => [
          t.id,
          t.name,
          t.days,
          t.products,
          t.bonusPoints,
          t.bonusExpiryDays,
          t.eventPass,
          t.badge,
          t.packBonusPct,
          t.firstVoiceIntro,
          t.id === config.preselectedTier,
        ]),
      );
      expect(v.extraProducts.count).toBe(config.extraProducts.count);
      expect(v.actions).toEqual(
        config.actions.map((a) => ({ id: a.id, points: a.points, per: a.per })),
      );
      expect(v.caps).toEqual({
        dailyPoints: config.caps.dailyPointsPerUser,
        maxCharactersPerJob: config.caps.maxCharsPerJob,
        maxAudioMinutesPerJob: config.caps.maxAudioMinPerJob,
      });
    });
  });

  describe('a billing currency, once set, never changes', () => {
    it('a person fixed in dollars stays in dollars after opening a naira wallet and changing to a Nigerian phone', async () => {
      const id = person();
      const ref = `test-${randomUUID()}`;
      expect(
        await billing.fixAtFirstPurchase({
          wawuUserId: id,
          phone: ABROAD,
          purchaseRef: ref,
        }),
      ).toBe('USD');
      const before = await prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: id },
      });

      await openWallet(id);
      const v = await plans(id, NIGERIAN);
      expect(v.currency).toBe('USD');
      expect(v.currencyFixed).toBe(true);
      expect(v.tiers.map((t) => t.priceMinor)).toEqual(
        config.tiers.map((t) => t.price.cents),
      );

      // A second purchase, now with a naira wallet and a Nigerian phone.
      expect(
        await billing.fixAtFirstPurchase({
          wawuUserId: id,
          phone: NIGERIAN,
          purchaseRef: `test-${randomUUID()}`,
        }),
      ).toBe('USD');
      expect(
        await prisma.personBilling.findUniqueOrThrow({
          where: { wawuUserId: id },
        }),
      ).toEqual(before);
      expect(before).toMatchObject({
        fixedBy: 'first_purchase',
        purchaseRef: ref,
      });
    });

    it('a person fixed in naira stays in naira after changing to a phone abroad', async () => {
      const id = person();
      await billing.fixAtFirstPurchase({
        wawuUserId: id,
        phone: NIGERIAN,
        purchaseRef: `test-${randomUUID()}`,
      });
      const v = await plans(id, ABROAD);
      expect(v).toMatchObject({ currency: 'NGN', currencyFixed: true });
    });

    it('two first purchases at the same moment fix one currency, and both are told the same one', async () => {
      const id = person();
      const answers = await Promise.all(
        [NIGERIAN, ABROAD, NIGERIAN, ABROAD, NIGERIAN, ABROAD].map((phone) =>
          billing.fixAtFirstPurchase({
            wawuUserId: id,
            phone,
            purchaseRef: `test-${randomUUID()}`,
          }),
        ),
      );
      expect(new Set(answers).size).toBe(1);
      expect(
        await prisma.personBilling.count({ where: { wawuUserId: id } }),
      ).toBe(1);
      const row = await prisma.personBilling.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.currency).toBe(answers[0]);
    });

    it('a purchase that rolls back leaves the currency unfixed', async () => {
      const id = person();
      await expect(
        prisma.$transaction(async (tx) => {
          await billing.fixAtFirstPurchase(
            {
              wawuUserId: id,
              phone: ABROAD,
              purchaseRef: `test-${randomUUID()}`,
            },
            tx,
          );
          throw new Error('payment refused');
        }),
      ).rejects.toThrow('payment refused');
      expect(
        await prisma.personBilling.count({ where: { wawuUserId: id } }),
      ).toBe(0);
      expect((await plans(id, NIGERIAN)).currencyFixed).toBe(false);
    });
  });

  describe('the config file decides, with no code change', () => {
    it('changing a figure and restarting changes GET /plans', async () => {
      const file = configCopy((r) => {
        r.tiers[0].price.kobo += 100;
        r.tiers[0].price.cents += 1;
        r.packs[0].points.USD += 50;
        r.action_points.sfx.points += 5;
      });
      const changed = await boot(file);
      try {
        const id = person();
        const ng = await plans(id, NIGERIAN, changed);
        expect(ng.tiers[0].priceMinor).toBe(config.tiers[0].price.kobo + 100);
        const us = await plans(person(), ABROAD, changed);
        expect(us.tiers[0].priceMinor).toBe(config.tiers[0].price.cents + 1);
        expect(us.packs[0].points).toBe(config.packs[0].points.USD + 50);
        expect(us.actions.find((a) => a.id === 'sfx')?.points).toBe(
          config.actions.find((a) => a.id === 'sfx')!.points + 5,
        );
        // The server started from the shipped file still answers the shipped figure.
        expect((await plans(id, NIGERIAN)).tiers[0].priceMinor).toBe(
          config.tiers[0].price.kobo,
        );
      } finally {
        await changed.close();
      }
    });

    it('a malformed file stops the server at boot, naming the field', async () => {
      const file = configCopy((r) => {
        r.tiers[1].price.kobo = 'three thousand';
      });
      await expect(boot(file)).rejects.toThrow(
        'plans.config.json: tiers[1].price.kobo must be a whole number of 1 or more (it is "three thousand"). Fix the file and restart.',
      );
    });

    it('an incomplete file stops the server at boot, naming the field', async () => {
      const file = configCopy((r) => {
        delete r.tiers[2].event_pass;
      });
      await expect(boot(file)).rejects.toThrow(
        'plans.config.json: tiers[2].event_pass is missing',
      );
    });
  });

  describe('GET /me/tier', () => {
    it('answers none for a new person', async () => {
      expect(await myTier(person())).toEqual({
        state: 'none',
        tier: null,
        activeFrom: null,
        activeUntil: null,
        productsAllowed: 0,
        extraProducts: 0,
        pointsIncluded: 0,
        firstVoiceIntroIncluded: false,
        eventPass: null,
      });
    });

    it('answers active, ending and ended for seeded tiers', async () => {
      const w = config.tierEndingDays;
      const active = person();
      const ending = person();
      const ended = person();
      await seedTier(active, 0, w + 30);
      await seedTier(ending, 1, w - 0.5);
      await seedTier(ended, 2, -1);
      expect((await myTier(active)).state).toBe('active');
      expect((await myTier(ending)).state).toBe('ending');
      expect((await myTier(ended)).state).toBe('ended');
      expect(await tiers.hasActiveTier(active)).toBe(true);
      expect(await tiers.hasActiveTier(ending)).toBe(true);
      expect(await tiers.hasActiveTier(ended)).toBe(false);
      expect(await tiers.hasActiveTier(person())).toBe(false);
    });

    it('shows the tier, its badge, its dates, what it allows and the best event pass', async () => {
      const id = person();
      const t = config.tiers[2];
      await seedTier(id, 2, 40, config.extraProducts.count);
      const low = config.eventPasses[0];
      const high = config.eventPasses[config.eventPasses.length - 1];
      await prisma.eventPass.createMany({
        data: [
          {
            wawuUserId: id,
            type: high.id,
            purchaseRef: `test-${randomUUID()}`,
          },
          { wawuUserId: id, type: low.id, purchaseRef: `test-${randomUUID()}` },
          {
            wawuUserId: id,
            type: 'retired_pass',
            purchaseRef: `test-${randomUUID()}`,
          },
        ],
      });
      const row = await prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(await myTier(id)).toEqual({
        state: 'active',
        tier: { id: t.id, name: t.name, badge: t.badge },
        activeFrom: row.activeFrom.toISOString(),
        activeUntil: row.activeUntil.toISOString(),
        productsAllowed: t.products + config.extraProducts.count,
        extraProducts: config.extraProducts.count,
        pointsIncluded: t.bonusPoints,
        firstVoiceIntroIncluded: t.firstVoiceIntro,
        eventPass: { id: high.id, name: high.name },
      });
    });

    it("never shows another person's tier", async () => {
      const holder = person();
      const other = person();
      await seedTier(holder, 0, 20);
      await prisma.eventPass.create({
        data: {
          wawuUserId: holder,
          type: config.eventPasses[0].id,
          purchaseRef: `test-${randomUUID()}`,
        },
      });
      expect((await myTier(other)).state).toBe('none');
      expect((await myTier(other)).eventPass).toBeNull();
      expect((await myTier(holder)).tier?.id).toBe(config.tiers[0].id);
    });

    it('keeps what a person bought when the config has changed that tier since', async () => {
      // A tier the config still names, bought when it gave other figures.
      const id = person();
      const t = config.tiers[1];
      await prisma.makerTier.create({
        data: {
          wawuUserId: id,
          tierId: t.id,
          activeFrom: new Date(Date.now() - DAY),
          activeUntil: new Date(Date.now() + 60 * DAY),
          productsIncluded: t.products + 2,
          extraProducts: 1,
          pointsIncluded: t.bonusPoints + 7,
          voiceIntroIncluded: !t.firstVoiceIntro,
        },
      });
      expect(await myTier(id)).toMatchObject({
        state: 'active',
        tier: { id: t.id, name: t.name, badge: t.badge },
        productsAllowed: t.products + 3,
        extraProducts: 1,
        pointsIncluded: t.bonusPoints + 7,
        firstVoiceIntroIncluded: !t.firstVoiceIntro,
      });
      const held = await tiers.tierOf(id);
      expect(held).toMatchObject({
        productsIncluded: t.products + 2,
        productsAllowed: t.products + 3,
        pointsIncluded: t.bonusPoints + 7,
      });
      expect(held.tier).toEqual(t);
    });

    it('keeps what a person bought when the config no longer names their tier', async () => {
      const id = person();
      await prisma.makerTier.create({
        data: {
          wawuUserId: id,
          tierId: 'retired_tier',
          activeFrom: new Date(Date.now() - DAY),
          activeUntil: new Date(Date.now() + 60 * DAY),
          productsIncluded: config.tiers[0].products,
          pointsIncluded: config.tiers[0].bonusPoints,
        },
      });
      expect(await myTier(id)).toMatchObject({
        state: 'active',
        tier: { id: 'retired_tier', name: null, badge: null },
        productsAllowed: config.tiers[0].products,
      });
    });
  });

  describe('the data export', () => {
    const section = (key: string) =>
      EXPORT_SECTIONS.find((s) => s.key === key)!;

    it("exports only the person's own billing currency, tier and passes, without payment references", async () => {
      const me = person();
      const someoneElse = person();
      for (const id of [me, someoneElse]) {
        await billing.fixAtFirstPurchase({
          wawuUserId: id,
          phone: id === me ? NIGERIAN : ABROAD,
          country: 'Nigeria',
          purchaseRef: `test-${randomUUID()}`,
        });
        await seedTier(id, id === me ? 0 : 1, 10);
        await prisma.eventPass.create({
          data: {
            wawuUserId: id,
            type: config.eventPasses[id === me ? 0 : 1].id,
            purchaseRef: `test-${randomUUID()}`,
          },
        });
      }
      const billingOut = await section('billingCurrency').load(prisma, me);
      const tierOut = await section('makerTier').load(prisma, me);
      const passesOut = await section('eventPasses').load(prisma, me);
      expect(billingOut).toMatchObject({
        currency: 'NGN',
        fixedBy: 'first_purchase',
      });
      expect(tierOut).toMatchObject({ tierId: config.tiers[0].id });
      expect(passesOut).toEqual([
        { type: config.eventPasses[0].id, createdAt: expect.any(Date) },
      ]);
      const text = JSON.stringify([billingOut, tierOut, passesOut]);
      expect(text).not.toContain('purchaseRef');
      expect(text).not.toContain('test-');
      expect(text).not.toContain(someoneElse);
    });
  });
});

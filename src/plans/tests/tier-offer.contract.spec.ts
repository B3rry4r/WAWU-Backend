import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AccountType } from '../../../generated/prisma/enums';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildRegistry } from '../../plan-settings/plan-setting-registry';
import { SettingInvalid } from '../../plan-settings/plan-setting-types';
import { loadPlanSettingsDefaults } from '../../plan-settings/plan-settings-defaults';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { PLANS_CONFIG, type PlansConfig } from '../plans-config';
import { PlansModule } from '../plans.module';
import type { TierOfferSeenView, TierOfferView } from '../plans-view.type';
import { TIER_OFFER_CLOSE_SETTING } from '../tier-offer.service';

/**
 * TIER-OFFER (R-94) over HTTP: GET /me/tier-offer and POST /me/tier-offer/seen on the real PlansModule, a real database and real
 * RS256 tokens. Who is shown the offer (a creator account that was never shown it and holds no running tier), that "shown" is
 * written once and holds for the person on any phone, and that the admin setting decides how the offer closes.
 */

const DAY = 86_400_000;
const PHONE = '+2348031234567';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `tof-${sub}@test.wawu.dev`,
      phone: PHONE,
      firstName: 'Offer',
      lastName: 'Tester',
      country: 'Nigeria',
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

describe('the tier offer (TIER-OFFER, R-94) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let settings: PlanSettingsService;
  let config: PlansConfig;
  const users: string[] = [];

  const person = async (
    accountType: AccountType | null = AccountType.creator,
  ): Promise<string> => {
    const id = randomUUID();
    users.push(id);
    if (accountType) {
      await prisma.userProfile.create({
        data: { wawuUserId: id, accountType },
      });
    }
    return id;
  };
  const bearer = (id: string) => `Bearer ${mintToken(id)}`;
  const offer = (id: string) =>
    request(app.getHttpServer())
      .get('/api/hub/me/tier-offer')
      .set('Authorization', bearer(id))
      .expect(200)
      .then((r) => data<TierOfferView>(r));
  const seen = (id: string) =>
    request(app.getHttpServer())
      .post('/api/hub/me/tier-offer/seen')
      .set('Authorization', bearer(id))
      .expect(200)
      .then((r) => data<TierOfferSeenView>(r));
  const holdTier = (id: string, untilInDays: number) => {
    const t = config.tiers[0];
    const now = Date.now();
    return prisma.makerTier.create({
      data: {
        wawuUserId: id,
        tierId: t.id,
        activeFrom: new Date(now - 30 * DAY),
        activeUntil: new Date(now + untilInDays * DAY),
        productsIncluded: t.products,
        extraProducts: 0,
        pointsIncluded: t.bonusPoints,
        voiceIntroIncluded: t.firstVoiceIntro,
      },
    });
  };
  const setClose = async (value: number | null) => {
    if (value === null) {
      await prisma.planSetting.deleteMany({
        where: { key: TIER_OFFER_CLOSE_SETTING },
      });
    } else {
      await prisma.planSetting.upsert({
        where: { key: TIER_OFFER_CLOSE_SETTING },
        create: { key: TIER_OFFER_CLOSE_SETTING, value },
        update: { value },
      });
    }
    await settings.refresh();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        PlansModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
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
    prisma = app.get(PrismaService);
    settings = app.get(PlanSettingsService);
    config = app.get<PlansConfig>(PLANS_CONFIG);
    await setClose(null);
  });

  afterAll(async () => {
    const where = { wawuUserId: { in: users } };
    await setClose(null);
    await prisma.tierOfferSeen.deleteMany({ where });
    await prisma.makerTier.deleteMany({ where });
    await prisma.userProfile.deleteMany({ where });
    await app.close();
  });

  it('both routes refuse a request with no sign-in', async () => {
    await request(app.getHttpServer())
      .get('/api/hub/me/tier-offer')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/hub/me/tier-offer/seen')
      .expect(401);
  });

  describe('who is shown it', () => {
    it('a creator who was never shown it and holds no tier is shown it, with the close button on by default', async () => {
      const id = await person();
      expect(await offer(id)).toEqual({ show: true, closeButton: true });
    });

    it('a fan or buyer account is never shown it (tiers unlock selling)', async () => {
      const id = await person(AccountType.user);
      expect(await offer(id)).toEqual({ show: false, closeButton: true });
    });

    it('a person whose profile the Hub has not written yet is not shown it, and is not marked as having seen it', async () => {
      const id = await person(null);
      expect((await offer(id)).show).toBe(false);
      expect(
        await prisma.tierOfferSeen.findUnique({ where: { wawuUserId: id } }),
      ).toBeNull();
      // Their profile arrives: they are shown it then.
      await prisma.userProfile.create({
        data: { wawuUserId: id, accountType: AccountType.creator },
      });
      expect((await offer(id)).show).toBe(true);
    });

    it('a creator who holds a running tier never sees it, whether it has long to run or is about to end', async () => {
      const long = await person();
      await holdTier(long, 300);
      expect((await offer(long)).show).toBe(false);
      const ending = await person();
      await holdTier(ending, 2);
      expect((await offer(ending)).show).toBe(false);
    });

    it('a creator whose tier has ended is shown it once, like anyone who has not seen it', async () => {
      const id = await person();
      await holdTier(id, -1);
      expect((await offer(id)).show).toBe(true);
    });
  });

  describe('shown once, across devices', () => {
    it('after the app says it was drawn, the Hub never offers it again, whichever phone asks', async () => {
      const id = await person();
      expect((await offer(id)).show).toBe(true);
      const first = await seen(id);
      expect(new Date(first.seenAt).getTime()).toBeGreaterThan(0);
      expect((await offer(id)).show).toBe(false);
      // A second phone (or a retry) asks and writes again: nothing changes.
      const second = await seen(id);
      expect(second.seenAt).toBe(first.seenAt);
      expect((await offer(id)).show).toBe(false);
      expect(
        await prisma.tierOfferSeen.count({ where: { wawuUserId: id } }),
      ).toBe(1);
    });

    it('one person having seen it changes nothing for another', async () => {
      const a = await person();
      const b = await person();
      await seen(a);
      expect((await offer(a)).show).toBe(false);
      expect((await offer(b)).show).toBe(true);
    });

    it('a fan who is marked as having seen it is still only a fan: nothing else changes', async () => {
      const id = await person(AccountType.user);
      await seen(id);
      expect(await offer(id)).toEqual({ show: false, closeButton: true });
    });
  });

  describe('the admin setting "Show the close button on the tier offer"', () => {
    afterEach(async () => {
      await setClose(null);
    });

    it('is on by default, and switching it off makes the Hub say so (the app then draws "Not now")', async () => {
      const id = await person();
      expect((await offer(id)).closeButton).toBe(true);
      await setClose(0);
      expect(await offer(id)).toEqual({ show: true, closeButton: false });
      await setClose(1);
      expect((await offer(id)).closeButton).toBe(true);
    });

    it('is told to a person who is not shown the offer too, so the answer never depends on who asks', async () => {
      await setClose(0);
      const fan = await person(AccountType.user);
      expect(await offer(fan)).toEqual({ show: false, closeButton: false });
    });

    it('is a registry setting an admin can change, 1 or 0 only, listed by the admin view', () => {
      const def = settings
        .describe()
        .settings.find((s) => s.key === TIER_OFFER_CLOSE_SETTING);
      expect(def).toBeDefined();
      expect(def?.label).toContain('Show the close button on the tier offer');
      expect(def?.value).toBe(1);
      const seed = loadPlanSettingsDefaults();
      const registered = buildRegistry(seed.plans, seed.extras).find(
        (d) => d.key === TIER_OFFER_CLOSE_SETTING,
      );
      expect(registered?.default).toBe(1);
      const parse = (raw: unknown) => registered!.parse(raw);
      expect(parse(0)).toBe(0);
      expect(parse(1)).toBe(1);
      for (const bad of [2, -1, 0.5, '1', null, true]) {
        expect(() => parse(bad)).toThrow(SettingInvalid);
      }
    });
  });
});

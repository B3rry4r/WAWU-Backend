// Contract tests for the creator's paid message settings (task INBOX-12, the
// app's I21 to I23, DECISIONS R-13). Real tokens from the local mock WAWU ID,
// a real database.
//
// Capability checks: a creator reads their settings with everything the screen
// draws (price, reply window, share, earnings, a price to raise to, the
// standing); saves a price and a reply window; is told how many of the last
// questions they missed when warned; and cannot save while paid messages are
// off for 7 days. The live `PATCH /creator/dm-settings` is not touched here.
//
// Every identity is a throwaway registered here; every row is removed in
// afterAll.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreatorStateModule } from '../../creator-state/creator-state.module';
import { DirectMessageModule } from '../direct-message.module';
import { paidDmSettingsConfig } from '../paid-dm-settings.config';
import type { PaidDmSettings } from '../paid-dm-view.type';

const data = <T>(res: Response): T => (res.body as { data: T }).data;

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let nonceSeq = 0;
async function registerPerson(label: string) {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Settings Spec ${label}`,
      email: `settings-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

type Person = { sub: string; token: string };

describe('Paid message settings (contract, INBOX-12)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let fan: Person;
  let plain: Person;
  const people: string[] = [];
  const created: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (who: Person) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    put: (url: string, body: object = {}) =>
      http().put(url).set('Authorization', `Bearer ${who.token}`).send(body),
  });

  async function profile(p: Person, accountType: 'creator' | 'user') {
    people.push(p.sub);
    await prisma.userProfile.create({
      data: {
        wawuUserId: p.sub,
        accountType,
        handle: `set_${p.sub.slice(0, 8)}`,
        interests: [],
      },
    });
  }

  /** A creator. With `state` they have a CreatorState row; without, they have never configured anything. */
  async function creator(
    label: string,
    state?: {
      dmEnabled?: boolean;
      dmPrice?: number | null;
      dmResponseHours?: number;
    },
  ): Promise<Person> {
    const p = await registerPerson(label);
    await profile(p, 'creator');
    if (state) {
      await prisma.creatorState.create({
        data: { wawuUserId: p.sub, kycStatus: 'approved', ...state },
      });
    }
    return p;
  }

  /** Settled paid questions sent 2 days ago: `unanswered` that lapsed and `answered` that were replied to. */
  async function questions(
    to: Person,
    counts: { unanswered?: number; answered?: number },
  ) {
    const rows: Array<{ id: string; status: 'refunded' | 'responded' }> = [];
    for (let i = 0; i < (counts.unanswered ?? 0); i += 1) {
      rows.push({ id: randomUUID(), status: 'refunded' });
    }
    for (let i = 0; i < (counts.answered ?? 0); i += 1) {
      rows.push({ id: randomUUID(), status: 'responded' });
    }
    created.push(...rows.map((r) => r.id));
    const sentAt = new Date(Date.now() - 2 * DAY);
    await prisma.directMessage.createMany({
      data: rows.map((r) => ({
        id: r.id,
        creatorWawuId: to.sub,
        senderWawuId: fan.sub,
        text: 'a paid question',
        amount: 1500,
        status: r.status,
        sentAt,
        deadlineAt: new Date(sentAt.getTime() + DAY),
        respondedAt: r.status === 'responded' ? sentAt : null,
        flutterwaveTxRef: `settings-spec-${r.id}`,
        responseWindowHours: 24,
      })),
    });
  }

  const settings = async (who: Person) =>
    data<PaidDmSettings>(await as(who).get('/paid-dm/settings').expect(200));

  const stored = (who: Person) =>
    prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: who.sub } });

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    fan = await registerPerson('Fan');
    plain = await registerPerson('Plain');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        DirectMessageModule,
        CreatorStateModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await profile(fan, 'user');
    await profile(plain, 'user');
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      await prisma.directMessage.deleteMany({
        where: {
          OR: [{ id: { in: created } }, { creatorWawuId: { in: people } }],
        },
      });
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await prisma.creatorNoResponseTracker.deleteMany({
        where: { creatorWawuId: { in: people } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: people } },
      });
    }
    if (app) await app.close();
    mock?.kill();
  });

  describe('who may use it', () => {
    it('401s with no token and 403s a plain account, on both routes', async () => {
      await http().get('/paid-dm/settings').expect(401);
      await http()
        .put('/paid-dm/settings')
        .send({ enabled: false })
        .expect(401);
      await as(plain).get('/paid-dm/settings').expect(403);
      await as(plain).put('/paid-dm/settings', { enabled: false }).expect(403);
    });
  });

  describe('reading', () => {
    it('a creator who never configured anything reads the starting settings, in kobo, with the options and the share', async () => {
      const c = await creator('Fresh');
      const s = await settings(c);
      expect(s).toMatchObject({
        enabled: false,
        priceKobo: null,
        responseHours: 24,
        creatorSharePct: 85,
        earnPerMessageKobo: null,
        raiseToKobo: null,
        options: {
          minPriceKobo: 5_000,
          maxPriceKobo: 1_000_000_000,
          pricePresets: [
            { priceKobo: 10_000 },
            { priceKobo: 50_000 },
            { priceKobo: 100_000 },
            { priceKobo: 250_000 },
          ],
          responseWindowHours: [24, 48, 72, 168],
        },
        standing: {
          state: 'ok',
          acceptingPaidMessages: true,
          unansweredPct: 0,
          pausedUntil: null,
        },
      });
      // Reading wrote no CreatorState row: only configuring does.
      expect(
        await prisma.creatorState.count({ where: { wawuUserId: c.sub } }),
      ).toBe(0);
    });

    it('serves the saved price in kobo, what the creator keeps of it, and the next preset up to raise to', async () => {
      const c = await creator('Saved', {
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 72,
      });
      expect(await settings(c)).toMatchObject({
        enabled: true,
        priceKobo: 150_000,
        responseHours: 72,
        creatorSharePct: 85,
        earnPerMessageKobo: 127_500,
        raiseToKobo: 250_000,
      });
    });

    it('offers no raise at or above the highest preset', async () => {
      const top = await creator('Top', { dmEnabled: true, dmPrice: 2500 });
      const above = await creator('Above', { dmEnabled: true, dmPrice: 9000 });
      expect((await settings(top)).raiseToKobo).toBeNull();
      expect((await settings(above)).raiseToKobo).toBeNull();
    });

    it('rounds what the creator keeps down to the kobo', async () => {
      const c = await creator('Round', { dmEnabled: true, dmPrice: 51 });
      // 5,100 kobo at 85% is 4,335 exactly; 5,001 would not be, and naira are whole.
      expect((await settings(c)).earnPerMessageKobo).toBe(4_335);
    });
  });

  describe('what the creator keeps at a typed price (R-21)', () => {
    type Earn = {
      priceKobo: number;
      creatorSharePct: number;
      earnPerMessageKobo: number;
    };
    const earn = (who: Person, query: string) =>
      as(who).get(`/paid-dm/settings/earn${query}`);

    it('401s with no token and 403s a plain account', async () => {
      await http().get('/paid-dm/settings/earn?priceKobo=100000').expect(401);
      await earn(plain, '?priceKobo=100000').expect(403);
    });

    it('answers with the share and what the creator keeps, in integer kobo', async () => {
      const c = await creator('Earn');
      // Whole naira at 85% are always whole kobo; the floor only guards a share that is not 85.
      const cases: Array<[number, number]> = [
        [5_000, 4_250],
        [5_100, 4_335],
        [10_000, 8_500],
        [150_000, 127_500],
        [250_000, 212_500],
        [1_000_000_000, 850_000_000],
      ];
      for (const [priceKobo, earnPerMessageKobo] of cases) {
        const res = await earn(c, `?priceKobo=${priceKobo}`).expect(200);
        expect(data<Earn>(res)).toEqual({
          priceKobo,
          creatorSharePct: 85,
          earnPerMessageKobo,
        });
        expect(Number.isInteger(data<Earn>(res).earnPerMessageKobo)).toBe(true);
      }
    });

    it('gives the same figure the saved settings give for the same price', async () => {
      const c = await creator('EarnSame');
      for (const priceKobo of [5_100, 9_900, 123_400, 777_700]) {
        await as(c)
          .put('/paid-dm/settings', { enabled: false, priceKobo })
          .expect(200);
        const read = data<Earn>(await earn(c, `?priceKobo=${priceKobo}`));
        const saved = await settings(c);
        expect(read.earnPerMessageKobo).toBe(saved.earnPerMessageKobo);
        expect(read.creatorSharePct).toBe(saved.creatorSharePct);
      }
    });

    it('refuses a price the save would refuse, and writes nothing', async () => {
      const c = await creator('EarnBad', { dmEnabled: true, dmPrice: 1500 });
      const before = await stored(c);
      for (const query of [
        '',
        '?priceKobo=',
        '?priceKobo=abc',
        '?priceKobo=1.5',
        '?priceKobo=150050',
        '?priceKobo=4900',
        '?priceKobo=0',
        '?priceKobo=-100',
        '?priceKobo=1000000100',
        '?priceKobo=100000&priceKobo=200000',
        // JS-Number spellings that are not plain digits (INBOX-12 R2-1)
        '?priceKobo=0x1388',
        '?priceKobo=0005000',
        '?priceKobo=%20100000',
        '?priceKobo=%2B100000',
        '?priceKobo=1e5',
        '?price=100000',
        '?priceKobo=100000&extra=1',
      ]) {
        await earn(c, query).expect(400);
      }
      expect(await stored(c)).toEqual(before);
    });

    it('is the same for a creator with no row, and does not create one', async () => {
      const c = await creator('EarnNoRow');
      const res = await earn(c, '?priceKobo=100000').expect(200);
      expect(data<Earn>(res).earnPerMessageKobo).toBe(85_000);
      expect(
        await prisma.creatorState.findUnique({ where: { wawuUserId: c.sub } }),
      ).toBeNull();
    });

    it('still answers while paid messages are paused: it only reads', async () => {
      const c = await creator('EarnPaused', { dmEnabled: true, dmPrice: 1500 });
      await prisma.creatorNoResponseTracker.create({
        data: {
          creatorWawuId: c.sub,
          penaltyState: 'disabled_7d',
          noResponseRatePct: 34,
          dmDisabledUntil: new Date(Date.now() + 3 * DAY),
        },
      });
      await earn(c, '?priceKobo=100000').expect(200);
    });
  });

  describe('the warning (I22)', () => {
    it('says how many of the last questions were missed, and warns from 20%', async () => {
      const c = await creator('Warned', { dmEnabled: true, dmPrice: 1500 });
      await questions(c, { unanswered: 4, answered: 14 });
      const s = await settings(c);
      expect(s.standing).toMatchObject({
        state: 'warning',
        acceptingPaidMessages: true,
        unanswered: 4,
        questions: 18,
        warnAtPct: 20,
        pauseAtPct: 30,
        windowDays: 30,
        pauseDays: 7,
        pausedUntil: null,
      });
      expect(s.standing.unansweredPct).toBeCloseTo(22.22, 2);
      expect(s.raiseToKobo).toBe(250_000);
    });

    it('a warned creator can still save', async () => {
      const c = await creator('WarnSave', { dmEnabled: true, dmPrice: 1500 });
      await questions(c, { unanswered: 4, answered: 14 });
      const s = data<PaidDmSettings>(
        await as(c)
          .put('/paid-dm/settings', { enabled: true, priceKobo: 250_000 })
          .expect(200),
      );
      expect(s.priceKobo).toBe(250_000);
      expect(s.standing.state).toBe('warning');
    });
  });

  describe('saving', () => {
    it('saves the switch, the price and the reply window, and the live route reads them as naira and hours', async () => {
      const c = await creator('Save', {
        dmEnabled: false,
        dmPrice: 500,
        dmResponseHours: 24,
      });
      const s = data<PaidDmSettings>(
        await as(c)
          .put('/paid-dm/settings', {
            enabled: true,
            priceKobo: 200_000,
            responseHours: 48,
          })
          .expect(200),
      );
      expect(s).toMatchObject({
        enabled: true,
        priceKobo: 200_000,
        responseHours: 48,
        earnPerMessageKobo: 170_000,
        raiseToKobo: 250_000,
      });
      const row = await stored(c);
      expect(row).toMatchObject({
        dmEnabled: true,
        dmPrice: 2000,
        dmResponseHours: 48,
      });
      const live = await http()
        .get('/creator/state')
        .set('Authorization', `Bearer ${c.token}`)
        .expect(200);
      expect(data<{ dmPrice: number }>(live).dmPrice).toBe(2000);
    });

    it('writes the row for a creator who has none, which is what configuring does', async () => {
      const c = await creator('Row');
      await as(c)
        .put('/paid-dm/settings', { enabled: true, priceKobo: 100_000 })
        .expect(200);
      expect(await stored(c)).toMatchObject({
        dmEnabled: true,
        dmPrice: 1000,
        dmResponseHours: 24,
      });
    });

    it('leaves the price and the window alone when a save leaves them out', async () => {
      const c = await creator('Keep', {
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 72,
      });
      await as(c).put('/paid-dm/settings', { enabled: false }).expect(200);
      expect(await stored(c)).toMatchObject({
        dmEnabled: false,
        dmPrice: 1500,
        dmResponseHours: 72,
      });
    });

    it('refuses null for every field and leaves the row as it was, where a field left out keeps its saved value', async () => {
      const c = await creator('Nulls', {
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 72,
      });
      const before = await stored(c);
      const body = { enabled: false, priceKobo: 100_000, responseHours: 48 };
      for (const field of Object.keys(body)) {
        const res = await as(c)
          .put('/paid-dm/settings', { ...body, [field]: null })
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(field);
      }
      // null by itself, on a creator who is on 150,000 kobo, saves nothing.
      await as(c)
        .put('/paid-dm/settings', { enabled: true, priceKobo: null })
        .expect(400);
      await as(c)
        .put('/paid-dm/settings', { enabled: null, priceKobo: 100_000 })
        .expect(400);
      expect(await stored(c)).toEqual(before);
      expect((await settings(c)).priceKobo).toBe(150_000);
      // Left out is still fine, and keeps what was saved.
      await as(c)
        .put('/paid-dm/settings', { enabled: false, responseHours: 48 })
        .expect(200);
      expect(await stored(c)).toMatchObject({
        dmEnabled: false,
        dmPrice: 1500,
        dmResponseHours: 48,
      });
      await as(c).put('/paid-dm/settings', { enabled: true }).expect(200);
      expect(await stored(c)).toMatchObject({
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 48,
      });
    });

    it('does not let a null price past the floor or the set-a-price guard, and writes no row', async () => {
      const c = await creator('NullFresh');
      for (const body of [
        { enabled: true, priceKobo: null },
        { enabled: false, priceKobo: null },
        { enabled: true, responseHours: null },
      ]) {
        await as(c).put('/paid-dm/settings', body).expect(400);
      }
      expect(
        await prisma.creatorState.findUnique({
          where: { wawuUserId: c.sub },
        }),
      ).toBeNull();
    });

    it('turning off needs no price', async () => {
      const c = await creator('Off');
      await as(c).put('/paid-dm/settings', { enabled: false }).expect(200);
    });

    it('refuses turning on with no price saved or sent', async () => {
      const c = await creator('NoPrice', { dmEnabled: false, dmPrice: null });
      const res = await as(c)
        .put('/paid-dm/settings', { enabled: true })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('Set a price');
      expect((await stored(c)).dmEnabled).toBe(false);
    });

    it('refuses a price that is not whole naira, or outside the bounds, and changes nothing', async () => {
      const c = await creator('Bounds', { dmEnabled: true, dmPrice: 1500 });
      for (const priceKobo of [150_050, 4_900, 1_000_000_100, -100, 1.5]) {
        await as(c)
          .put('/paid-dm/settings', { enabled: true, priceKobo })
          .expect(400);
      }
      await as(c)
        .put('/paid-dm/settings', { enabled: true, priceKobo: '1500' })
        .expect(400);
      await as(c).put('/paid-dm/settings', { priceKobo: 100_000 }).expect(400);
      expect((await stored(c)).dmPrice).toBe(1500);
    });

    it('takes the lowest and the highest price', async () => {
      const c = await creator('Edges', { dmEnabled: true, dmPrice: 1500 });
      await as(c)
        .put('/paid-dm/settings', { enabled: true, priceKobo: 5_000 })
        .expect(200);
      expect((await stored(c)).dmPrice).toBe(50);
      await as(c)
        .put('/paid-dm/settings', { enabled: true, priceKobo: 1_000_000_000 })
        .expect(200);
      expect((await stored(c)).dmPrice).toBe(10_000_000);
    });

    it('refuses a reply time that is not on offer, unless it is the one already saved', async () => {
      const c = await creator('Window', {
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 36,
      });
      await as(c)
        .put('/paid-dm/settings', { enabled: true, responseHours: 30 })
        .expect(400);
      await as(c)
        .put('/paid-dm/settings', { enabled: true, responseHours: 0 })
        .expect(400);
      expect((await stored(c)).dmResponseHours).toBe(36);
      // An older value set through the web stays as it is.
      await as(c)
        .put('/paid-dm/settings', { enabled: true, responseHours: 36 })
        .expect(200);
      await as(c)
        .put('/paid-dm/settings', { enabled: true, responseHours: 168 })
        .expect(200);
      expect((await stored(c)).dmResponseHours).toBe(168);
    });

    it('refuses fields it does not know', async () => {
      const c = await creator('Unknown', { dmEnabled: true, dmPrice: 1500 });
      await as(c)
        .put('/paid-dm/settings', { enabled: true, dmPrice: 99 })
        .expect(400);
    });
  });

  describe('switched off for 7 days (I23)', () => {
    async function paused(label: string, daysLeft = 5) {
      const c = await creator(label, {
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 24,
      });
      await questions(c, { unanswered: 34, answered: 66 });
      const until = new Date(Date.now() + daysLeft * DAY);
      await prisma.creatorNoResponseTracker.create({
        data: {
          creatorWawuId: c.sub,
          penaltyState: 'disabled_7d',
          noResponseRatePct: 34,
          dmDisabledUntil: until,
        },
      });
      return { c, until };
    }

    it('reads as paused with the end date and the share that caused it, and the switch stays as the creator set it', async () => {
      const { c, until } = await paused('Locked');
      const s = await settings(c);
      expect(s.standing).toMatchObject({
        state: 'paused',
        acceptingPaidMessages: false,
        pausedUntil: until.toISOString(),
        unansweredPct: 34,
      });
      expect(s.enabled).toBe(true);
    });

    it('refuses every save with the reason a fan is given, and changes nothing', async () => {
      const { c, until } = await paused('LockedSave');
      const res = await as(c)
        .put('/paid-dm/settings', {
          enabled: true,
          priceKobo: 250_000,
          responseHours: 48,
        })
        .expect(403);
      const body = res.body as {
        message: string;
        reason?: { code: string; pausedUntil: string };
      };
      expect(body.reason?.code).toBe('paid_messages_paused');
      expect(body.reason?.pausedUntil).toBe(until.toISOString());
      await as(c).put('/paid-dm/settings', { enabled: false }).expect(403);
      expect(await stored(c)).toMatchObject({
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 24,
      });
    });

    it('lets the creator save again the moment the pause ends, by the clock alone', async () => {
      const c = await creator('Ended', { dmEnabled: true, dmPrice: 1500 });
      await prisma.creatorNoResponseTracker.create({
        data: {
          creatorWawuId: c.sub,
          penaltyState: 'disabled_7d',
          noResponseRatePct: 34,
          dmDisabledUntil: new Date(Date.now() - 1000),
        },
      });
      const s = data<PaidDmSettings>(
        await as(c)
          .put('/paid-dm/settings', { enabled: true, priceKobo: 250_000 })
          .expect(200),
      );
      expect(s.standing.state).not.toBe('paused');
      expect(s.priceKobo).toBe(250_000);
    });
  });

  describe('the options', () => {
    const KEYS = [
      'PAID_DM_PRICE_PRESETS_NAIRA',
      'PAID_DM_RESPONSE_WINDOWS_HOURS',
    ];
    const before = KEYS.map((k) => process.env[k]);
    afterEach(() => {
      KEYS.forEach((k, i) => {
        if (before[i] === undefined) delete process.env[k];
        else process.env[k] = before[i];
      });
    });

    it('come from config, ascending and without repeats, in kobo and hours', () => {
      process.env.PAID_DM_PRICE_PRESETS_NAIRA = '2500, 200,200,300';
      process.env.PAID_DM_RESPONSE_WINDOWS_HOURS = '168,12';
      expect(paidDmSettingsConfig()).toMatchObject({
        pricePresetsKobo: [20_000, 30_000, 250_000],
        responseWindowHours: [12, 168],
      });
    });

    it('fall back to the defaults when a list is empty, not numbers, or out of range', () => {
      for (const bad of ['', ' ', 'a,b', '100,,200', '10', '100.5', '0']) {
        process.env.PAID_DM_PRICE_PRESETS_NAIRA = bad;
        expect(paidDmSettingsConfig().pricePresetsKobo).toEqual([
          10_000, 50_000, 100_000, 250_000,
        ]);
      }
      process.env.PAID_DM_RESPONSE_WINDOWS_HOURS = '400';
      expect(paidDmSettingsConfig().responseWindowHours).toEqual([
        24, 48, 72, 168,
      ]);
    });
  });
});

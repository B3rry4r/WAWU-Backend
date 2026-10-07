import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  rolesOtherThan,
  seedAdminFixtures,
  type AdminTokens,
} from '../../common/tests/admin-session.helper';
import { LegalModule } from '../legal.module';
import { LegalIntakeModule } from '../../legal-intake/legal-intake.module';

/**
 * LEGAL-03: a phone call, a length for each kind of consultation, an hour that
 * stays taken, and several delivered files that all reach the chat. Every
 * price below is one this suite sets through the admin route (R-14): none is
 * written in the code or assumed from the database.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');

const ADMINS = adminFixtures('1e110003', 'legal-consult');
const SECRETS = adminJwtSecrets('legal-consult');

const READ_ROLES = ['superadmin', 'support', 'finance'] as const;
const PRICE_ROLES = ['superadmin', 'finance'] as const;
const DELIVER_ROLES = ['superadmin', 'support'] as const;

async function isMockUp(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK_WAWU_ID_URL}/health`)).ok;
  } catch {
    return false;
  }
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const subOf = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).sub;

describe('WAWU Legal consultations and deliverables (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let tokens: AdminTokens;
  let userToken: string;
  let otherToken: string;
  let userId: string;
  let otherId: string;
  const envSnapshot: Record<string, string | undefined> = {};
  let optionRows: Awaited<
    ReturnType<PrismaService['legalConsultationOption']['findMany']>
  >;
  let priceRows: Awaited<
    ReturnType<PrismaService['legalServicePrice']['findMany']>
  >;
  let createdIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  function setConsultation(
    medium: string,
    body: Record<string, unknown>,
    role: 'superadmin' | 'finance' = 'finance',
  ) {
    return http()
      .put(`/api/hub/legal/ops/prices/consultations/${medium}`)
      .set(bearer(tokens[role]))
      .send(body);
  }

  async function priceAll() {
    await setConsultation('zoom', { priceKobo: 1_500_000, minutes: 30 }).expect(
      200,
    );
    await setConsultation('phone', {
      priceKobo: 1_000_000,
      minutes: 20,
    }).expect(200);
    await setConsultation('physical', {
      priceKobo: null,
      minutes: null,
    }).expect(200);
  }

  /** A consultation request owned by `who`, created through the real route. */
  async function newRequest(token: string, serviceCode = 'contract-drafting') {
    const res = await http()
      .post('/api/hub/legal/requests')
      .set(as(token))
      .send({ serviceCode })
      .expect(201);
    createdIds.push(res.body.data.id);
    return res.body.data as { id: string; status: string };
  }

  async function slotsFor(medium: 'zoom' | 'phone', token = userToken) {
    const res = await http()
      .get('/api/hub/legal/consultation/slots')
      .query({ medium })
      .set(as(token))
      .expect(200);
    return res.body.data as {
      minutes: number;
      horizonDays: number;
      days: {
        date: string;
        slots: { startsAt: string; available: boolean }[];
      }[];
    };
  }

  /** The nth slot of the nth day, so tests never share an hour. */
  const pick = (
    cal: { days: { slots: { startsAt: string }[] }[] },
    day: number,
    slot: number,
  ) => cal.days[day].slots[slot].startsAt;

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;

    if (!(await isMockUp())) {
      mock = spawn('node', ['mock-wawu-id/server.js'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      mock.unref();
      for (let i = 0; i < 60 && !(await isMockUp()); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    userToken = await loginAs('user@test.wawu.dev');
    otherToken = await loginAs('creator-basic@test.wawu.dev');
    userId = subOf(userToken);
    otherId = subOf(otherToken);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        LegalModule,
        LegalIntakeModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
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
    await app.init();

    prisma = moduleRef.get(PrismaService);
    optionRows = await prisma.legalConsultationOption.findMany();
    priceRows = await prisma.legalServicePrice.findMany();
    await seedAdminFixtures(prisma, ADMINS);
    tokens = await loginAllAdmins(app, ADMINS);
  }, 40_000);

  afterEach(async () => {
    if (createdIds.length) {
      await prisma.legalDeliverable.deleteMany({
        where: { legalRequestId: { in: createdIds } },
      });
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: createdIds } },
      });
      await prisma.adminOpsAudit.deleteMany({
        where: { resourceId: { in: createdIds } },
      });
      await prisma.legalRequest.deleteMany({
        where: { id: { in: createdIds } },
      });
      createdIds = [];
    }
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: [userId, otherId] }, kind: 'legal_delivered' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Put the settings back exactly as they were found.
      await prisma.legalConsultationOption.deleteMany({});
      for (const r of optionRows) {
        await prisma.legalConsultationOption.create({ data: r });
      }
      await prisma.legalServicePrice.deleteMany({});
      for (const r of priceRows) {
        await prisma.legalServicePrice.create({ data: r });
      }
      await prisma.adminOpsAudit.deleteMany({
        where: {
          OR: [
            {
              resource: 'legal_price',
              actedByAdminId: { in: ADMINS.map((a) => a.id) },
            },
          ],
        },
      });
      await deleteAdminFixtures(prisma, ADMINS);
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /* ================================================================ */
  describe('prices are set in admin, by the right people', () => {
    it('refuses no credential and a WAWU ID user token on every price route', async () => {
      for (const [verb, url] of [
        ['get', '/api/hub/legal/ops/prices'],
        ['put', '/api/hub/legal/ops/prices/consultations/zoom'],
        ['put', '/api/hub/legal/ops/prices/services/cac-registration'],
      ] as const) {
        await http()
          [verb](url)
          .send({ priceKobo: 1_000_000, minutes: 30 })
          .expect(401);
        await http()
          [verb](url)
          .set(as(userToken))
          .send({ priceKobo: 1_000_000, minutes: 30 })
          .expect(401);
        await http()
          [verb](url)
          .set('Authorization', 'Bearer not-a-jwt')
          .send({})
          .expect(401);
      }
    });

    it.each(READ_ROLES)('%s can read the prices', async (role) => {
      const res = await http()
        .get('/api/hub/legal/ops/prices')
        .set(bearer(tokens[role]))
        .expect(200);
      expect(
        res.body.data.consultations.map((c: { medium: string }) => c.medium),
      ).toEqual(['chat', 'zoom', 'phone', 'physical']);
      expect(
        res.body.data.services
          .map((s: { serviceCode: string }) => s.serviceCode)
          .sort(),
      ).toEqual([
        'cac-registration',
        'data-protection-filing',
        'tax-registration',
      ]);
    });

    it.each(rolesOtherThan(READ_ROLES))(
      '%s cannot read the prices',
      async (role) => {
        await http()
          .get('/api/hub/legal/ops/prices')
          .set(bearer(tokens[role]))
          .expect(403);
      },
    );

    it.each(rolesOtherThan(PRICE_ROLES))(
      '%s cannot set a price, and none is written',
      async (role) => {
        const before = await prisma.legalConsultationOption.findUnique({
          where: { medium: 'phone' },
        });
        await setConsultation(
          'phone',
          { priceKobo: 5_000_000, minutes: 45 },
          role as never,
        ).expect(403);
        await http()
          .put('/api/hub/legal/ops/prices/services/cac-registration')
          .set(bearer(tokens[role]))
          .send({ priceKobo: 5_000_000 })
          .expect(403);
        expect(
          await prisma.legalConsultationOption.findUnique({
            where: { medium: 'phone' },
          }),
        ).toEqual(before);
        expect(
          await prisma.legalServicePrice.findUnique({
            where: { serviceCode: 'cac-registration' },
          }),
        ).toBeNull();
      },
    );

    it.each([
      ['a string price', { priceKobo: '1500000', minutes: 30 }],
      ['a decimal price', { priceKobo: 1500000.5, minutes: 30 }],
      [
        'a price that is not whole naira',
        { priceKobo: 1_500_050, minutes: 30 },
      ],
      ['a price under one naira', { priceKobo: 50, minutes: 30 }],
      ['a negative price', { priceKobo: -100, minutes: 30 }],
      [
        'a price over the merchant cap',
        { priceKobo: 1_000_000_100, minutes: 30 },
      ],
      ['no price at all', { minutes: 30 }],
      ['a string length', { priceKobo: 1_500_000, minutes: '30' }],
      ['a length of zero', { priceKobo: 1_500_000, minutes: 0 }],
      ['a length past the working day', { priceKobo: 1_500_000, minutes: 481 }],
      ['no length at all', { priceKobo: 1_500_000 }],
      [
        'enabled as a string',
        { priceKobo: 1_500_000, minutes: 30, enabled: 'yes' },
      ],
      ['an unknown field', { priceKobo: 1_500_000, minutes: 30, free: true }],
      ['an empty body', {}],
    ])('refuses %s with a 400, never a 500', async (_label, body) => {
      await setConsultation('zoom', body).expect(400);
    });

    it('refuses a body that is not an object, a null body and an array', async () => {
      for (const raw of ['null', '[]', '"zoom"', '12']) {
        await http()
          .put('/api/hub/legal/ops/prices/consultations/zoom')
          .set(bearer(tokens.finance))
          .set('Content-Type', 'application/json')
          .send(raw)
          .expect(400);
      }
    });

    it('refuses a medium that does not exist, in any spelling', async () => {
      for (const medium of ['video', 'ZOOM', 'zoom%20', 'in_person', '0']) {
        await setConsultation(medium, {
          priceKobo: 1_500_000,
          minutes: 30,
        }).expect(400);
      }
    });

    it('lets WAWU price an in-person consultation, which the app shows and the web never charges', async () => {
      await priceAll();
      await setConsultation('physical', {
        priceKobo: 2_000_000,
        minutes: 90,
      }).expect(200);
      const offered = await http()
        .get('/api/hub/legal/consultation/options')
        .set(as(userToken))
        .expect(200);
      expect(offered.body.data.options).toContainEqual({
        medium: 'physical',
        label: 'In person',
        minutes: 90,
        priceKobo: 2_000_000,
        onRequest: true,
      });
      const catalogue = await http()
        .get('/api/hub/legal/catalogue')
        .set(as(userToken))
        .expect(200);
      expect(catalogue.body.data.consultationOptions).toContainEqual({
        medium: 'physical',
        label: 'In person',
        minutes: null,
        feeNaira: null,
      });
      const mine = await newRequest(userToken);
      const web = await http()
        .post(`/api/hub/legal/requests/${mine.id}/consultation`)
        .set(as(userToken))
        .send({ medium: 'physical' })
        .expect(200);
      expect(web.body.data.flutterwaveConfig).toBeNull();
      expect(web.body.data.request.consultationFee).toBeNull();
      const app = await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'physical' })
        .expect(200);
      expect(app.body.data).toMatchObject({
        minutes: 90,
        priceKobo: 2_000_000,
        scheduledFor: null,
      });
      await setConsultation('physical', {
        priceKobo: null,
        minutes: null,
      }).expect(200);
    });

    it('records who set a price, with the old and the new value', async () => {
      const res = await setConsultation(
        'zoom',
        { priceKobo: 1_500_000, minutes: 30 },
        'superadmin',
      ).expect(200);
      expect(res.body.data).toMatchObject({
        medium: 'zoom',
        label: 'Video call',
        priceKobo: 1_500_000,
        minutes: 30,
        enabled: true,
        offered: true,
      });
      const audit = await prisma.adminOpsAudit.findFirst({
        where: {
          resource: 'legal_price',
          resourceId: 'consultation:zoom',
          action: 'legal_price_set',
        },
        orderBy: { actedAt: 'desc' },
      });
      expect(audit?.actedByAdminEmail).toBe(
        ADMINS.find((a) => a.role === 'superadmin')!.email,
      );
      expect(audit?.detail).toMatchObject({
        to: { priceKobo: 1_500_000, minutes: 30, enabled: true },
      });
    });

    it('prices a fixed-price service, and clears it back to a quote', async () => {
      await http()
        .put('/api/hub/legal/ops/prices/services/not-a-service')
        .set(bearer(tokens.finance))
        .send({ priceKobo: 1_000_000 })
        .expect(404);
      await http()
        .put('/api/hub/legal/ops/prices/services/contract-drafting')
        .set(bearer(tokens.finance))
        .send({ priceKobo: 1_000_000 })
        .expect(400);
      for (const bad of [
        { priceKobo: 'free' },
        { priceKobo: 12_345 },
        {},
        { priceKobo: 1_000_000, extra: 1 },
      ]) {
        await http()
          .put('/api/hub/legal/ops/prices/services/cac-registration')
          .set(bearer(tokens.finance))
          .send(bad)
          .expect(400);
      }

      await http()
        .put('/api/hub/legal/ops/prices/services/cac-registration')
        .set(bearer(tokens.finance))
        .send({ priceKobo: 3_500_000 })
        .expect(200);

      // The web's catalogue carries it, in whole naira, and a new request
      // starts quoted at it.
      const catalogue = await http()
        .get('/api/hub/legal/catalogue')
        .set(as(userToken))
        .expect(200);
      const cac = catalogue.body.data.services.find(
        (s: { code: string }) => s.code === 'cac-registration',
      );
      expect(cac.priceNaira).toBe(35_000);
      const created = await http()
        .post('/api/hub/legal/requests')
        .set(as(userToken))
        .send({
          serviceCode: 'cac-registration',
          documents: ['https://files.example.com/id.pdf'],
        })
        .expect(201);
      createdIds.push(created.body.data.id);
      expect(created.body.data).toMatchObject({
        status: 'quoted',
        quoteAmount: 35_000,
      });

      await http()
        .put('/api/hub/legal/ops/prices/services/cac-registration')
        .set(bearer(tokens.finance))
        .send({ priceKobo: null })
        .expect(200);
      const cleared = await http()
        .post('/api/hub/legal/requests')
        .set(as(userToken))
        .send({
          serviceCode: 'cac-registration',
          documents: ['https://files.example.com/id.pdf'],
        })
        .expect(201);
      createdIds.push(cleared.body.data.id);
      expect(cleared.body.data).toMatchObject({
        status: 'awaiting_quote',
        quoteAmount: null,
      });
    });
  });

  /* ================================================================ */
  describe('what the app offers', () => {
    it('offers video, phone and in person at the length and price set in admin', async () => {
      await priceAll();
      const res = await http()
        .get('/api/hub/legal/consultation/options')
        .set(as(userToken))
        .expect(200);
      expect(res.body.data.timeZone).toBe('Africa/Lagos');
      expect(res.body.data.options).toEqual([
        {
          medium: 'zoom',
          label: 'Video call',
          minutes: 30,
          priceKobo: 1_500_000,
          onRequest: false,
        },
        {
          medium: 'phone',
          label: 'Phone call',
          minutes: 20,
          priceKobo: 1_000_000,
          onRequest: false,
        },
        {
          medium: 'physical',
          label: 'In person',
          minutes: null,
          priceKobo: null,
          onRequest: true,
        },
      ]);
    });

    it('refuses it without a sign-in', async () => {
      await http().get('/api/hub/legal/consultation/options').expect(401);
      await http()
        .get('/api/hub/legal/consultation/slots')
        .query({ medium: 'zoom' })
        .expect(401);
    });

    it('does not offer a call nobody has priced, or one switched off', async () => {
      await priceAll();
      await setConsultation('phone', { priceKobo: null, minutes: null }).expect(
        200,
      );
      let res = await http()
        .get('/api/hub/legal/consultation/options')
        .set(as(userToken))
        .expect(200);
      expect(
        res.body.data.options.map((o: { medium: string }) => o.medium),
      ).toEqual(['zoom', 'physical']);

      await setConsultation('phone', {
        priceKobo: 1_000_000,
        minutes: 20,
        enabled: false,
      }).expect(200);
      res = await http()
        .get('/api/hub/legal/consultation/options')
        .set(as(userToken))
        .expect(200);
      expect(
        res.body.data.options.map((o: { medium: string }) => o.medium),
      ).toEqual(['zoom', 'physical']);
      // Switching it off keeps the price.
      const row = await prisma.legalConsultationOption.findUnique({
        where: { medium: 'phone' },
      });
      expect(row).toMatchObject({
        priceKobo: 1_000_000,
        minutes: 20,
        enabled: false,
      });
      await http()
        .get('/api/hub/legal/consultation/slots')
        .query({ medium: 'phone' })
        .set(as(userToken))
        .expect(400);
    });

    it('moves the web catalogue with the same prices, and never lists a phone call there', async () => {
      await priceAll();
      await setConsultation('chat', {
        priceKobo: 2_000_000,
        minutes: 45,
      }).expect(200);
      const res = await http()
        .get('/api/hub/legal/catalogue')
        .set(as(userToken))
        .expect(200);
      expect(res.body.data.consultationOptions).toEqual([
        { medium: 'chat', label: 'Chat', minutes: 45, feeNaira: 20_000 },
        { medium: 'zoom', label: 'Zoom call', minutes: 30, feeNaira: 15_000 },
        {
          medium: 'physical',
          label: 'In person',
          minutes: null,
          feeNaira: null,
        },
      ]);
    });

    it.each([[''], ['ZOOM'], ['physical'], ['chat'], ['0'], ['zoom,phone']])(
      'refuses the slots for medium %j with a 400',
      async (medium) => {
        await priceAll();
        await http()
          .get('/api/hub/legal/consultation/slots')
          .query({ medium })
          .set(as(userToken))
          .expect(400);
      },
    );

    it('refuses slots with no medium, a repeated medium or a stray query field', async () => {
      await http()
        .get('/api/hub/legal/consultation/slots')
        .set(as(userToken))
        .expect(400);
      await http()
        .get('/api/hub/legal/consultation/slots?medium=zoom&medium=phone')
        .set(as(userToken))
        .expect(400);
      await http()
        .get('/api/hub/legal/consultation/slots?medium=zoom&day=1')
        .set(as(userToken))
        .expect(400);
    });

    it('refuses a medium written with a NUL, a lone surrogate or odd text', async () => {
      for (const odd of ['%00', '%ED%A0%80', 'zoom%00', '%FF', '%20', 'ZOOM']) {
        await http()
          .get(`/api/hub/legal/consultation/slots?medium=${odd}`)
          .set(as(userToken))
          .expect(400);
      }
    });

    it('offers the calendar at the length of the call, and never past closing', async () => {
      await priceAll();
      await setConsultation('phone', {
        priceKobo: 1_000_000,
        minutes: 90,
      }).expect(200);
      const zoom = await slotsFor('zoom');
      const phone = await slotsFor('phone');
      expect(zoom).toMatchObject({ minutes: 30, horizonDays: 21 });
      expect(phone.minutes).toBe(90);
      // 16:00 Lagos is the last hourly start; a 90 minute call from there runs
      // past 17:00, so it is not offered.
      expect(zoom.days[0].slots).toHaveLength(8);
      expect(phone.days[0].slots).toHaveLength(7);
    });
  });

  /* ================================================================ */
  describe('a booked hour is held', () => {
    it('holds the hour for the person who booked it and takes it from everyone else', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const theirs = await newRequest(otherToken);
      const cal = await slotsFor('zoom');
      const start = pick(cal, 0, 1);

      const booked = await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(200);
      expect(booked.body.data).toMatchObject({
        requestId: mine.id,
        status: 'awaiting_consultation_payment',
        medium: 'zoom',
        label: 'Video call',
        minutes: 30,
        priceKobo: 1_500_000,
        scheduledFor: start,
        paid: false,
        paidAt: null,
      });
      const expires = new Date(booked.body.data.holdExpiresAt).getTime();
      expect(expires).toBeGreaterThan(Date.now() + 25 * 60_000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 31 * 60_000);

      // Another person sees it gone, and cannot book it.
      const seen = await slotsFor('zoom', otherToken);
      expect(seen.days[0].slots[1]).toEqual({
        startsAt: start,
        available: false,
      });
      expect(seen.days[0].slots[0].available).toBe(true);
      const refused = await http()
        .post(`/api/hub/legal/requests/${theirs.id}/booking`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(409);
      expect(refused.body.message).toMatch(/taken/i);
      // The web's calendar and the web's booking agree.
      const legacy = await http()
        .get('/api/hub/legal/availability')
        .set(as(otherToken))
        .expect(200);
      expect(
        legacy.body.data.days
          .flatMap(
            (d: { slots: { startsAt: string; available: boolean }[] }) =>
              d.slots,
          )
          .find((s: { startsAt: string }) => s.startsAt === start).available,
      ).toBe(false);
      await http()
        .post(`/api/hub/legal/requests/${theirs.id}/consultation`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(409);
      expect(
        (await prisma.legalRequest.findUnique({ where: { id: theirs.id } }))
          ?.scheduledFor,
      ).toBeNull();

      // The person's own booking reads back.
      const read = await http()
        .get(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .expect(200);
      expect(read.body.data).toMatchObject({
        scheduledFor: start,
        medium: 'zoom',
        minutes: 30,
      });
    });

    it('lets a person move their own booking, which frees the old hour', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const cal = await slotsFor('zoom');
      const first = pick(cal, 1, 2);
      const second = pick(cal, 1, 3);
      for (const start of [first, second]) {
        await http()
          .post(`/api/hub/legal/requests/${mine.id}/booking`)
          .set(as(userToken))
          .send({ medium: 'zoom', scheduledFor: start })
          .expect(200);
      }
      const seen = await slotsFor('zoom', otherToken);
      expect(seen.days[1].slots[2].available).toBe(true);
      expect(seen.days[1].slots[3].available).toBe(false);
      // The same person books the hour they already hold, and it is theirs.
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: second })
        .expect(200);
    });

    it('takes every hour a longer call runs into, and only those', async () => {
      await priceAll();
      await setConsultation('phone', {
        priceKobo: 1_000_000,
        minutes: 90,
      }).expect(200);
      const mine = await newRequest(userToken);
      const theirs = await newRequest(otherToken);
      const cal = await slotsFor('phone');
      // 10:00, which runs to 11:30.
      const start = pick(cal, 2, 1);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'phone', scheduledFor: start })
        .expect(200);
      const zoom = await slotsFor('zoom', otherToken);
      expect(zoom.days[2].slots.map((s) => s.available)).toEqual([
        true, // 09:00
        false, // 10:00
        false, // 11:00 (the call runs to 11:30)
        true, // 12:00
        true,
        true,
        true,
        true,
      ]);
      await http()
        .post(`/api/hub/legal/requests/${theirs.id}/booking`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: pick(zoom, 2, 2) })
        .expect(409);
      await http()
        .post(`/api/hub/legal/requests/${theirs.id}/booking`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: pick(zoom, 2, 3) })
        .expect(200);
    });

    it('lets exactly one of two people who pick the same hour at the same moment have it', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const theirs = await newRequest(otherToken);
      const start = pick(await slotsFor('zoom'), 3, 1);
      const results = await Promise.all([
        http()
          .post(`/api/hub/legal/requests/${mine.id}/booking`)
          .set(as(userToken))
          .send({ medium: 'zoom', scheduledFor: start }),
        http()
          .post(`/api/hub/legal/requests/${theirs.id}/booking`)
          .set(as(otherToken))
          .send({ medium: 'zoom', scheduledFor: start }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('lets exactly one of two overlapping calls at different starts have the time', async () => {
      await priceAll();
      await setConsultation('phone', {
        priceKobo: 1_000_000,
        minutes: 90,
      }).expect(200);
      const mine = await newRequest(userToken);
      const theirs = await newRequest(otherToken);
      const cal = await slotsFor('phone');
      const results = await Promise.all([
        http()
          .post(`/api/hub/legal/requests/${mine.id}/booking`)
          .set(as(userToken))
          .send({ medium: 'phone', scheduledFor: pick(cal, 4, 1) }),
        http()
          .post(`/api/hub/legal/requests/${theirs.id}/booking`)
          .set(as(otherToken))
          .send({ medium: 'zoom', scheduledFor: pick(cal, 4, 2) }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('gives the hour back when the unpaid hold runs out', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const theirs = await newRequest(otherToken);
      const start = pick(await slotsFor('zoom'), 5, 1);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(200);
      await prisma.$executeRaw`UPDATE "LegalRequest" SET "updatedAt" = now() - interval '31 minutes' WHERE id = ${mine.id}`;
      expect(
        (await slotsFor('zoom', otherToken)).days[5].slots[1].available,
      ).toBe(true);
      await http()
        .post(`/api/hub/legal/requests/${theirs.id}/booking`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(200);
    });

    it('keeps a paid hour for as long as it stands, and a cancelled one lets go', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const theirs = await newRequest(otherToken);
      const start = pick(await slotsFor('zoom'), 6, 1);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(200);
      await prisma.legalRequest.update({
        where: { id: mine.id },
        data: {
          consultationPaidAt: new Date(),
          status: 'consultation_scheduled',
        },
      });
      await prisma.$executeRaw`UPDATE "LegalRequest" SET "updatedAt" = now() - interval '5 days' WHERE id = ${mine.id}`;
      const paid = await http()
        .get(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .expect(200);
      expect(paid.body.data).toMatchObject({ paid: true, holdExpiresAt: null });
      expect(
        (await slotsFor('zoom', otherToken)).days[6].slots[1].available,
      ).toBe(false);
      await http()
        .post(`/api/hub/legal/requests/${theirs.id}/booking`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(409);
      // A paid consultation cannot be booked again.
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({
          medium: 'zoom',
          scheduledFor: pick(await slotsFor('zoom'), 6, 2),
        })
        .expect(409);
    });

    it('records an in-person request with no hour, and lets go of a held one', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const start = pick(await slotsFor('zoom'), 7, 1);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(200);
      const res = await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'physical' })
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'awaiting_consultation_payment',
        medium: 'physical',
        label: 'In person',
        minutes: null,
        priceKobo: null,
        scheduledFor: null,
        holdExpiresAt: null,
      });
      expect(
        (await slotsFor('zoom', otherToken)).days[7].slots[1].available,
      ).toBe(true);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'physical', scheduledFor: start })
        .expect(400);
    });

    it('refuses a booking that is not one the calendar offers, with a 400', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const cal = await slotsFor('zoom');
      const real = pick(cal, 8, 1);
      const halfPast = new Date(
        new Date(real).getTime() + 30 * 60_000,
      ).toISOString();
      const weekendDay = (() => {
        const d = new Date(real);
        while (![0, 6].includes(d.getUTCDay()))
          d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString();
      })();
      for (const body of [
        { medium: 'zoom' },
        { medium: 'zoom', scheduledFor: null },
        { medium: 'zoom', scheduledFor: 1_790_000_000 },
        { medium: 'zoom', scheduledFor: '' },
        { medium: 'zoom', scheduledFor: 'tomorrow at ten' },
        { medium: 'zoom', scheduledFor: '2026-13-45T10:00:00Z' },
        { medium: 'zoom', scheduledFor: real.slice(0, 10) },
        { medium: 'zoom', scheduledFor: halfPast },
        { medium: 'zoom', scheduledFor: weekendDay },
        { medium: 'zoom', scheduledFor: '2020-01-06T08:00:00.000Z' },
        { medium: 'zoom', scheduledFor: [real] },
        { medium: 'chat', scheduledFor: real },
        { medium: 'video', scheduledFor: real },
        { medium: 5, scheduledFor: real },
        { medium: null, scheduledFor: real },
        { scheduledFor: real },
        {},
        { medium: 'zoom', scheduledFor: real, note: 'x' },
      ]) {
        const res = await http()
          .post(`/api/hub/legal/requests/${mine.id}/booking`)
          .set(as(userToken))
          .send(body);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
      expect(
        (await prisma.legalRequest.findUnique({ where: { id: mine.id } }))
          ?.scheduledFor,
      ).toBeNull();
    });

    it('refuses a body that is not an object with a 400', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      for (const raw of ['null', '[]', '"zoom"', '7']) {
        await http()
          .post(`/api/hub/legal/requests/${mine.id}/booking`)
          .set(as(userToken))
          .set('Content-Type', 'application/json')
          .send(raw)
          .expect(400);
      }
    });

    it("answers a request that is not the caller's, or does not exist, or is not an id, correctly", async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const start = pick(await slotsFor('zoom'), 9, 1);
      // Somebody else's request is a 404, never a 403, so ids cannot be probed.
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(otherToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(404);
      await http()
        .get(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(otherToken))
        .expect(404);
      await http()
        .get(`/api/hub/legal/requests/${mine.id}/deliverables`)
        .set(as(otherToken))
        .expect(404);
      await http()
        .post(`/api/hub/legal/requests/${crypto.randomUUID()}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(404);
      await http()
        .post('/api/hub/legal/requests/not-an-id/booking')
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(400);
      await http()
        .get('/api/hub/legal/requests/not-an-id/booking')
        .set(as(userToken))
        .expect(400);
      await http()
        .get('/api/hub/legal/requests/not-an-id/deliverables')
        .set(as(userToken))
        .expect(400);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(401);
      expect(
        (await prisma.legalRequest.findUnique({ where: { id: mine.id } }))
          ?.scheduledFor,
      ).toBeNull();
    });

    it('does not book a service that needs no consultation, or a call nobody has priced', async () => {
      await priceAll();
      const simple = await http()
        .post('/api/hub/legal/requests')
        .set(as(userToken))
        .send({
          serviceCode: 'tax-registration',
          documents: ['https://files.example.com/tin.pdf'],
        })
        .expect(201);
      createdIds.push(simple.body.data.id);
      const start = pick(await slotsFor('zoom'), 10, 1);
      await http()
        .post(`/api/hub/legal/requests/${simple.body.data.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(400);

      const mine = await newRequest(userToken);
      await setConsultation('phone', { priceKobo: null, minutes: null }).expect(
        200,
      );
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'phone', scheduledFor: start })
        .expect(400);
      await setConsultation('zoom', {
        priceKobo: 1_500_000,
        minutes: 30,
        enabled: false,
      }).expect(200);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(400);
    });

    it('does not let a changed price move a booking already made', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const start = pick(await slotsFor('zoom'), 11, 1);
      await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'zoom', scheduledFor: start })
        .expect(200);
      await setConsultation('zoom', {
        priceKobo: 9_900_000,
        minutes: 60,
      }).expect(200);
      const read = await http()
        .get(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .expect(200);
      expect(read.body.data).toMatchObject({
        priceKobo: 1_500_000,
        minutes: 30,
      });
    });

    it('books a phone call at its own price and length', async () => {
      await priceAll();
      const mine = await newRequest(userToken);
      const start = pick(await slotsFor('phone'), 12, 0);
      const res = await http()
        .post(`/api/hub/legal/requests/${mine.id}/booking`)
        .set(as(userToken))
        .send({ medium: 'phone', scheduledFor: start })
        .expect(200);
      expect(res.body.data).toMatchObject({
        medium: 'phone',
        label: 'Phone call',
        minutes: 20,
        priceKobo: 1_000_000,
      });
      // The stored row is the new medium, and the web's reads of it still answer.
      const web = await http()
        .get(`/api/hub/legal/requests/${mine.id}`)
        .set(as(userToken))
        .expect(200);
      expect(web.body.data).toMatchObject({
        consultationMedium: 'phone',
        consultationFee: 10_000,
      });
      expect(Object.keys(web.body.data)).not.toContain('consultationMinutes');
    });
  });

  /* ================================================================ */
  describe('several delivered files', () => {
    const FILES = [
      {
        fileName: 'Reviewed tenancy agreement.pdf',
        url: 'https://files.example.com/reviewed.pdf',
        pages: 12,
      },
      {
        fileName: 'Consultant notes.pdf',
        url: 'https://files.example.com/notes.pdf',
        pages: 3,
      },
    ];

    async function paidWork(status = 'in_progress') {
      const row = await prisma.legalRequest.create({
        data: {
          wawuUserId: userId,
          serviceCode: 'contract-review',
          serviceName: 'Contract review',
          category: 'Contracts',
          path: 'consultation',
          status: status as never,
          servicePaidAt:
            status === 'in_progress' || status === 'delivered'
              ? new Date()
              : null,
        },
      });
      createdIds.push(row.id);
      return row;
    }

    const deliver = (
      id: string,
      body: unknown,
      role: 'superadmin' | 'support' = 'support',
    ) =>
      http()
        .post(`/api/hub/legal/ops/requests/${id}/deliverables`)
        .set(bearer(tokens[role]))
        .send(body as object);

    it('posts both files into the chat, in order, and lists them for the client', async () => {
      const work = await paidWork();
      const res = await deliver(work.id, { files: FILES }).expect(200);
      expect(res.body.data).toMatchObject({
        requestId: work.id,
        status: 'delivered',
      });
      expect(res.body.data.items).toHaveLength(2);

      // Both appear in the chat the client reads, from the consultant, oldest first.
      const chat = await http()
        .get(`/api/hub/legal/intake/chat/${work.id}`)
        .set(as(userToken))
        .expect(200);
      const bodies = chat.body.data.messages.map(
        (m: { body: string; authorRole: string }) => [m.authorRole, m.body],
      );
      expect(bodies).toEqual([
        ['consultant', 'Reviewed tenancy agreement.pdf'],
        ['consultant', 'Consultant notes.pdf'],
      ]);

      // The client's own list of files names the message each arrived as.
      const list = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(list.body.data.status).toBe('delivered');
      expect(
        list.body.data.items.map(
          (i: { fileName: string; pages: number; url: string }) => [
            i.fileName,
            i.pages,
            i.url,
          ],
        ),
      ).toEqual(FILES.map((f) => [f.fileName, f.pages, f.url]));
      const messageIds = chat.body.data.messages.map(
        (m: { id: string }) => m.id,
      );
      expect(
        list.body.data.items.map(
          (i: { chatMessageId: string }) => i.chatMessageId,
        ),
      ).toEqual(messageIds);

      // The request itself still names the first file, for everything that reads one.
      const web = await http()
        .get(`/api/hub/legal/requests/${work.id}`)
        .set(as(userToken))
        .expect(200);
      expect(web.body.data).toMatchObject({
        status: 'delivered',
        deliverableUrl: FILES[0].url,
      });

      // The client is told, once.
      const notes = await prisma.notification.findMany({
        where: { userWawuId: userId, kind: 'legal_delivered' },
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        title: 'Your documents are ready',
        actionHref: `/legal/requests/${work.id}`,
      });
      expect(notes[0].body).toContain('2 documents');
      expect(notes[0].body).not.toContain('—');

      const audit = await prisma.adminOpsAudit.findFirst({
        where: { resourceId: work.id, action: 'legal_delivered' },
      });
      expect(audit?.detail).toMatchObject({ fileCount: 2 });
    });

    it('does not post the same file twice, and adds a new one to delivered work', async () => {
      const work = await paidWork();
      await deliver(work.id, { files: FILES }).expect(200);
      const again = await deliver(work.id, { files: FILES }).expect(200);
      expect(again.body.data.items).toHaveLength(2);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(2);
      expect(
        await prisma.notification.count({
          where: { userWawuId: userId, kind: 'legal_delivered' },
        }),
      ).toBe(1);

      const third = {
        fileName: 'Signed copy.pdf',
        url: 'https://files.example.com/signed.pdf',
      };
      const more = await deliver(work.id, { files: [FILES[0], third] }).expect(
        200,
      );
      expect(
        more.body.data.items.map((i: { fileName: string }) => i.fileName),
      ).toEqual([FILES[0].fileName, FILES[1].fileName, 'Signed copy.pdf']);
      expect(more.body.data.items[2].pages).toBeNull();
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(3);
      // Delivering again never rewrites the first file or the time it was delivered.
      const row = await prisma.legalRequest.findUnique({
        where: { id: work.id },
      });
      expect(row?.deliverableUrl).toBe(FILES[0].url);
    });

    it('delivers two copies of one file in one request as one file', async () => {
      const work = await paidWork();
      const res = await deliver(work.id, {
        files: [FILES[0], FILES[0]],
      }).expect(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(1);
    });

    it.each(DELIVER_ROLES)('%s can deliver', async (role) => {
      const work = await paidWork();
      await deliver(work.id, { files: [FILES[0]] }, role).expect(200);
    });

    it.each(rolesOtherThan(DELIVER_ROLES))(
      '%s cannot deliver, and nothing is posted',
      async (role) => {
        const work = await paidWork();
        await http()
          .post(`/api/hub/legal/ops/requests/${work.id}/deliverables`)
          .set(bearer(tokens[role]))
          .send({ files: FILES })
          .expect(403);
        expect(
          await prisma.legalChatMessage.count({
            where: { legalRequestId: work.id },
          }),
        ).toBe(0);
        expect(
          (await prisma.legalRequest.findUnique({ where: { id: work.id } }))
            ?.status,
        ).toBe('in_progress');
      },
    );

    it('refuses no credential and a user token', async () => {
      const work = await paidWork();
      await http()
        .post(`/api/hub/legal/ops/requests/${work.id}/deliverables`)
        .send({ files: FILES })
        .expect(401);
      await http()
        .post(`/api/hub/legal/ops/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .send({ files: FILES })
        .expect(401);
    });

    it.each([
      ['no files', { files: [] }],
      ['no body field', {}],
      ['files as a string', { files: 'a.pdf' }],
      ['files as an object', { files: { fileName: 'a.pdf' } }],
      ['a null file', { files: [null] }],
      [
        'a file with no name',
        { files: [{ url: 'https://files.example.com/a.pdf' }] },
      ],
      [
        'a blank name',
        {
          files: [{ fileName: '   ', url: 'https://files.example.com/a.pdf' }],
        },
      ],
      [
        'a name with a control character',
        {
          files: [
            { fileName: 'a\u0000.pdf', url: 'https://files.example.com/a.pdf' },
          ],
        },
      ],
      [
        'a name with a lone surrogate',
        {
          files: [
            { fileName: 'a\ud800.pdf', url: 'https://files.example.com/a.pdf' },
          ],
        },
      ],
      [
        'a name that is a number',
        { files: [{ fileName: 7, url: 'https://files.example.com/a.pdf' }] },
      ],
      [
        'a name that is far too long',
        {
          files: [
            {
              fileName: 'a'.repeat(201),
              url: 'https://files.example.com/a.pdf',
            },
          ],
        },
      ],
      [
        'a url that is not a link',
        { files: [{ fileName: 'a.pdf', url: 'a.pdf' }] },
      ],
      [
        'a javascript url',
        { files: [{ fileName: 'a.pdf', url: 'javascript:alert(1)' }] },
      ],
      [
        'an ftp url',
        {
          files: [{ fileName: 'a.pdf', url: 'ftp://files.example.com/a.pdf' }],
        },
      ],
      [
        'a url that is far too long',
        {
          files: [
            {
              fileName: 'a.pdf',
              url: `https://files.example.com/${'a'.repeat(600)}`,
            },
          ],
        },
      ],
      [
        'pages as a string',
        {
          files: [
            {
              fileName: 'a.pdf',
              url: 'https://files.example.com/a.pdf',
              pages: '3',
            },
          ],
        },
      ],
      [
        'zero pages',
        {
          files: [
            {
              fileName: 'a.pdf',
              url: 'https://files.example.com/a.pdf',
              pages: 0,
            },
          ],
        },
      ],
      [
        'half a page',
        {
          files: [
            {
              fileName: 'a.pdf',
              url: 'https://files.example.com/a.pdf',
              pages: 1.5,
            },
          ],
        },
      ],
      [
        'an unknown file field',
        {
          files: [
            {
              fileName: 'a.pdf',
              url: 'https://files.example.com/a.pdf',
              size: 1,
            },
          ],
        },
      ],
      [
        'eleven files',
        {
          files: Array.from({ length: 11 }, (_, i) => ({
            fileName: `f${i}.pdf`,
            url: `https://files.example.com/f${i}.pdf`,
          })),
        },
      ],
    ])('refuses %s with a 400, never a 500', async (_label, body) => {
      const work = await paidWork();
      await deliver(work.id, body).expect(400);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(0);
      expect(
        (await prisma.legalRequest.findUnique({ where: { id: work.id } }))
          ?.status,
      ).toBe('in_progress');
    });

    it('refuses a body that is not an object, with a 400', async () => {
      const work = await paidWork();
      for (const raw of ['null', '[]', '"x"', '3']) {
        await http()
          .post(`/api/hub/legal/ops/requests/${work.id}/deliverables`)
          .set(bearer(tokens.support))
          .set('Content-Type', 'application/json')
          .send(raw)
          .expect(400);
      }
    });

    it('delivers only paid work in progress, and answers an unknown or malformed id', async () => {
      for (const status of [
        'draft',
        'quoted',
        'awaiting_service_payment',
        'cancelled',
      ]) {
        const row = await paidWork(status);
        await deliver(row.id, { files: [FILES[0]] }).expect(409);
      }
      const unpaid = await prisma.legalRequest.create({
        data: {
          wawuUserId: userId,
          serviceCode: 'contract-review',
          serviceName: 'Contract review',
          category: 'Contracts',
          path: 'consultation',
          status: 'in_progress',
        },
      });
      createdIds.push(unpaid.id);
      await deliver(unpaid.id, { files: [FILES[0]] }).expect(400);
      await deliver(crypto.randomUUID(), { files: [FILES[0]] }).expect(404);
      await deliver('not-an-id', { files: [FILES[0]] }).expect(400);
    });

    it('still delivers one file through the original route, and the client sees it', async () => {
      const work = await paidWork();
      await http()
        .post(`/api/hub/legal/ops/requests/${work.id}/deliver`)
        .set(bearer(tokens.support))
        .send({
          deliverableUrl: 'https://files.example.com/Final%20agreement.pdf',
        })
        .expect(200);
      const list = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0]).toMatchObject({
        fileName: 'Final agreement.pdf',
        url: 'https://files.example.com/Final%20agreement.pdf',
        pages: null,
        chatMessageId: null,
      });

      // More files added later sit after it; the first file stays listed.
      await deliver(work.id, { files: [FILES[1]] }).expect(200);
      const after = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(after.body.data.items.map((i: { url: string }) => i.url)).toEqual([
        'https://files.example.com/Final%20agreement.pdf',
        FILES[1].url,
      ]);
    });

    it('lists nothing before anything is delivered', async () => {
      const work = await paidWork();
      const list = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(list.body.data).toMatchObject({
        status: 'in_progress',
        items: [],
      });
    });
  });
});

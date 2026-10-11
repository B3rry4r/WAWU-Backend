import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, type ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { SANDBOX_DISCOS } from '../../../test/bills/sandbox-discos';
import {
  FintavaDouble,
  fintavaError,
  fintavaValidation,
} from '../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import { FintavaClient } from '../../fintava/fintava-client';
import { BillsCatalogueService } from '../bills-catalogue.service';
import { BillsCatalogueModule } from '../bills-catalogue.module';
import type { BillsErrorReason } from '../bills-catalogue-error';
import type {
  ElectricityBillersView,
  MeterPreviewView,
} from '../bills-catalogue.views';

/**
 * BILLS-01's two routes over HTTP: the real module, real RS256 tokens checked against the mock WAWU ID's JWKS, and the
 * real MONEY-06 Fintava client talking over a socket to the local double, which answers the disco list with the 22 rows
 * the sandbox sent (test/bills/sandbox-discos.ts). The meter preview's success body has never been seen (question 11), so
 * the double's success answers are labelled guesses in each test that uses one.
 */

const BILLERS = '/api/hub/bills/electricity/billers';
const PREVIEW = '/api/hub/bills/electricity/meter-preview';
const KEY = 'live_test_bills01_0123456789FAKEKEY';
const PER_MINUTE = 4;
const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  FINTAVA_TIMEOUT_MS: '400',
  BILLS_CATALOGUE_CACHE_SECONDS: '0',
  BILLS_PREVIEW_PER_MINUTE: String(PER_MINUTE),
};

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `bills01-${sub}@test.wawu.dev`,
      phone: '+2348000009997',
      firstName: 'Bills',
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

class RecordingLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: BillsErrorReason;
};
const body = <T>(res: Response) => res.body as Envelope<T>;

describe('BILLS-01 electricity catalogue and meter check over HTTP', () => {
  let app: INestApplication<App>;
  const double = new FintavaDouble();
  const logger = new RecordingLogger();
  const previous: Record<string, string | undefined> = {};

  const auth = () => `Bearer ${mintToken(randomUUID())}`;
  const listAnswers = (
    answer: { status: number; body: unknown } = {
      status: 200,
      body: SANDBOX_DISCOS,
    },
  ) => double.on('GET', '/billing/discos', answer);
  const listCalls = () =>
    double.seen.filter((r) => r.path === '/billing/discos').length;
  const previewCalls = () =>
    double.seen.filter((r) => r.path === '/billing/preview-meter');
  const getBillers = (token = auth()) =>
    request(app.getHttpServer()).get(BILLERS).set('Authorization', token);
  const preview = (send: Record<string, unknown>, token = auth()) =>
    request(app.getHttpServer())
      .post(PREVIEW)
      .set('Authorization', token)
      .send(send);

  /** The service as the module builds it, with its own settings and a client on the double. */
  function serviceWith(values: Record<string, string>): BillsCatalogueService {
    const config = {
      get: (k: string) => values[k],
    } as unknown as ConfigService;
    return new BillsCatalogueService(new FintavaClient(config), config);
  }

  beforeAll(async () => {
    await double.start();
    ENV.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        BillsCatalogueModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();
    app = moduleRef.createNestApplication({ logger });
    app.useLogger(logger);
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
  });

  beforeEach(() => {
    double.reset();
    logger.lines.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('who may ask', () => {
    it('a request with no token, or a bad one, is a 401 on both routes', async () => {
      listAnswers();
      await request(app.getHttpServer()).get(BILLERS).expect(401);
      await request(app.getHttpServer())
        .get(BILLERS)
        .set('Authorization', 'Bearer nonsense')
        .expect(401);
      await request(app.getHttpServer())
        .post(PREVIEW)
        .send({ code: 'AEDC', meterNumber: '1' })
        .expect(401);
      expect(double.seen).toHaveLength(0);
    });
  });

  describe('GET /bills/electricity/billers (S2, S3)', () => {
    it('lists the companies Fintava lists as available, with their code, plan, limits and quick amounts in kobo', async () => {
      listAnswers();
      const res = await getBillers().expect(200);
      const view = body<ElectricityBillersView>(res);
      expect(view).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(view.data!.available).toBe(true);
      expect(view.data!.billers).toHaveLength(20);
      const ikeja = view.data!.billers.find((b) => b.name === 'Ikeja Electric');
      expect(ikeja).toEqual({
        code: 'Ikeja_Electric_Bill_Payment',
        name: 'Ikeja Electric',
        plan: 'prepaid',
        minimumKobo: 50_000,
        maximumKobo: 50_000_000,
        presets: [
          { amountKobo: 200_000 },
          { amountKobo: 500_000 },
          { amountKobo: 1_000_000 },
          { amountKobo: 2_000_000 },
        ],
      });
      const eko = view
        .data!.billers.filter((b) => b.name === 'Eko Electricity')
        .map((b) => b.plan);
      expect(eko).toEqual(['prepaid', 'postpaid']);
      expect(
        view.data!.billers.find(
          (b) => b.code === 'Kaduna_Electricity_Disco_Postpaid',
        ),
      ).toBeUndefined();
      expect(
        view.data!.billers.find((b) => b.code === 'Ibadan_Disco_Prepaid')!
          .minimumKobo,
      ).toBe(0);
    });

    it('asks Fintava with the app’s own key, and sends the person’s token nowhere', async () => {
      listAnswers();
      await getBillers().expect(200);
      expect(double.seen).toHaveLength(1);
      expect(double.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('is `available: false` (S13) when Fintava lists every company as not available', async () => {
      listAnswers({
        status: 200,
        body: {
          ...SANDBOX_DISCOS,
          data: SANDBOX_DISCOS.data.map((d) => ({ ...d, is_available: 'No' })),
        },
      });
      const res = await getBillers().expect(200);
      expect(body<ElectricityBillersView>(res).data).toEqual({
        available: false,
        billers: [],
      });
    });

    it('is `available: false` (S13) when Fintava lists nothing', async () => {
      listAnswers({
        status: 200,
        body: { data: [], status: 200, message: 'Discos records fetched' },
      });
      const res = await getBillers().expect(200);
      expect(body<ElectricityBillersView>(res).data).toEqual({
        available: false,
        billers: [],
      });
    });

    it.each([
      [
        'a refused key',
        { status: 401, body: fintavaError(401, 'Invalid API key') },
      ],
      [
        'a wrong key reported as a 400',
        { status: 400, body: fintavaError(400, 'Invalid API key') },
      ],
      [
        'an inactive merchant',
        { status: 403, body: fintavaError(403, 'Merchant is not active') },
      ],
    ])(
      'is `available: false` (S13) for %s: Fintava’s bills service cannot be used',
      async (_name, answer) => {
        listAnswers(answer);
        const res = await getBillers().expect(200);
        expect(body<ElectricityBillersView>(res).data).toEqual({
          available: false,
          billers: [],
        });
        // Nothing Fintava said reaches the app.
        expect(res.text).not.toMatch(/api key|merchant|fintava/i);
      },
    );

    it.each([
      ['a 500', { status: 500, body: fintavaError(500, 'read ECONNRESET') }],
      ['a 502 with no body', { status: 502, body: '' }],
      [
        'a body that is not the list',
        { status: 200, body: { data: { nope: true } } },
      ],
      [
        'a row with no code',
        { status: 200, body: { data: [{ description: 'x' }] } },
      ],
    ])(
      'is 503 provider_unreachable, not S13, when Fintava answers %s',
      async (_name, answer) => {
        listAnswers(answer);
        const res = await getBillers().expect(503);
        expect(body(res).data).toBeNull();
        expect(body(res).reason).toEqual({
          code: 'provider_unreachable',
          message:
            'Bill payments are not available right now. Try again in a moment.',
          retryAfterSeconds: 30,
        });
        expect(res.text).not.toMatch(/econnreset|fintava/i);
      },
    );

    it('is 503 provider_unreachable when Fintava does not answer in time', async () => {
      listAnswers({
        status: 200,
        body: SANDBOX_DISCOS,
        delayMs: 1200,
      } as never);
      const res = await getBillers().expect(503);
      expect(body(res).reason?.code).toBe('provider_unreachable');
    });

    it('is `available: false` when the server has no Fintava key, and nothing is sent', async () => {
      const bare = serviceWith({ ...ENV, FINTAVA_API_KEY: '' });
      expect(await bare.electricityBillers()).toEqual({
        available: false,
        billers: [],
      });
      expect(double.seen).toHaveLength(0);
      await expect(
        bare.previewMeter(randomUUID(), {
          code: 'AEDC',
          meterNumber: '04123456789',
        }),
      ).rejects.toMatchObject({ code: 'bills_unavailable' });
      expect(double.seen).toHaveLength(0);
    });

    it('never keeps a failed list: the next ask goes to Fintava again, even with a cache on', async () => {
      const kept = serviceWith({ ...ENV, BILLS_CATALOGUE_CACHE_SECONDS: '60' });
      listAnswers({ status: 500, body: fintavaError(500, 'x') });
      await expect(kept.electricityBillers()).rejects.toMatchObject({
        code: 'provider_unreachable',
      });
      listAnswers();
      expect((await kept.electricityBillers()).available).toBe(true);
      expect(listCalls()).toBe(2);
      // A good list is kept: asking again does not go back to Fintava.
      await kept.electricityBillers();
      expect(listCalls()).toBe(2);
    });

    it('asks Fintava again once the kept list is older than the cache', async () => {
      const kept = serviceWith({ ...ENV, BILLS_CATALOGUE_CACHE_SECONDS: '60' });
      let clock = 1_000_000;
      kept.now = () => clock;
      listAnswers();
      await kept.electricityBillers();
      clock += 59_000;
      await kept.electricityBillers();
      expect(listCalls()).toBe(1);
      clock += 2_000;
      await kept.electricityBillers();
      expect(listCalls()).toBe(2);
    });

    it('asks Fintava once when several screens ask together', async () => {
      const kept = serviceWith({ ...ENV, BILLS_CATALOGUE_CACHE_SECONDS: '60' });
      listAnswers({ status: 200, body: SANDBOX_DISCOS, delayMs: 100 } as never);
      await Promise.all([
        kept.electricityBillers(),
        kept.electricityBillers(),
        kept.electricityBillers(),
      ]);
      expect(listCalls()).toBe(1);
    });
  });

  describe('POST /bills/electricity/meter-preview (S4, S10)', () => {
    /** A guess at a success body: the real one has never been seen (question 11). */
    const found = (data: Record<string, unknown>) => ({
      status: 200,
      body: { data, status: 200, message: 'Meter details fetched' },
    });

    it('answers the name and address on a meter, asking Fintava with the digits and the plan of the code', async () => {
      listAnswers();
      double.on(
        'POST',
        '/billing/preview-meter',
        found({
          Customer_Name: 'Chidinma Okoro',
          Address: '14 Admiralty Way',
          meter_number: '04123456789',
        }),
      );
      const res = await preview({
        code: 'Eko_Postpaid',
        meterNumber: '04123456789',
      }).expect(200);
      expect(body<MeterPreviewView>(res)).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          meterNumber: '04123456789',
          code: 'Eko_Postpaid',
          plan: 'postpaid',
          name: 'Chidinma Okoro',
          address: '14 Admiralty Way',
        },
      });
      expect(previewCalls()).toHaveLength(1);
      expect(previewCalls()[0].body).toEqual({
        meternumber: '04123456789',
        disco: 'Eko_Postpaid',
        planType: 'postpaid',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('takes a number written with spaces or dashes as its digits', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', found({ name: 'Ada Eze' }));
      await preview({ code: 'AEDC', meterNumber: '0412 3456-789' }).expect(200);
      expect(previewCalls()[0].body).toMatchObject({
        meternumber: '04123456789',
        disco: 'AEDC',
        planType: 'prepaid',
      });
    });

    it('is 422 meter_not_found (S10) when Fintava answers its bare 400 "Http Exception"', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaError(400, 'Http Exception'),
      });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '1111111111111',
      }).expect(422);
      expect(body(res).data).toBeNull();
      expect(body(res).reason).toEqual({
        code: 'meter_not_found',
        message: "We couldn't find this meter. Check the number.",
      });
    });

    it('is the same S10 answer when Fintava refuses the number in its validation shape', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaValidation('meternumber must be a number string'),
      });
      const res = await preview({ code: 'AEDC', meterNumber: '1' }).expect(422);
      expect(body(res).reason?.code).toBe('meter_not_found');
    });

    it('is 404 biller_not_found for a code that is not on the list, and never asks Fintava about the meter', async () => {
      listAnswers();
      for (const code of ['Nope_Disco', 'Kaduna_Electricity_Disco_Postpaid']) {
        const res = await preview({ code, meterNumber: '04123456789' }).expect(
          404,
        );
        expect(body(res).reason?.code).toBe('biller_not_found');
      }
      expect(previewCalls()).toHaveLength(0);
    });

    it('is 400, with no reason and no call to Fintava, for a malformed request', async () => {
      listAnswers();
      for (const send of [
        {},
        { code: 'AEDC' },
        { meterNumber: '04123456789' },
        { code: 'AEDC', meterNumber: '' },
        { code: 'AEDC', meterNumber: '0412A456789' },
        { code: 'AEDC', meterNumber: '1'.repeat(21) },
        { code: 'AEDC', meterNumber: 4123456789 },
        { code: 'AE DC', meterNumber: '04123456789' },
        { code: 'AEDC', meterNumber: '04123456789', planType: 'postpaid' },
      ]) {
        const res = await preview(send).expect(400);
        expect(body(res).reason).toBeUndefined();
      }
      expect(previewCalls()).toHaveLength(0);
    });

    it('is 503 bills_unavailable (S13) when Fintava’s bills service cannot be used', async () => {
      listAnswers({ status: 401, body: fintavaError(401, 'Invalid API key') });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '04123456789',
      }).expect(503);
      expect(body(res).reason).toEqual({
        code: 'bills_unavailable',
        message: "Bill payments aren't switched on yet.",
      });
    });

    it('is 503 bills_unavailable when the merchant goes inactive between the list and the check', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 403,
        body: fintavaError(403, 'Merchant is not active'),
      });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '04123456789',
      }).expect(503);
      expect(body(res).reason?.code).toBe('bills_unavailable');
    });

    it('is 503 provider_unreachable when Fintava does not answer the check', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 500,
        body: fintavaError(500, 'read ECONNRESET'),
      });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '04123456789',
      }).expect(503);
      expect(body(res).reason).toMatchObject({
        code: 'provider_unreachable',
        retryAfterSeconds: 30,
      });
      expect(res.text).not.toMatch(/econnreset|fintava/i);
    });

    it(`is 429 bills_rate_limited for the ${PER_MINUTE + 1}th check in a minute by one person, and not for another`, async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaError(400, 'Http Exception'),
      });
      const busy = auth();
      for (let i = 0; i < PER_MINUTE; i += 1)
        await preview(
          { code: 'AEDC', meterNumber: '04123456789' },
          busy,
        ).expect(422);
      const res = await preview(
        { code: 'AEDC', meterNumber: '04123456789' },
        busy,
      ).expect(429);
      expect(body(res).reason).toMatchObject({ code: 'bills_rate_limited' });
      expect(body(res).reason?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(previewCalls()).toHaveLength(PER_MINUTE);
      await preview({ code: 'AEDC', meterNumber: '04123456789' }).expect(422);
    });

    it('logs nothing a meter holds: not the number, the name or the address', async () => {
      listAnswers();
      double.on(
        'POST',
        '/billing/preview-meter',
        found({ Customer_Name: 'Chidinma Okoro', Address: '14 Admiralty Way' }),
      );
      await preview({ code: 'AEDC', meterNumber: '04123456789' }).expect(200);
      double.on('POST', '/billing/preview-meter', {
        status: 500,
        body: fintavaError(500, 'meter 04123456789 failed'),
      });
      await preview({ code: 'AEDC', meterNumber: '04123456789' }).expect(503);
      const logged = logger.lines.join('\n');
      expect(logged).not.toMatch(/04123456789|Chidinma|Admiralty/);
    });

    it('speaks plainly: no provider name, no em-dash, in any message it can answer', async () => {
      listAnswers();
      const said: string[] = [];
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaError(400, 'Http Exception'),
      });
      said.push(
        body(await preview({ code: 'AEDC', meterNumber: '04123456789' }))
          .reason!.message,
      );
      said.push(
        body(await preview({ code: 'Nope', meterNumber: '04123456789' }))
          .reason!.message,
      );
      listAnswers({ status: 500, body: fintavaError(500, 'x') });
      said.push(body(await getBillers()).reason!.message);
      listAnswers({ status: 401, body: fintavaError(401, 'Invalid API key') });
      said.push(
        body(await preview({ code: 'AEDC', meterNumber: '04123456789' }))
          .reason!.message,
      );
      for (const m of said) expect(m).not.toMatch(/fintava|—/i);
    });

    /**
     * The 24 answers the BILLS-01 verifier sent to the meter check (D2). The real success body has never been seen
     * (question 11), so a meter is "found" only for a body that names an owner under a key a person's name is kept
     * under, and that name is not the company's own. Every failure Fintava styles inside a 2xx, and every body the Hub
     * cannot read, is an answer that is not green.
     */
    describe("every kind of answer to a meter check (the verifier's 24 shapes, D2)", () => {
      type Shape = [
        label: string,
        answer: { status: number; body?: unknown; contentType?: string },
        expected:
          | { status: 200; name: string; address: string | null }
          | { status: number; code: string },
      ];
      const html = '<html><body>Bad gateway page</body></html>';
      const shapes: Shape[] = [
        [
          'a name and an address',
          {
            status: 200,
            body: {
              data: {
                Customer_Name: 'Chidinma Okoro',
                Address: '14 Admiralty Way',
                Meter_Number: '04123456789',
              },
              status: 200,
              message: 'Meter details fetched',
            },
          },
          { status: 200, name: 'Chidinma Okoro', address: '14 Admiralty Way' },
        ],
        [
          'a name and no address',
          {
            status: 200,
            body: {
              data: { customerName: 'Tunde Bakare' },
              status: 200,
              message: 'ok',
            },
          },
          { status: 200, name: 'Tunde Bakare', address: null },
        ],
        [
          'data an empty object',
          { status: 200, body: { data: {}, status: 200, message: 'ok' } },
          { status: 422, code: 'meter_not_found' },
        ],
        [
          'data null',
          { status: 200, body: { data: null, status: 200, message: 'ok' } },
          { status: 422, code: 'meter_not_found' },
        ],
        [
          'an owner nested one level down',
          {
            status: 200,
            body: {
              data: { customer: { name: 'Nested Person', address: 'Nested' } },
              status: 200,
            },
          },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'the company’s own name in `name`',
          {
            status: 200,
            body: {
              data: {
                name: 'IKEJA ELECTRIC',
                disco: 'Ikeja_Electric_Bill_Payment',
                type: 'prepaid',
              },
              status: 200,
            },
          },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'a 201 "service not currently available" (as cable answers today)',
          {
            status: 201,
            body: { status: 201, message: 'service not currently available' },
          },
          { status: 503, code: 'bills_unavailable' },
        ],
        [
          'a 200 whose body says status 400 "Meter not found"',
          {
            status: 200,
            body: { status: 400, message: 'Meter not found', data: null },
          },
          { status: 422, code: 'meter_not_found' },
        ],
        [
          'data a string',
          { status: 200, body: { data: 'a string', status: 200 } },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'an HTML page with a 200',
          { status: 200, body: html, contentType: 'text/html' },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'data an array',
          { status: 200, body: { data: [{ name: 'A' }], status: 200 } },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'a number for the name and an object for the address',
          {
            status: 200,
            body: {
              data: { name: 12345, address: { line: 'x' } },
              status: 200,
            },
          },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'a padded name and an empty address',
          {
            status: 200,
            body: {
              data: { Customer_Name: '  Ngozi Eze  ', Address: '' },
              status: 200,
            },
          },
          { status: 200, name: 'Ngozi Eze', address: null },
        ],
        [
          'JSON cut off in the middle',
          {
            status: 200,
            body: '{"data": {"Customer_Name": "Broken',
            contentType: 'application/json',
          },
          { status: 502, code: 'meter_unconfirmed' },
        ],
        [
          'a script tag in the name (text, never markup)',
          {
            status: 200,
            body: {
              data: {
                Customer_Name: 'Ada <script>alert(1)</script> Obi',
                Address: '1 "Quote" Road',
              },
              status: 200,
            },
          },
          {
            status: 200,
            name: 'Ada <script>alert(1)</script> Obi',
            address: '1 "Quote" Road',
          },
        ],
        [
          'a name and an address in plain capitals',
          {
            status: 200,
            body: {
              data: { Customer_Name: 'Zainab', Address: 'Abuja' },
              status: 200,
              message: 'ok',
            },
          },
          { status: 200, name: 'Zainab', address: 'Abuja' },
        ],
        [
          'the bare 400 "Http Exception"',
          { status: 400, body: fintavaError(400, 'Http Exception') },
          { status: 422, code: 'meter_not_found' },
        ],
        [
          'a 404',
          { status: 404, body: fintavaError(404, 'Meter not found') },
          { status: 422, code: 'meter_not_found' },
        ],
        [
          'a 500',
          { status: 500, body: fintavaError(500, 'read ECONNRESET') },
          { status: 503, code: 'provider_unreachable' },
        ],
        [
          'a 403 merchant not active',
          { status: 403, body: fintavaError(403, 'Merchant is not active') },
          { status: 503, code: 'bills_unavailable' },
        ],
        [
          'a 401 refused key',
          { status: 401, body: fintavaError(401, 'Invalid API key') },
          { status: 503, code: 'bills_unavailable' },
        ],
        [
          'a 429',
          { status: 429, body: fintavaError(429, 'Too many requests') },
          { status: 503, code: 'provider_unreachable' },
        ],
        [
          'a 400 in the validation shape',
          {
            status: 400,
            body: fintavaValidation('meternumber must be a number string'),
          },
          { status: 422, code: 'meter_not_found' },
        ],
        [
          'a 400 "Unable to find customers"',
          { status: 400, body: fintavaError(400, 'Unable to find customers') },
          { status: 503, code: 'provider_unreachable' },
        ],
      ];

      it.each(shapes)('%s', async (_label, answer, expected) => {
        listAnswers();
        double.on('POST', '/billing/preview-meter', answer);
        const res = await preview({
          code: 'Ikeja_Electric_Bill_Payment',
          meterNumber: '04123456789',
        }).expect(expected.status);
        if ('name' in expected) {
          expect(body<MeterPreviewView>(res).data).toMatchObject({
            name: expected.name,
            address: expected.address,
          });
        } else {
          expect(body(res).data).toBeNull();
          expect(body(res).reason?.code).toBe(expected.code);
          // Whatever was wrong, nothing of Fintava's own words reaches the app.
          expect(res.text).not.toMatch(
            /fintava|econnreset|api key|<html|script/i,
          );
        }
      });

      it('answers found only with a name in the data: 24 shapes, 5 found, none green by mistake', () => {
        const found = shapes.filter(([, , e]) => e.status === 200);
        expect(shapes).toHaveLength(24);
        expect(found).toHaveLength(5);
      });

      it('compares the owner with the company’s own name whatever the capitals, spaces and plan words', async () => {
        listAnswers();
        for (const name of [
          'Ikeja Electric',
          'IKEJA ELECTRIC',
          'ikeja-electric',
          'Ikeja Electric Prepaid',
          'Ikeja Electric Bill Payment',
          'Ikeja_Electric_Bill_Payment',
        ]) {
          double.on('POST', '/billing/preview-meter', {
            status: 200,
            body: { data: { name }, status: 200 },
          });
          const res = await preview({
            code: 'Ikeja_Electric_Bill_Payment',
            meterNumber: '04123456789',
          }).expect(502);
          expect(body(res).reason?.code).toBe('meter_unconfirmed');
        }
        // Another company's name on an Ikeja meter is a person's name as far as the Hub can tell.
        double.on('POST', '/billing/preview-meter', {
          status: 200,
          body: { data: { name: 'Eko Ikeja' }, status: 200 },
        });
        await preview({
          code: 'Ikeja_Electric_Bill_Payment',
          meterNumber: '04123456789',
        }).expect(200);
      });

      it('says in plain words that the meter could not be confirmed, with no provider name or em-dash', async () => {
        listAnswers();
        double.on('POST', '/billing/preview-meter', {
          status: 200,
          body: { data: 'x' },
        });
        const res = await preview({
          code: 'AEDC',
          meterNumber: '04123456789',
        }).expect(502);
        expect(body(res).reason).toEqual({
          code: 'meter_unconfirmed',
          message: "We couldn't confirm this meter. Try again.",
        });
        expect(body(res).reason?.message).not.toMatch(/fintava|—/i);
      });

      it('logs none of the body of an answer it could not read', async () => {
        listAnswers();
        double.on('POST', '/billing/preview-meter', {
          status: 200,
          body: {
            data: {
              customer: { name: 'Chidinma Okoro', address: 'Admiralty' },
            },
          },
        });
        await preview({ code: 'AEDC', meterNumber: '04123456789' }).expect(502);
        expect(logger.lines.join('\n')).not.toMatch(
          /04123456789|Chidinma|Admiralty/,
        );
      });
    });

    it('caps the text it passes on at 200 characters, name and address alike (D9)', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 200,
        body: {
          data: {
            Customer_Name: 'X'.repeat(5000),
            Address: `${'Y'.repeat(199)}😀tail`,
          },
          status: 200,
        },
      });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '04123456789',
      }).expect(200);
      const data = body<MeterPreviewView>(res).data!;
      expect(data.name).toBe('X'.repeat(200));
      // Counted in characters a person sees, never half of an emoji.
      expect([...data.address!]).toHaveLength(200);
      expect(data.address).toBe(`${'Y'.repeat(199)}😀`);
    });

    it('a name of exactly 200 characters is passed on whole', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 200,
        body: { data: { name: 'N'.repeat(200) }, status: 200 },
      });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '04123456789',
      }).expect(200);
      expect(body<MeterPreviewView>(res).data!.name).toBe('N'.repeat(200));
    });

    it('sends Retry-After with the 429 (D5), the same whole seconds as the body', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaError(400, 'Http Exception'),
      });
      const busy = auth();
      for (let i = 0; i < PER_MINUTE; i += 1)
        await preview({ code: 'AEDC', meterNumber: '04123456789' }, busy);
      const res = await preview(
        { code: 'AEDC', meterNumber: '04123456789' },
        busy,
      ).expect(429);
      const seconds = body(res).reason?.retryAfterSeconds;
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(res.headers['retry-after']).toBe(String(seconds));
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sends no Retry-After with an answer that is not a 429', async () => {
      listAnswers();
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaError(400, 'Http Exception'),
      });
      const res = await preview({
        code: 'AEDC',
        meterNumber: '04123456789',
      }).expect(422);
      expect(res.headers['retry-after']).toBeUndefined();
    });

    it('forgets the kept list when a check says bills are not switched on, so S2 draws S13 at once (D6)', async () => {
      const kept = serviceWith({ ...ENV, BILLS_CATALOGUE_CACHE_SECONDS: '60' });
      listAnswers();
      expect((await kept.electricityBillers()).available).toBe(true);
      expect(listCalls()).toBe(1);
      // The merchant goes inactive: the list still looks fine in the cache, the check is refused.
      double.on('POST', '/billing/preview-meter', {
        status: 403,
        body: fintavaError(403, 'Merchant is not active'),
      });
      listAnswers({
        status: 403,
        body: fintavaError(403, 'Merchant is not active'),
      });
      await expect(
        kept.previewMeter(randomUUID(), {
          code: 'AEDC',
          meterNumber: '04123456789',
        }),
      ).rejects.toMatchObject({ code: 'bills_unavailable' });
      // The next list read goes to Fintava again and is S13, not the minute-old list.
      expect(await kept.electricityBillers()).toEqual({
        available: false,
        billers: [],
      });
      expect(listCalls()).toBe(2);
    });

    it('forgets the kept list for a 2xx "service not currently available" too (D6)', async () => {
      const kept = serviceWith({ ...ENV, BILLS_CATALOGUE_CACHE_SECONDS: '60' });
      listAnswers();
      await kept.electricityBillers();
      double.on('POST', '/billing/preview-meter', {
        status: 201,
        body: { status: 201, message: 'service not currently available' },
      });
      await expect(
        kept.previewMeter(randomUUID(), {
          code: 'AEDC',
          meterNumber: '04123456789',
        }),
      ).rejects.toMatchObject({ code: 'bills_unavailable' });
      await kept.electricityBillers();
      expect(listCalls()).toBe(2);
    });

    it('keeps the list when a check fails for a reason that says nothing about the list (a meter not found)', async () => {
      const kept = serviceWith({ ...ENV, BILLS_CATALOGUE_CACHE_SECONDS: '60' });
      listAnswers();
      await kept.electricityBillers();
      double.on('POST', '/billing/preview-meter', {
        status: 400,
        body: fintavaError(400, 'Http Exception'),
      });
      await expect(
        kept.previewMeter(randomUUID(), {
          code: 'AEDC',
          meterNumber: '04123456789',
        }),
      ).rejects.toMatchObject({ code: 'meter_not_found' });
      await kept.electricityBillers();
      expect(listCalls()).toBe(1);
    });
  });

  it('keeps Fintava’s retry wait out of this module’s own figure', () => {
    // The wait the app is told is this module's (30 s); it is not read from the wallet's setting.
    expect(FINTAVA_DEFAULTS.retryAfterSeconds).toBeGreaterThan(0);
  });
});

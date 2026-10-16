import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../event.module';

/**
 * EVENTS-04: the rules GET /events/options hands the app's host wizard are the
 * rules POST /events enforces (E15's "You keep 85% of every ticket. Set price
 * to ₦0 for a free event." and every bound the wizard checks before sending).
 *
 * Each boundary is sent at the limit and one past it, so a limit changed on
 * one side only fails here.
 *
 * (The list below is EVENTS-02's, kept so this header reads the same.)
 *
 *  - a host sends the event and its ticket types in ONE request, and both go
 *    to review together (the task's capability check);
 *  - a ₦0 ticket is the free tier without the host naming one (R-8);
 *  - the hybrid format and the Conference and Concert kinds are accepted and
 *    filterable;
 *  - `location`, which no wizard step asks for, can be left out;
 *  - GET /events/options maps every label to the value to send
 *    ("Business & Finance" is `business`).
 *
 * Every event here is named with the `EV02 ` prefix and swept by that prefix,
 * so the seeded accounts this borrows keep every other suite's rows. Their
 * tick columns are snapshotted and written back (README § Test hygiene).
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
const UNVERIFIED_SUB = '00000000-0000-4000-8000-000000000002';
const SUBS = [HOST_SUB, UNVERIFIED_SUB];

const PREFIX = 'EV04 ';
const FUTURE = '2027-05-09T13:00:00.000Z';
const FUTURE_END = '2027-05-09T16:00:00.000Z';

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** The success and error envelopes, as far as this suite reads them. */
interface Envelope<T> {
  data: T;
  message?: unknown;
  reason?: { code: string };
}
interface EventWire {
  id: string;
  status: string;
  format: string;
  type: string;
  location: string;
  address: string | null;
  ticketed: boolean;
  priceFromNaira: number | null;
}
function bodyOf<T = EventWire>(res: request.Response): Envelope<T> {
  return res.body as Envelope<T>;
}
function dataOf<T = EventWire>(res: request.Response): T {
  return bodyOf<T>(res).data;
}

/** What E13 to E15 collect, and nothing they do not: no `location`. */
function wizardBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `${PREFIX}Pricing your work without guessing`,
    description: 'Three hours on the numbers behind a price.',
    hostOrg: 'Adeyemi & Co',
    format: 'in_person',
    type: 'workshop',
    startsAt: FUTURE,
    endsAt: FUTURE_END,
    address: 'Water Corporation Road, Victoria Island',
    category: 'business',
    ticketTypes: [
      { name: 'Regular', priceNaira: 5000, quantity: 100 },
      { name: 'VIP', priceNaira: 12000, quantity: 20 },
    ],
    ...overrides,
  };
}

interface Rules {
  hostSharePercent: number;
  minPriceNaira: number;
  maxPriceNaira: number;
  minQuantity: number;
  maxQuantity: number;
  nameMinLength: number;
  nameMaxLength: number;
  maxTypes: number;
}
interface Fields {
  nameMax: number;
  descriptionMax: number;
  hostOrgMax: number;
  addressMax: number;
}

describe('Host wizard rules (EVENTS-04)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let rules: Rules;
  let fields: Fields;

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let snapshot: Record<string, Date | null> | null = null;

  async function sweep(): Promise<void> {
    await prisma.event.deleteMany({
      where: { hostWawuId: { in: SUBS }, name: { startsWith: PREFIX } },
    });
  }
  async function count(): Promise<number> {
    return prisma.event.count({
      where: { hostWawuId: { in: SUBS }, name: { startsWith: PREFIX } },
    });
  }
  const post = (body: Record<string, unknown>) =>
    http().post('/api/hub/events').set(auth(hostToken)).send(body);

  beforeAll(async () => {
    hostToken = await loginToWawuId(HOST_EMAIL);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        EventModule,
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

    snapshot = await prisma.userProfile.findUnique({
      where: { wawuUserId: HOST_SUB },
      select: {
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
        professionalVerifiedAt: true,
        professionalVerifiedUntil: true,
      },
    });
    await prisma.userProfile.update({
      where: { wawuUserId: HOST_SUB },
      data: {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await sweep();

    const res = await http()
      .get('/api/hub/events/options')
      .set(auth(hostToken))
      .expect(200);
    ({ tickets: rules, fields } = dataOf<{ tickets: Rules; fields: Fields }>(
      res,
    ));
  });

  afterEach(async () => {
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    if (snapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: snapshot,
      });
    }
    await app.close();
  });

  it('serves the host share from the commission (85, R-5) and the free price (0, R-8)', () => {
    expect(rules).toEqual({
      hostSharePercent: 85,
      minPriceNaira: 0,
      maxPriceNaira: 10_000_000,
      minQuantity: 1,
      maxQuantity: 1_000_000,
      nameMinLength: 2,
      nameMaxLength: 60,
      maxTypes: 20,
    });
    expect(fields).toEqual({
      nameMax: 160,
      descriptionMax: 5000,
      hostOrgMax: 160,
      addressMax: 300,
    });
  });

  it('a ticket at the lowest price is the free tier', async () => {
    const res = await post(
      wizardBody({
        name: `${PREFIX}Free`,
        ticketTypes: [
          { name: 'Entry', priceNaira: rules.minPriceNaira, quantity: 1 },
        ],
      }),
    ).expect(201);
    expect(dataOf(res).priceFromNaira).toBe(0);
    const [row] = await prisma.event.findMany({
      where: { hostWawuId: HOST_SUB, name: `${PREFIX}Free` },
      include: { ticketTypes: true },
    });
    expect(row.ticketTypes[0].tier).toBe('free');
  });

  it.each([
    ['price at the top', { priceNaira: 'max' }, 201],
    ['price one past the top', { priceNaira: 'max+1' }, 400],
    ['price one below the lowest', { priceNaira: 'min-1' }, 400],
    ['quantity at the top', { quantity: 'qmax' }, 201],
    ['quantity one past the top', { quantity: 'qmax+1' }, 400],
    ['quantity at the lowest', { quantity: 'qmin' }, 201],
    ['quantity one below the lowest', { quantity: 'qmin-1' }, 400],
    ['name at the shortest', { name: 'nmin' }, 201],
    ['name one short', { name: 'nmin-1' }, 400],
    ['name at the longest', { name: 'nmax' }, 201],
    ['name one past the longest', { name: 'nmax+1' }, 400],
  ] as const)('%s', async (label, change, status) => {
    const value = (k: string): unknown =>
      ({
        max: rules.maxPriceNaira,
        'max+1': rules.maxPriceNaira + 1,
        'min-1': rules.minPriceNaira - 1,
        qmax: rules.maxQuantity,
        'qmax+1': rules.maxQuantity + 1,
        qmin: rules.minQuantity,
        'qmin-1': rules.minQuantity - 1,
        nmin: 'V'.repeat(rules.nameMinLength),
        'nmin-1': 'V'.repeat(rules.nameMinLength - 1),
        nmax: 'V'.repeat(rules.nameMaxLength),
        'nmax+1': 'V'.repeat(rules.nameMaxLength + 1),
      })[k];
    const ticket: Record<string, unknown> = {
      name: 'Regular',
      priceNaira: 5000,
      quantity: 10,
    };
    for (const [k, v] of Object.entries(change)) ticket[k] = value(v);
    const before = await count();
    await post(
      wizardBody({ name: `${PREFIX}${label}`, ticketTypes: [ticket] }),
    ).expect(status);
    expect(await count()).toBe(before + (status === 201 ? 1 : 0));
  });

  it('takes as many ticket types as maxTypes, and refuses one more', async () => {
    const types = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `Type ${i + 1}`,
        priceNaira: 1000 + i,
        quantity: 5,
      }));
    await post(
      wizardBody({ name: `${PREFIX}Max`, ticketTypes: types(rules.maxTypes) }),
    ).expect(201);
    await post(
      wizardBody({
        name: `${PREFIX}Max plus one`,
        ticketTypes: types(rules.maxTypes + 1),
      }),
    ).expect(400);
    expect(await count()).toBe(1);
  });

  it.each([
    ['name', 'nameMax'],
    ['description', 'descriptionMax'],
    ['hostOrg', 'hostOrgMax'],
    ['address', 'addressMax'],
  ] as const)(
    '%s takes its longest length and refuses one more',
    async (field, limit) => {
      const fill = (n: number) =>
        field === 'name'
          ? `${PREFIX}${'n'.repeat(n - PREFIX.length)}`
          : 'x'.repeat(n);
      await post(wizardBody({ [field]: fill(fields[limit]) })).expect(201);
      await post(wizardBody({ [field]: fill(fields[limit] + 1) })).expect(400);
      expect(await count()).toBe(1);
    },
  );
});

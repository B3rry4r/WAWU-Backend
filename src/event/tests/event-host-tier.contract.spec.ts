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
import { EventTicketingModule } from '../../event-ticketing/event-ticketing.module';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';

/**
 * EVENTS-12 (R-43, R-40): hosting an event needs an active tier.
 *
 * The gate on POST /events, PATCH /events/:id and PUT /events/:id/tickets
 * reads the person's tier (`GET /me/tier`) where it used to read only the
 * verification tick:
 *
 *  - no tier and no tick: 403 `tier_required`, with the lowest tier on
 *    `GET /plans` in the person's currency ("Needs a tier, from ...");
 *  - a running tier (`active`, or `ending` with days left) and no tick: hosts;
 *  - a tick that has not ended and no tier: hosts, exactly as before;
 *  - a tier that ended and no live tick: refused for a new event, an edit and
 *    a ticket price change, while an event already live stays public and keeps
 *    selling;
 *  - changing ticket prices on an approved event still goes back to review.
 *
 * Fixtures are this suite's own event ids (`ee120...`), swept before and
 * after. The three seeded accounts are borrowed: their tick columns and
 * tier rows are snapshotted and written back (README § Test hygiene). The
 * plan's figures are read from the Hub's own `GET /plans`, never typed here.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Two creator accounts and a buyer (`user`) account. */
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
const OTHER_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER_SUB = '00000000-0000-4000-8000-000000000002';
const BUYER_EMAIL = 'user@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000001';
const SUBS = [HOST_SUB, OTHER_SUB, BUYER_SUB];

const EV_LIVE = 'ee120000-0000-4000-8000-000000000001';
const EV_FREE = 'ee120000-0000-4000-8000-000000000002';
const EV_OTHER = 'ee120000-0000-4000-8000-000000000003';
const EVENTS = [EV_LIVE, EV_FREE, EV_OTHER];
const NAME_PREFIX = 'EV12 ';

const DAY = 86_400_000;
const FUTURE = new Date('2027-05-06T09:00:00.000Z');
const LIVE_TICK = {
  creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
};
const LAPSED_TICK = {
  creatorVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
  creatorVerifiedUntil: new Date('2025-01-01T00:00:00.000Z'),
};
const NO_TICK = {
  creatorVerifiedAt: null,
  creatorVerifiedUntil: null,
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};

const OLD_TIER = {
  tier: 'regular' as const,
  name: 'Regular',
  priceNaira: 5000,
  quantity: 100,
};
const NEW_TIERS = [
  { tier: 'regular', name: 'Regular', priceNaira: 7500, quantity: 100 },
];
const FREE_TIER = {
  tier: 'free' as const,
  name: 'Free entry',
  priceNaira: 0,
  quantity: 10,
};

async function login(identifier: string): Promise<string> {
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

interface HostReason {
  code: string;
  message: string;
  tierState?: string;
  currency?: string;
  lowestTier?: { id: string; name: string; priceMinor: number } | null;
  steps?: string[];
}
interface ErrorBody {
  statusCode: number;
  message: string;
  data: null;
  reason?: HostReason;
}

describe('Hosting an event needs an active tier (EVENTS-12, R-43)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: PlansConfig;
  let hostToken: string;
  let otherToken: string;
  let buyerToken: string;
  const tickSnapshot = new Map<string, object>();
  const tierSnapshot = new Map<string, Record<string, unknown>>();

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function sweep(): Promise<void> {
    await prisma.event.deleteMany({
      where: {
        OR: [{ id: { in: EVENTS } }, { name: { startsWith: NAME_PREFIX } }],
      },
    });
  }

  async function setTick(sub: string, tick: object): Promise<void> {
    await prisma.userProfile.update({ where: { wawuUserId: sub }, data: tick });
  }

  /** A tier row as the purchase path writes it: index 0 is the cheapest. */
  async function giveTier(
    sub: string,
    endsInDays: number,
    tierIndex = 0,
  ): Promise<void> {
    const t = config.tiers[tierIndex];
    const until = Date.now() + endsInDays * DAY;
    const data = {
      tierId: t.id,
      // The period must run forwards (a check in the table), also for a tier
      // that ended yesterday.
      activeFrom: new Date(until - t.days * DAY),
      activeUntil: new Date(until),
      productsIncluded: t.products,
      extraProducts: 0,
      pointsIncluded: t.bonusPoints,
      voiceIntroIncluded: false,
    };
    await prisma.makerTier.upsert({
      where: { wawuUserId: sub },
      create: { wawuUserId: sub, ...data },
      update: data,
    });
  }

  async function fixture(
    id: string,
    host: string,
    status: 'published' | 'pending',
    tiers: Array<{
      tier: 'regular' | 'free';
      name: string;
      priceNaira: number;
      quantity: number;
    }> = [OLD_TIER],
  ): Promise<void> {
    await prisma.event.create({
      data: {
        id,
        hostWawuId: host,
        name: `${NAME_PREFIX}${status} ${id.slice(-2)}`,
        description: 'A fixture for the EVENTS-12 contract suite.',
        hostOrg: 'EV12 Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: FUTURE,
        status,
        ticketTypes: { create: tiers },
      },
    });
  }

  /** Everything the three routes can write, to prove a refusal wrote none. */
  async function snapshot(id: string) {
    const event = await prisma.event.findUniqueOrThrow({
      where: { id },
      select: { status: true, name: true, updatedAt: true },
    });
    const tiers = await prisma.eventTicketType.findMany({
      where: { eventId: id },
      orderBy: { id: 'asc' },
    });
    return { event, tiers };
  }

  const newEventBody = (name: string) => ({
    name: `${NAME_PREFIX}${name}`,
    description: 'Submitted by the EVENTS-12 contract suite.',
    hostOrg: 'EV12',
    format: 'online',
    type: 'meetup',
    startsAt: FUTURE.toISOString(),
    location: 'Online',
  });
  const post = (token: string, name: string) =>
    http().post('/api/hub/events').set(auth(token)).send(newEventBody(name));
  const patch = (token: string, id: string) =>
    http()
      .patch(`/api/hub/events/${id}`)
      .set(auth(token))
      .send({ description: 'A corrected description.' });
  const put = (token: string, id: string, types: unknown = NEW_TIERS) =>
    http()
      .put(`/api/hub/events/${id}/tickets`)
      .set(auth(token))
      .send({ types });

  /** The cheapest tier on `GET /plans` as this person is shown it. */
  async function plansLowest(token: string) {
    const res = await http().get('/api/hub/plans').set(auth(token)).expect(200);
    const plan = (
      res.body as {
        data: {
          currency: string;
          tiers: Array<{ id: string; name: string; priceMinor: number }>;
        };
      }
    ).data;
    const lowest = [...plan.tiers].sort(
      (a, b) => a.priceMinor - b.priceMinor,
    )[0];
    return {
      currency: plan.currency,
      lowestTier: {
        id: lowest.id,
        name: lowest.name,
        priceMinor: lowest.priceMinor,
      },
    };
  }

  /** The three routes, answered for one person on one event. */
  async function threeRoutes(token: string, eventId: string) {
    return {
      post: await post(token, 'refused'),
      patch: await patch(token, eventId),
      put: await put(token, eventId),
    };
  }

  beforeAll(async () => {
    [hostToken, otherToken, buyerToken] = await Promise.all([
      login(HOST_EMAIL),
      login(OTHER_EMAIL),
      login(BUYER_EMAIL),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        EventModule,
        EventTicketingModule,
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
    config = app.get<PlansConfig>(PLANS_CONFIG);

    for (const sub of SUBS) {
      const row = await prisma.userProfile.findUnique({
        where: { wawuUserId: sub },
        select: {
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      });
      if (row) tickSnapshot.set(sub, row);
      const tier = await prisma.makerTier.findUnique({
        where: { wawuUserId: sub },
      });
      if (tier) tierSnapshot.set(sub, tier);
    }
    // The buyer must be a buyer for the account_type_required cases, and the
    // two creators must be creators.
    const type = async (sub: string) =>
      (
        await prisma.userProfile.findUniqueOrThrow({
          where: { wawuUserId: sub },
        })
      ).accountType;
    expect(await type(BUYER_SUB)).toBe('user');
    expect(await type(HOST_SUB)).toBe('creator');
    expect(await type(OTHER_SUB)).toBe('creator');
    expect(
      await prisma.professionalProfile.count({
        where: {
          wawuUserId: { in: SUBS },
          status: 'approved',
        },
      }),
    ).toBe(0);
  });

  beforeEach(async () => {
    await sweep();
    await prisma.makerTier.deleteMany({ where: { wawuUserId: { in: SUBS } } });
    for (const sub of SUBS) await setTick(sub, NO_TICK);
    await fixture(EV_LIVE, HOST_SUB, 'published');
  });

  afterAll(async () => {
    await sweep();
    await prisma.makerTier.deleteMany({ where: { wawuUserId: { in: SUBS } } });
    for (const [, row] of tierSnapshot)
      await prisma.makerTier.create({
        data: row as Parameters<typeof prisma.makerTier.create>[0]['data'],
      });
    for (const [sub, row] of tickSnapshot) await setTick(sub, row);
    await app.close();
  });

  describe('no tier and no tick', () => {
    it('is refused on all three routes with tier_required and the lowest tier of the plan, and nothing is written', async () => {
      const before = await snapshot(EV_LIVE);
      const want = await plansLowest(hostToken);
      const answers = await threeRoutes(hostToken, EV_LIVE);

      for (const res of Object.values(answers)) {
        expect(res.status).toBe(403);
        const body = res.body as ErrorBody;
        expect(body.statusCode).toBe(403);
        expect(body.data).toBeNull();
        expect(body.reason).toMatchObject({
          code: 'tier_required',
          tierState: 'none',
          ...want,
        });
        expect(body.reason?.message).toBe(body.message);
      }
      // One body, word for word, from the three routes.
      expect(answers.patch.body).toEqual(answers.post.body);
      expect(answers.put.body).toEqual(answers.post.body);

      expect(await snapshot(EV_LIVE)).toEqual(before);
      expect(
        await prisma.event.count({
          where: { name: { startsWith: NAME_PREFIX + 'refused' } },
        }),
      ).toBe(0);
    });

    it('names the cheapest tier of the plan, not the dearest, in the person currency', async () => {
      const want = await plansLowest(hostToken);
      const prices = config.tiers.map((t) => t.price.kobo);
      expect(want.currency).toBe('NGN');
      expect(want.lowestTier.priceMinor).toBe(Math.min(...prices));
      expect(want.lowestTier.priceMinor).toBeLessThan(Math.max(...prices));
      const res = await post(hostToken, 'cheapest').expect(403);
      expect((res.body as ErrorBody).reason?.lowestTier).toEqual(
        want.lowestTier,
      );
      expect((res.body as ErrorBody).reason?.currency).toBe('NGN');
    });

    it('words the refusal for a person: "Needs a tier", no figure in the sentence, no em-dash', async () => {
      const res = await post(hostToken, 'words').expect(403);
      const body = res.body as ErrorBody;
      expect(body.message).toMatch(/^Needs a tier\./);
      const readable = `${body.message} ${body.reason?.message}`;
      expect(readable).not.toContain('—');
      expect(readable).not.toMatch(/[0-9]/);
    });

    it('a buyer account with neither is told its account type first, as before', async () => {
      const res = await post(buyerToken, 'buyer').expect(403);
      const body = res.body as ErrorBody;
      expect(body.reason?.code).toBe('account_type_required');
      expect(
        `${body.message} ${(body.reason?.steps ?? []).join(' ')}`,
      ).not.toContain('—');
    });
  });

  describe('an active tier and no tick', () => {
    it('creates an event (it lands pending), edits it, and changes ticket prices', async () => {
      await giveTier(HOST_SUB, 20);

      const created = await post(hostToken, 'created').expect(201);
      const data = (created.body as { data: { id: string; status: string } })
        .data;
      expect(data.status).toBe('pending');

      await patch(hostToken, data.id).expect(200);
      await put(hostToken, EV_LIVE).expect(200);
    });

    it('ticket prices on an approved event still go back to review (R-40)', async () => {
      await giveTier(HOST_SUB, 20);
      await put(hostToken, EV_LIVE).expect(200);

      const row = await prisma.event.findUniqueOrThrow({
        where: { id: EV_LIVE },
      });
      expect(row.status).toBe('pending');
      // A stranger is told nothing until an admin approves it again.
      await http()
        .get(`/api/hub/events/${EV_LIVE}`)
        .set(auth(buyerToken))
        .expect(404);
      await http()
        .get(`/api/hub/events/${EV_LIVE}/tickets`)
        .set(auth(buyerToken))
        .expect(404);
      await http()
        .get(`/api/hub/events/${EV_LIVE}`)
        .set(auth(hostToken))
        .expect(200);
    });

    it('a tier with days left that is about to end still hosts (ending is running)', async () => {
      await giveTier(HOST_SUB, 2);
      const me = await http().get('/api/hub/me/tier').set(auth(hostToken));
      expect((me.body as { data: { state: string } }).data.state).toBe(
        'ending',
      );
      await post(hostToken, 'ending').expect(201);
    });

    it('any tier of the plan is enough, not only the cheapest', async () => {
      await giveTier(HOST_SUB, 20, config.tiers.length - 1);
      await post(hostToken, 'top tier').expect(201);
    });

    it('is the person own tier: a second person with none is still refused', async () => {
      await giveTier(HOST_SUB, 20);
      await post(otherToken, 'someone else').expect(403);
    });

    it('a buyer account that holds a running tier may host: the tier is the gate', async () => {
      await giveTier(BUYER_SUB, 20);
      await post(buyerToken, 'buyer with a tier').expect(201);
    });
  });

  describe('a live verification tick', () => {
    it('keeps hosting with no tier, as before', async () => {
      await setTick(HOST_SUB, LIVE_TICK);
      await post(hostToken, 'tick only').expect(201);
      await put(hostToken, EV_LIVE).expect(200);
    });

    it('keeps hosting after a tier has ended, until the tick ends', async () => {
      await setTick(HOST_SUB, LIVE_TICK);
      await giveTier(HOST_SUB, -1);
      await post(hostToken, 'tick and ended tier').expect(201);
    });

    it('a tick that has ended and no tier is refused, tier_required', async () => {
      await setTick(HOST_SUB, LAPSED_TICK);
      const res = await post(hostToken, 'lapsed tick').expect(403);
      expect((res.body as ErrorBody).reason).toMatchObject({
        code: 'tier_required',
        tierState: 'none',
      });
    });

    it('a tick that has ended with a running tier hosts on the tier', async () => {
      await setTick(HOST_SUB, LAPSED_TICK);
      await giveTier(HOST_SUB, 20);
      await post(hostToken, 'lapsed tick, running tier').expect(201);
    });
  });

  describe('a tier that has ended', () => {
    it('is refused for a new event, an edit and a price change, saying the tier ended', async () => {
      await giveTier(HOST_SUB, -1);
      const before = await snapshot(EV_LIVE);
      const want = await plansLowest(hostToken);
      const answers = await threeRoutes(hostToken, EV_LIVE);

      for (const res of Object.values(answers)) {
        expect(res.status).toBe(403);
        const body = res.body as ErrorBody;
        expect(body.reason).toMatchObject({
          code: 'tier_required',
          tierState: 'ended',
          ...want,
        });
        expect(body.message).toMatch(/^Your tier has ended\./);
        expect(body.message).not.toContain('—');
      }
      expect(answers.patch.body).toEqual(answers.post.body);
      expect(answers.put.body).toEqual(answers.post.body);
      expect(await snapshot(EV_LIVE)).toEqual(before);
    });

    it('is refused when the same tiers are sent again (the gate runs before the no-change answer)', async () => {
      await giveTier(HOST_SUB, -1);
      const before = await snapshot(EV_LIVE);
      const res = await put(hostToken, EV_LIVE, [OLD_TIER]).expect(403);
      expect((res.body as ErrorBody).reason?.code).toBe('tier_required');
      expect(await snapshot(EV_LIVE)).toEqual(before);
    });

    it('leaves a live event public at its price, and it keeps selling', async () => {
      await prisma.event.delete({ where: { id: EV_LIVE } });
      await fixture(EV_FREE, HOST_SUB, 'published', [FREE_TIER]);
      await giveTier(HOST_SUB, -1);

      // The host cannot change it any more ...
      await put(hostToken, EV_FREE).expect(403);

      // ... it is still public, and a ticket can still be bought.
      const pub = await http()
        .get(`/api/hub/events/${EV_FREE}`)
        .set(auth(buyerToken))
        .expect(200);
      expect((pub.body as { data: { status: string } }).data.status).toBe(
        'published',
      );
      const tiers = await http()
        .get(`/api/hub/events/${EV_FREE}/tickets`)
        .set(auth(buyerToken))
        .expect(200);
      const freeTier = (
        tiers.body as { data: Array<{ id: string; remaining: number }> }
      ).data[0];
      expect(freeTier.remaining).toBe(10);

      const bought = await http()
        .post(`/api/hub/events/${EV_FREE}/orders`)
        .set(auth(buyerToken))
        .send({ ticketTypeId: freeTier.id, quantity: 1 });
      expect(bought.status).toBe(201);

      const after = await prisma.eventTicketType.findUniqueOrThrow({
        where: { id: freeTier.id },
      });
      expect(after.sold).toBe(1);
      expect(
        await prisma.eventTicket.count({
          where: { eventId: EV_FREE, status: 'valid' },
        }),
      ).toBe(1);
    });

    it('buying a tier again lets the person host again', async () => {
      await giveTier(HOST_SUB, -1);
      await post(hostToken, 'before renewal').expect(403);
      await giveTier(HOST_SUB, 20);
      await post(hostToken, 'after renewal').expect(201);
    });

    it('one ticket sold: the 409 for sold tickets still answers first, as before', async () => {
      await giveTier(HOST_SUB, -1);
      await prisma.eventTicketType.updateMany({
        where: { eventId: EV_LIVE },
        data: { sold: 1 },
      });
      const res = await put(hostToken, EV_LIVE).expect(409);
      expect((res.body as ErrorBody).message).toContain('already sold');
    });
  });
});

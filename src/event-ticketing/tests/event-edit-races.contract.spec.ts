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
import { EventModule } from '../../event/event.module';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminEventsModule } from '../../admin/events/admin-events.module';
import { EventTicketingModule } from '../event-ticketing.module';

/**
 * EVENTS-11 D1: a host's edit racing an admin's takedown.
 *
 * PUT /events/:id/tickets and PATCH /events/:id both send an event back to
 * review. Each round here sends one of them and POST /admin/events/:id/remove
 * at the same instant, at a published event. Two endings are right:
 *
 *  - the edit commits first: the event is `pending` and the remove, which
 *    only works from `published`, is refused (400);
 *  - the remove commits first: the event is `removed`, and the edit either
 *    answers as it does for a removed event (PATCH 403; PUT 200, tiers
 *    saved, status left `removed`) or does not touch the status.
 *
 * The wrong ending is the one this guards: the remove answered 200 and the
 * event ended `pending`, the takedown undone. Before the fix (6ea8612 for
 * PUT, main and 6ea8612 for PATCH) most rounds ended that way.
 *
 * Fixture ids `ee11ac..`, swept before and after; the host's tick columns
 * are snapshotted and written back.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
const EV = 'ee11ac00-0000-4000-8000-000000000001';
const ADMIN_ID = 'ad11ac00-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'events11-race@admin.test.wawu.dev';
const ADMIN_PASSWORD = 'events-eleven-race-password';
const ROUNDS = 25;

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

describe('A host edit racing an admin takedown (EVENTS-11 D1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let adminToken: string;
  let tickSnapshot: Record<string, Date | null> | null = null;
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function sweep(): Promise<void> {
    await prisma.adminEventReview.deleteMany({ where: { eventId: EV } });
    await prisma.event.deleteMany({ where: { id: EV } });
  }

  /** A fresh published event with one tier. */
  async function published(): Promise<void> {
    await sweep();
    await prisma.event.create({
      data: {
        id: EV,
        hostWawuId: HOST_SUB,
        name: 'EV11 race',
        description: 'A fixture for the EVENTS-11 race suite.',
        hostOrg: 'EV11 Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: new Date('2027-05-06T09:00:00.000Z'),
        status: 'published',
        ticketTypes: {
          create: [
            {
              tier: 'regular',
              name: 'Regular',
              priceNaira: 5000,
              quantity: 100,
            },
          ],
        },
      },
    });
  }

  function remove() {
    return http()
      .post(`/api/hub/admin/events/${EV}/remove`)
      .set(auth(adminToken))
      .send({ reason: 'Taken down by the EVENTS-11 race suite.' });
  }

  /** Races `edit` against a remove ROUNDS times; returns the wrong endings. */
  async function race(
    edit: (round: number) => request.Test,
  ): Promise<string[]> {
    const wrong: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      await published();
      const [editRes, removeRes] = await Promise.all([edit(round), remove()]);
      const row = await prisma.event.findUniqueOrThrow({ where: { id: EV } });
      const ok =
        (removeRes.status === 200 && row.status === 'removed') ||
        (removeRes.status === 400 && row.status === 'pending');
      if (!ok) {
        wrong.push(
          `round ${round}: edit ${editRes.status}, remove ${removeRes.status}, final ${row.status}`,
        );
      }
    }
    return wrong;
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = 'events-eleven-race-access-0123456789abcd';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'events-eleven-race-refresh-0123456789abcd';
    hostToken = await login(HOST_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminEventsModule,
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
    // Listening once, on a fixed port (RACE_SPEC_PORT, default 5354), so the
    // two requests of a race share one server: supertest would otherwise
    // open and close a server per request, and the second can find it shut.
    await app.listen(Number(process.env.RACE_SPEC_PORT ?? 5354));
    prisma = moduleRef.get(PrismaService);

    const argon2 = await import('argon2');
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.adminUser.create({
      data: {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        name: 'EV11 Race',
        role: 'superadmin',
        passwordHash: await argon2.hash(ADMIN_PASSWORD),
      },
    });
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    adminToken = (res.body as { data: { accessToken: string } }).data
      .accessToken;

    tickSnapshot = await prisma.userProfile.findUnique({
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
  }, 60_000);

  afterAll(async () => {
    await sweep();
    if (tickSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: tickSnapshot,
      });
    }
    await prisma.adminUser.deleteMany({ where: { id: ADMIN_ID } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(`PUT /events/:id/tickets racing a remove never undoes the takedown (${ROUNDS} rounds)`, async () => {
    const wrong = await race((round) =>
      http()
        .put(`/api/hub/events/${EV}/tickets`)
        .set(auth(hostToken))
        .send({
          types: [
            {
              tier: 'regular',
              name: 'Regular',
              priceNaira: 6000 + round,
              quantity: 100,
            },
          ],
        }),
    );
    expect(wrong).toEqual([]);
  }, 120_000);

  it(`PATCH /events/:id racing a remove never undoes the takedown (${ROUNDS} rounds)`, async () => {
    const wrong = await race((round) =>
      http()
        .patch(`/api/hub/events/${EV}`)
        .set(auth(hostToken))
        .send({ name: `EV11 race renamed ${round}` }),
    );
    expect(wrong).toEqual([]);
  }, 120_000);

  it('a PUT that lands after the takedown answers as for a removed event and leaves it removed', async () => {
    await published();
    await remove().expect(200);
    await http()
      .put(`/api/hub/events/${EV}/tickets`)
      .set(auth(hostToken))
      .send({
        types: [
          { tier: 'regular', name: 'Regular', priceNaira: 6500, quantity: 100 },
        ],
      })
      .expect(200);
    await http()
      .patch(`/api/hub/events/${EV}`)
      .set(auth(hostToken))
      .send({ name: 'EV11 after takedown' })
      .expect(403);
    const row = await prisma.event.findUniqueOrThrow({ where: { id: EV } });
    expect(row.status).toBe('removed');
  });

  it("parallel PUTs to one event leave exactly one request's tiers (EVENTS-11 O2)", async () => {
    await published();
    const sent = [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008];
    await Promise.all(
      sent.map((price) =>
        http()
          .put(`/api/hub/events/${EV}/tickets`)
          .set(auth(hostToken))
          .send({
            types: [
              {
                tier: 'regular',
                name: 'Regular',
                priceNaira: price,
                quantity: 100,
              },
            ],
          }),
      ),
    );
    const tiers = await prisma.eventTicketType.findMany({
      where: { eventId: EV },
    });
    expect(tiers).toHaveLength(1);
    expect(sent).toContain(tiers[0].priceNaira);
  });
});

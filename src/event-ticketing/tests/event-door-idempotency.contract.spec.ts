import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../../event/event.module';
import { EventTicketingModule } from '../event-ticketing.module';
import {
  DOOR_KEY_MESSAGE,
  DOOR_KEY_REUSED_MESSAGE,
  DOOR_SCAN_KEY_HOURS,
  EventRunningService,
  type DoorCheckInResult,
} from '../event-running.service';

/**
 * EVENTS-09 round 2, D1: a scan asked again after its answer was lost.
 *
 * The verifier's case: the Hub checks a ticket in and the answer never
 * reaches the phone. The phone said "not checked in", and Try again then
 * showed ALREADY USED by the scanner's own door, so a paying holder could be
 * turned away. Now every scan carries one `Idempotency-Key`, made once per
 * scan and sent again unchanged by Try again; the Hub keeps the first answer
 * under (scanner, key) in the same transaction as the check-in, and a repeat
 * is answered with it.
 *
 *  - the case reproduced WITHOUT a key (the old behaviour, still there for a
 *    caller that sends none): the second scan is `already_used`;
 *  - the same case WITH a key: the second scan is `valid` again, with the
 *    holder's name, byte for byte the first answer, header
 *    `Idempotent-Replayed: true`, and the ticket is checked in once;
 *  - twelve scans with one key at the same moment, split over two Hub
 *    processes (two applications on one database): all `valid`, one row;
 *  - the key is the scanner's: another scanner's scan with the same key text
 *    is a different scan;
 *  - a key used for another ticket or another event is refused (409);
 *  - a repeat of a refused scan (not allowed, no such event) is refused again,
 *    never answered from a stored row;
 *  - a malformed key is a 400 and checks nothing in;
 *  - the first answers are purged after `DOOR_SCAN_KEY_HOURS`;
 *  - a ticket of this event that was voided (the event was called off) reads
 *    `cancelled`; another event's ticket and made-up text stay the one answer.
 *
 * Fixtures: events with `e9100000-...` ids, swept in afterAll. Since EVENTS-11
 * (R-40) PUT /events/:id/tickets needs a verified host and sends the event back
 * to review, so the host holds a tick for the suite (its tick columns are
 * snapshotted and written back) and each event is put back to `published`
 * after its tiers are set. Nothing about the door changed.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
const BUYER_EMAIL = 'creator-basic@test.wawu.dev';
const STAFF_EMAIL = 'creator-pro@test.wawu.dev';
const STAFF_SUB = '00000000-0000-4000-8000-000000000003';

const EV = 'e9100000-0000-4000-8000-000000000001';
const EV_OTHER = 'e9100000-0000-4000-8000-000000000002';
const FUTURE = new Date('2027-05-06T09:00:00.000Z');

type Answer = Omit<DoorCheckInResult, 'ticket'> & {
  ticket:
    | (Omit<NonNullable<DoorCheckInResult['ticket']>, 'checkedInAt'> & {
        checkedInAt: string | null;
      })
    | null;
};

function answer(res: { body: unknown }): Answer {
  return (res.body as { data: Answer }).data;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(`mock-wawu-id login ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function boot(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
}> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      EventModule,
      EventTicketingModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
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
  return { app, prisma: moduleRef.get(PrismaService) };
}

describe('The door answers a scan asked again with the same key (EVENTS-09 round 2)', () => {
  let app: INestApplication;
  /** A second Hub process: its own application and database pool. */
  let second: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let staffToken: string;
  let codes: string[] = [];
  let otherCode = '';
  let next = 0;
  let tickSnapshot: Record<string, Date | null> | null = null;

  const http = (a: INestApplication = app) =>
    request(a.getHttpServer() as Parameters<typeof request>[0]);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const freshCode = () => codes[next++];
  const newKey = () => `scan-${randomUUID()}`;
  const scan = (
    code: string,
    key?: string,
    opts: { token?: string; event?: string; via?: INestApplication } = {},
  ) => {
    const req = http(opts.via)
      .post(`/api/hub/events/${opts.event ?? EV}/door/check-in`)
      .set(auth(opts.token ?? hostToken));
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send({ code });
  };

  async function sweep(): Promise<void> {
    await prisma.event.deleteMany({ where: { id: { in: [EV, EV_OTHER] } } });
  }

  async function makeEvent(id: string, name: string): Promise<string[]> {
    await prisma.event.create({
      data: {
        id,
        name,
        hostWawuId: HOST_SUB,
        description: 'A fixture event for the EVENTS-09 round 2 suite.',
        hostOrg: 'Door Fixtures Ltd',
        format: 'in_person',
        type: 'summit',
        location: 'Lagos',
        startsAt: FUTURE,
        status: 'published',
      },
    });
    const tiers = await http()
      .put(`/api/hub/events/${id}/tickets`)
      .set(auth(hostToken))
      .send({
        types: [{ tier: 'free', name: 'Free', priceNaira: 0, quantity: 200 }],
      })
      .expect(200);
    const tierId = (tiers.body as { data: Array<{ id: string }> }).data[0].id;
    // EVENTS-11 (R-40): that PUT sent the event back to review (`pending`).
    // The door is the subject here, not the review, which event-tickets-review
    // covers through the admin approve route; so the fixture sets the status
    // the approval would, directly, and the order below can be placed.
    await prisma.event.update({ where: { id }, data: { status: 'published' } });
    const bought = await http()
      .post(`/api/hub/events/${id}/orders`)
      .set(auth(buyerToken))
      .send({ ticketTypeId: tierId, quantity: 40 })
      .expect(201);
    const issued = await prisma.eventTicket.findMany({
      where: {
        orderId: (bought.body as { data: { orderId: string } }).data.orderId,
      },
      select: { code: true },
      orderBy: { createdAt: 'asc' },
    });
    return issued.map((t) => t.code);
  }

  beforeAll(async () => {
    [hostToken, buyerToken, staffToken] = await Promise.all([
      login(HOST_EMAIL),
      login(BUYER_EMAIL),
      login(STAFF_EMAIL),
    ]);
    ({ app, prisma } = await boot());
    ({ app: second } = await boot());
    await sweep();
    // EVENTS-11 (R-40): setting tickets needs a current tick. The host's tick
    // columns are kept and written back in afterAll.
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
    codes = await makeEvent(EV, 'Door key fixture');
    otherCode = (await makeEvent(EV_OTHER, 'Door key other fixture'))[0];
    await http()
      .post(`/api/hub/events/${EV}/door-staff`)
      .set(auth(hostToken))
      .send({ wawuUserId: STAFF_SUB })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await sweep();
    if (prisma && tickSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: tickSnapshot,
      });
    }
    if (app) await app.close();
    if (second) await second.close();
  });

  it("the verifier's case, with no key: the answer is lost, the scan is asked again, and the scanner's own door says ALREADY USED", async () => {
    const code = freshCode();
    const first = await scan(code).expect(201);
    expect(answer(first).outcome).toBe('valid');
    // The phone never heard that. It asks again.
    const again = await scan(code).expect(201);
    expect(answer(again).outcome).toBe('already_used');
    expect(again.headers['idempotent-replayed']).toBeUndefined();
  });

  it("the same case with a key: asked again, the first verdict comes back, the holder's name with it, and the ticket was checked in once", async () => {
    const code = freshCode();
    const key = newKey();
    const first = await scan(code, key).expect(201);
    expect(answer(first).outcome).toBe('valid');
    expect(answer(first).ticket).toMatchObject({
      code,
      tierName: 'Free',
      holderName: 'Chidi Umeh',
      checkedInBy: { role: 'host', label: null },
    });
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // A repeat is answered from the kept row: WAWU ID is not asked again and nothing is rewritten.
    const asked = jest.spyOn(app.get(WawuIdClient), 'lookupPublicIdentities');
    const again = await scan(code, key).expect(201);
    expect(asked).not.toHaveBeenCalled();
    asked.mockRestore();
    expect(again.headers['idempotent-replayed']).toBe('true');
    // The same bytes, not only the same data.
    expect(again.text).toBe(first.text);
    expect(answer(again).outcome).toBe('valid');
    expect(answer(again).ticket!.holderName).toBe('Chidi Umeh');

    const row = await prisma.eventTicket.findUniqueOrThrow({ where: { code } });
    expect(row.status).toBe('checked_in');
    expect(row.checkedInAt!.toISOString()).toBe(
      answer(first).ticket!.checkedInAt,
    );
    expect(
      await prisma.eventDoorScan.count({
        where: { scannerWawuId: HOST_SUB, key },
      }),
    ).toBe(1);

    // A NEW scan of the same ticket is a new key, and is already used.
    const rescan = await scan(code, newKey()).expect(201);
    expect(answer(rescan).outcome).toBe('already_used');
    expect(rescan.headers['idempotent-replayed']).toBeUndefined();
  });

  it('the check-in and its kept answer are one transaction: when the answer cannot be kept the ticket is not checked in, and the same key then works', async () => {
    const code = freshCode();
    const key = newKey();
    // A fault in the database: the kept answer can be taken (empty) but not written.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "EventDoorScan" ADD CONSTRAINT door_scan_fault CHECK ("response" = '') NOT VALID`,
    );
    try {
      const failed = await scan(code, key);
      expect(failed.status).not.toBe(201);
      const row = await prisma.eventTicket.findUniqueOrThrow({
        where: { code },
      });
      expect(row.status).toBe('valid');
      expect(row.checkedInAt).toBeNull();
      expect(
        await prisma.eventDoorScan.count({
          where: { scannerWawuId: HOST_SUB, key },
        }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "EventDoorScan" DROP CONSTRAINT IF EXISTS door_scan_fault`,
      );
    }
    // The phone asks again with the same key and is let in, once.
    const again = await scan(code, key).expect(201);
    expect(answer(again).outcome).toBe('valid');
    expect(
      (await prisma.eventTicket.findUniqueOrThrow({ where: { code } })).status,
    ).toBe('checked_in');
  });

  it("a repeat is the first answer even when others scanned in between: the counts are the first answer's, not live", async () => {
    const code = freshCode();
    const key = newKey();
    const first = await scan(code, key).expect(201);
    await scan(freshCode(), newKey()).expect(201);
    const again = await scan(code, key).expect(201);
    expect(answer(again).totals).toEqual(answer(first).totals);
  });

  it('a verdict that is not a let-in is kept too: not valid and already used are answered the same way again', async () => {
    const bad = newKey();
    const first = await scan('https://example.com/menu', bad).expect(201);
    expect(answer(first).outcome).toBe('invalid');
    const code = freshCode();
    await scan(code).expect(201);
    const usedKey = newKey();
    const used = await scan(code, usedKey).expect(201);
    expect(answer(used).outcome).toBe('already_used');
    // Even when the ticket is now somebody else's to find: the first answer stands.
    expect(
      (await scan('https://example.com/menu', bad).expect(201)).body,
    ).toEqual(first.body);
    expect((await scan(code, usedKey).expect(201)).body).toEqual(used.body);
  });

  it('twelve scans with one key at the same moment, over two Hub processes: all say LET THEM IN, and one ticket is checked in once', async () => {
    const code = freshCode();
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        scan(code, key, { via: i % 2 === 0 ? app : second }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(results.map((r) => answer(r).outcome)).toEqual(
      Array(12).fill('valid'),
    );
    const first: unknown = results[0].body;
    for (const r of results) expect(r.body).toEqual(first);
    expect(
      results.filter((r) => r.headers['idempotent-replayed'] === 'true'),
    ).toHaveLength(11);
    expect(
      await prisma.eventDoorScan.count({
        where: { scannerWawuId: HOST_SUB, key },
      }),
    ).toBe(1);
    const row = await prisma.eventTicket.findUniqueOrThrow({ where: { code } });
    expect(row.status).toBe('checked_in');
  });

  it('twelve scans of one ticket with twelve keys, over two Hub processes: one valid, eleven already used (the once-only guard is unchanged)', async () => {
    const code = freshCode();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        scan(code, newKey(), { via: i % 2 === 0 ? app : second }),
      ),
    );
    const outcomes = results.map((r) => answer(r).outcome);
    expect(outcomes.filter((o) => o === 'valid')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_used')).toHaveLength(11);
  });

  it("the key is the scanner's: door staff sending the same key text for another ticket make a different scan", async () => {
    const key = newKey();
    const hostCode = freshCode();
    const staffCode = freshCode();
    const byHost = await scan(hostCode, key).expect(201);
    const byStaff = await scan(staffCode, key, { token: staffToken }).expect(
      201,
    );
    expect(answer(byHost).ticket!.code).toBe(hostCode);
    expect(answer(byStaff).ticket!.code).toBe(staffCode);
    expect(answer(byStaff).ticket!.checkedInBy).toEqual({
      role: 'door_staff',
      label: 'Door 1',
    });
    expect(byStaff.headers['idempotent-replayed']).toBeUndefined();
    expect(await prisma.eventDoorScan.count({ where: { key } })).toBe(2);
    // Each is answered its own first answer when asked again.
    expect(
      (await scan(staffCode, key, { token: staffToken }).expect(201)).body,
    ).toEqual(byStaff.body);
  });

  it('a key used for another ticket, or for another event, is refused and checks nothing in', async () => {
    const key = newKey();
    await scan(freshCode(), key).expect(201);
    const other = freshCode();
    const reused = await scan(other, key).expect(409);
    expect((reused.body as { message: string }).message).toBe(
      DOOR_KEY_REUSED_MESSAGE,
    );
    const row = await prisma.eventTicket.findUniqueOrThrow({
      where: { code: other },
    });
    expect(row.status).toBe('valid');

    const k2 = newKey();
    const code = freshCode();
    await scan(code, k2).expect(201);
    await scan(otherCode, k2, { event: EV_OTHER }).expect(409);
    const otherRow = await prisma.eventTicket.findUniqueOrThrow({
      where: { code: otherCode },
    });
    expect(otherRow.status).toBe('valid');
  });

  it('a malformed key is a 400 and nothing is checked in; no key at all still works', async () => {
    const code = freshCode();
    for (const bad of [
      'short',
      'has space in it',
      'x'.repeat(129),
      'bad/chars/in/it',
    ]) {
      const res = await scan(code, bad).expect(400);
      expect((res.body as { message: string }).message).toBe(DOOR_KEY_MESSAGE);
    }
    const row = await prisma.eventTicket.findUniqueOrThrow({ where: { code } });
    expect(row.status).toBe('valid');
    await scan(code, 'k'.repeat(8)).expect(201);
    await scan(freshCode()).expect(201);
  });

  it('a refused scan is refused again, never answered from a stored row: removed staff, a stranger, an unknown event', async () => {
    const key = newKey();
    const code = freshCode();
    const staff = await http()
      .get(`/api/hub/events/${EV}/door-staff`)
      .set(auth(hostToken))
      .expect(200);
    const row = (
      staff.body as { data: Array<{ id: string; wawuUserId: string }> }
    ).data.find((s) => s.wawuUserId === STAFF_SUB)!;
    await scan(code, key, { token: staffToken }).expect(201);
    await http()
      .delete(`/api/hub/events/${EV}/door-staff/${row.id}`)
      .set(auth(hostToken))
      .expect(200);
    // The staff member was let go: their key no longer opens anything, not even the holder's name.
    await scan(code, key, { token: staffToken }).expect(403);
    await scan(code, newKey(), { token: buyerToken }).expect(403);
    await scan(code, newKey(), { event: randomUUID() }).expect(404);
    // Put back for the tests after this one.
    await http()
      .post(`/api/hub/events/${EV}/door-staff`)
      .set(auth(hostToken))
      .send({ wawuUserId: STAFF_SUB })
      .expect(201);
  });

  it('the first answers are kept a day or two and then purged, newest kept', async () => {
    const old = newKey();
    const recent = newKey();
    const now = new Date();
    const hours = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const row = (key: string, createdAt: Date) =>
      prisma.eventDoorScan.create({
        data: {
          scannerWawuId: HOST_SUB,
          key,
          eventId: EV,
          fingerprint: 'x',
          response: '{}',
          createdAt,
        },
      });
    await row(old, hours(DOOR_SCAN_KEY_HOURS + 1));
    await row(recent, hours(DOOR_SCAN_KEY_HOURS - 1));
    expect(DOOR_SCAN_KEY_HOURS).toBe(48);
    const service = app.get(EventRunningService);
    expect(await service.purgeDoorScans(now)).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.eventDoorScan.findFirst({ where: { key: old } }),
    ).toBeNull();
    expect(
      await prisma.eventDoorScan.findFirst({ where: { key: recent } }),
    ).not.toBeNull();
  });

  it("a ticket of this event that was voided reads cancelled; another event's ticket and made-up text are still the one plain answer", async () => {
    const voided = freshCode();
    const used = freshCode();
    await scan(used).expect(201);
    await prisma.eventTicket.updateMany({
      where: { code: { in: [voided, used] } },
      data: { status: 'void' },
    });
    for (const code of [voided, used.toLowerCase()]) {
      const res = await scan(code).expect(201);
      expect(answer(res).outcome).toBe('invalid');
      expect(answer(res).reason).toBe('cancelled');
      expect(answer(res).ticket).toBeNull();
    }
    // The same through a key, and kept.
    const key = newKey();
    const first = await scan(voided, key).expect(201);
    expect(answer(first).reason).toBe('cancelled');
    expect((await scan(voided, key).expect(201)).body).toEqual(first.body);

    // Another event's voided ticket says nothing about that event.
    await prisma.eventTicket.update({
      where: { code: otherCode },
      data: { status: 'void' },
    });
    const foreign = answer(await scan(otherCode).expect(201));
    const madeUp = answer(await scan('ZZZZ-ZZZZ-ZZZZ-ZZZZ').expect(201));
    expect(foreign.reason).toBeUndefined();
    expect(madeUp.reason).toBeUndefined();
    expect(foreign).toEqual(madeUp);
  });
});

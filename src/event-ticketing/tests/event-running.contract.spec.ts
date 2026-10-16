import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../../event/event.module';
import { EventTicketingModule } from '../event-ticketing.module';
import type {
  DoorCheckInResult,
  DoorStaffView,
} from '../event-running.service';

/**
 * EVENTS-05: running an event. The organiser's numbers and the door staff.
 *
 * What this file proves, each as something a person can do:
 *  - a host sees the same sold count on My events (E17, `GET /events/mine/sold`)
 *    and on the organiser dashboard (E18, `GET /events/:id/dashboard`), and it
 *    is the number of tickets actually issued;
 *  - a shared link's sales go up by one per ticket bought through it
 *    (`GET /events/:id/referrals`), and a voided ticket stops counting;
 *  - a host can add door staff, by WAWU id or by handle, and take them off;
 *  - door staff can check people in (`POST /events/:id/door/check-in`): the
 *    first scan lets them in with the holder's name (E20), the second says
 *    already used with when and by which door (E23), a code for another event
 *    is not valid (E24);
 *  - nobody else can: a stranger, removed staff, and staff of another event
 *    are refused, and only the host manages the door;
 *  - the protected host-only scan (`POST /events/:id/check-in`) still refuses
 *    door staff, exactly as before.
 *
 * Fixtures: every event here has an `e5000000-...` id and is swept in
 * afterAll with everything that cascades from it. The one throwaway WAWU ID
 * account this suite registers has its profile row removed too.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
/** Buys the tickets. The mock's name for this account is "Chidi Umeh". */
const BUYER_EMAIL = 'creator-basic@test.wawu.dev';
const BUYER_SUB = '00000000-0000-4000-8000-000000000002';
/** Works the door. */
const STAFF_EMAIL = 'creator-pro@test.wawu.dev';
const STAFF_SUB = '00000000-0000-4000-8000-000000000003';

const EV_MAIN = 'e5000000-0000-4000-8000-000000000001';
const EV_OTHER = 'e5000000-0000-4000-8000-000000000002';
const EV_EMPTY = 'e5000000-0000-4000-8000-000000000003';
const OUR_EVENTS = [EV_MAIN, EV_OTHER, EV_EMPTY];
const UNKNOWN_EVENT = 'e5000000-0000-4000-8000-0000000000ff';

const FUTURE = new Date('2027-05-06T09:00:00.000Z');

/** The `data` of the Hub's response envelope. */
function data<T>(res: { body: unknown }): T {
  return (res.body as { data: T }).data;
}

/** A door check-in answer; dates arrive as ISO strings. */
function door(res: { body: unknown }) {
  return data<
    Omit<DoorCheckInResult, 'ticket'> & {
      ticket:
        | (Omit<NonNullable<DoorCheckInResult['ticket']>, 'checkedInAt'> & {
            checkedInAt: string | null;
          })
        | null;
    }
  >(res);
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

/** A fresh account nobody else uses: the outsider at the door. */
async function registerOutsider(): Promise<{ token: string; sub: string }> {
  const n = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Door Outsider',
      email: `events05-${n}@test.wawu.dev`,
      phone: `+23490${n.slice(-8)}`,
      country: 'Nigeria',
      password: 'not-a-secret-1',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register: ${res.status}`);
  const token = ((await res.json()) as { accessToken: string }).accessToken;
  const { sub } = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as { sub: string };
  return { token, sub };
}

describe('Running an event: organiser numbers and door staff (EVENTS-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let staffToken: string;
  let outsider: { token: string; sub: string };
  const OUTSIDER_HANDLE = `e5door${Date.now().toString(36)}`;

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Ticket types by name, read back after the host sets them. */
  const tiers: Record<string, string> = {};
  /** Every ticket code the buyer was issued for EV_MAIN, in order. */
  const mainCodes: string[] = [];
  let otherEventCode = '';
  let referralCode = '';
  let secondReferralCode = '';

  async function sweep(): Promise<void> {
    await prisma.event.deleteMany({ where: { id: { in: OUR_EVENTS } } });
    if (outsider) {
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: outsider.sub },
      });
    }
  }

  async function buyFree(eventId: string, quantity: number, code?: string) {
    const res = await http()
      .post(`/api/hub/events/${eventId}/orders`)
      .set(auth(buyerToken))
      .send({
        ticketTypeId: tiers[`${eventId}:free`],
        quantity,
        ...(code ? { referralCode: code } : {}),
      })
      .expect(201);
    const tickets = await prisma.eventTicket.findMany({
      where: { orderId: data<{ orderId: string }>(res).orderId },
      orderBy: { createdAt: 'asc' },
      select: { code: true },
    });
    return tickets.map((t) => t.code);
  }

  async function buyPaid(eventId: string, quantity: number, code?: string) {
    const opened = await http()
      .post(`/api/hub/events/${eventId}/orders`)
      .set(auth(buyerToken))
      .send({
        ticketTypeId: tiers[`${eventId}:regular`],
        quantity,
        ...(code ? { referralCode: code } : {}),
      })
      .expect(201);
    const { orderId, flutterwaveConfig } = data<{
      orderId: string;
      flutterwaveConfig: { txRef: string };
    }>(opened);
    const verified = await http()
      .post(`/api/hub/events/orders/${orderId}/verify`)
      .set(auth(buyerToken))
      .send({
        transaction_id: `e5-${orderId}`,
        tx_ref: flutterwaveConfig.txRef,
      })
      .expect(201);
    return (data<unknown>(verified) as Array<{ code: string }>).map(
      (t) => t.code,
    );
  }

  beforeAll(async () => {
    [hostToken, buyerToken, staffToken] = await Promise.all([
      login(HOST_EMAIL),
      login(BUYER_EMAIL),
      login(STAFF_EMAIL),
    ]);
    outsider = await registerOutsider();

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

    await sweep();
    const base = {
      hostWawuId: HOST_SUB,
      description: 'A fixture event for the EVENTS-05 suite.',
      hostOrg: 'Door Fixtures Ltd',
      format: 'in_person' as const,
      type: 'summit' as const,
      location: 'Lagos',
      startsAt: FUTURE,
      status: 'published' as const,
    };
    await prisma.event.createMany({
      data: [
        { ...base, id: EV_MAIN, name: 'Creators Summit' },
        { ...base, id: EV_OTHER, name: 'Another Summit' },
        { ...base, id: EV_EMPTY, name: 'Nothing sold yet', status: 'pending' },
      ],
    });
    await prisma.userProfile.create({
      data: {
        wawuUserId: outsider.sub,
        accountType: 'user',
        handle: OUTSIDER_HANDLE,
      },
    });

    for (const eventId of [EV_MAIN, EV_OTHER]) {
      const res = await http()
        .put(`/api/hub/events/${eventId}/tickets`)
        .set(auth(hostToken))
        .send({
          types: [
            { tier: 'free', name: 'Free', priceNaira: 0, quantity: 50 },
            {
              tier: 'regular',
              name: 'Regular',
              priceNaira: 7500,
              quantity: 70,
            },
          ],
        })
        .expect(200);
      for (const t of data<unknown>(res) as Array<{
        id: string;
        tier: string;
      }>) {
        tiers[`${eventId}:${t.tier}`] = t.id;
      }
    }

    const links = await Promise.all(
      ['Ada on Instagram', 'Newsletter'].map((label) =>
        http()
          .post(`/api/hub/events/${EV_MAIN}/referrals`)
          .set(auth(hostToken))
          .send({ label })
          .expect(201),
      ),
    );
    referralCode = data<{ code: string }>(links[0]).code;
    secondReferralCode = data<{ code: string }>(links[1]).code;
  });

  afterAll(async () => {
    if (prisma) await sweep();
    if (app) await app.close();
  });

  // ── the organiser's numbers ────────────────────────────────────────────

  describe('sold counts and shared links', () => {
    beforeAll(async () => {
      // 3 paid through the first link, 1 free through it, 2 free directly,
      // and 1 paid on the other event.
      mainCodes.push(...(await buyPaid(EV_MAIN, 3, referralCode)));
      mainCodes.push(...(await buyFree(EV_MAIN, 1, referralCode)));
      mainCodes.push(...(await buyFree(EV_MAIN, 2)));
      otherEventCode = (await buyPaid(EV_OTHER, 1))[0];
    });

    it('a host sees the same sold count on My events and on the dashboard, equal to tickets issued', async () => {
      const issued = await prisma.eventTicket.count({
        where: { eventId: EV_MAIN },
      });
      expect(issued).toBe(6);

      const sold = await http()
        .get('/api/hub/events/mine/sold')
        .set(auth(hostToken))
        .expect(200);
      const items = data<{ items: unknown }>(sold).items as Array<{
        eventId: string;
        ticketsSold: number;
      }>;
      const byId = new Map(items.map((i) => [i.eventId, i.ticketsSold]));
      expect(byId.get(EV_MAIN)).toBe(6);
      expect(byId.get(EV_OTHER)).toBe(1);
      // An event with nothing sold is listed, at zero.
      expect(byId.get(EV_EMPTY)).toBe(0);

      const dash = await http()
        .get(`/api/hub/events/${EV_MAIN}/dashboard`)
        .set(auth(hostToken))
        .expect(200);
      expect(data<{ ticketsSold: number }>(dash).ticketsSold).toBe(
        byId.get(EV_MAIN),
      );
    });

    it("My events sold counts are the caller's own: another account sees none of these events", async () => {
      const res = await http()
        .get('/api/hub/events/mine/sold')
        .set(auth(buyerToken))
        .expect(200);
      const ids = (
        data<{ items: unknown }>(res).items as Array<{ eventId: string }>
      ).map((i) => i.eventId);
      for (const id of OUR_EVENTS) expect(ids).not.toContain(id);
    });

    it("a referral link's sales go up by one per ticket bought through it", async () => {
      const before = await http()
        .get(`/api/hub/events/${EV_MAIN}/referrals`)
        .set(auth(hostToken))
        .expect(200);
      const first = (
        data<unknown>(before) as Array<{
          code: string;
          ticketsSold: number;
          revenueNaira: number;
          label: string;
        }>
      ).find((r) => r.code === referralCode)!;
      expect(first.label).toBe('Ada on Instagram');
      expect(first.ticketsSold).toBe(4);
      expect(first.revenueNaira).toBe(3 * 7500);
      const second = (
        data<unknown>(before) as Array<{ code: string; ticketsSold: number }>
      ).find((r) => r.code === secondReferralCode)!;
      expect(second.ticketsSold).toBe(0);

      mainCodes.push(...(await buyFree(EV_MAIN, 1, referralCode)));

      const after = await http()
        .get(`/api/hub/events/${EV_MAIN}/referrals`)
        .set(auth(hostToken))
        .expect(200);
      const firstAfter = (
        data<unknown>(after) as Array<{ code: string; ticketsSold: number }>
      ).find((r) => r.code === referralCode)!;
      expect(firstAfter.ticketsSold).toBe(5);
    });

    it("the shared links are the host's alone", async () => {
      await http()
        .get(`/api/hub/events/${EV_MAIN}/referrals`)
        .set(auth(buyerToken))
        .expect(403);
      await http()
        .get(`/api/hub/events/${UNKNOWN_EVENT}/referrals`)
        .set(auth(hostToken))
        .expect(404);
      await http()
        .get('/api/hub/events/not-a-uuid/referrals')
        .set(auth(hostToken))
        .expect(400);
      await http().get(`/api/hub/events/${EV_MAIN}/referrals`).expect(401);
      await http().get('/api/hub/events/mine/sold').expect(401);
    });
  });

  // ── door staff ─────────────────────────────────────────────────────────

  describe('door staff', () => {
    let staffRowId = '';

    it('before being added, door staff cannot check anyone in', async () => {
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[0] })
        .expect(403);
      const t = await prisma.eventTicket.findUnique({
        where: { code: mainCodes[0] },
      });
      expect(t?.status).toBe('valid');
    });

    it('a host can add door staff by WAWU id; the default label is Door 1', async () => {
      const res = await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: STAFF_SUB })
        .expect(201);
      expect(data<DoorStaffView>(res)).toMatchObject({
        wawuUserId: STAFF_SUB,
        label: 'Door 1',
        displayName: 'Zainab Bello',
      });
      staffRowId = data<DoorStaffView>(res).id;
    });

    it('a host can add door staff by handle, with their own label', async () => {
      const res = await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ handle: `@${OUTSIDER_HANDLE}`, label: 'VIP gate' })
        .expect(201);
      expect(data<DoorStaffView>(res)).toMatchObject({
        wawuUserId: outsider.sub,
        label: 'VIP gate',
        handle: OUTSIDER_HANDLE,
      });

      const list = await http()
        .get(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .expect(200);
      expect(
        (data<unknown>(list) as Array<{ label: string }>).map((s) => s.label),
      ).toEqual(['Door 1', 'VIP gate']);
    });

    it('adding is refused when wrong: twice, the host, nobody, both names, someone unknown', async () => {
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: STAFF_SUB })
        .expect(409);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: HOST_SUB })
        .expect(400);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({})
        .expect(400);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: STAFF_SUB, handle: OUTSIDER_HANDLE })
        .expect(400);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: 'e5000000-0000-4000-8000-00000000dead' })
        .expect(404);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ handle: 'nobody-has-this' })
        .expect(400);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ handle: 'e5nobodyhasthishandle' })
        .expect(404);
    });

    it('only the host manages the door', async () => {
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(staffToken))
        .send({ wawuUserId: BUYER_SUB })
        .expect(403);
      await http()
        .get(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(staffToken))
        .expect(403);
      await http()
        .delete(`/api/hub/events/${EV_MAIN}/door-staff/${staffRowId}`)
        .set(auth(staffToken))
        .expect(403);
      await http().get(`/api/hub/events/${EV_MAIN}/door-staff`).expect(401);
    });

    it('door staff see the event they work the door at', async () => {
      const res = await http()
        .get('/api/hub/events/door/mine')
        .set(auth(staffToken))
        .expect(200);
      const mine = (
        data<{ items: unknown }>(res).items as Array<{
          eventId: string;
          label: string;
          eventName: string;
        }>
      ).find((e) => e.eventId === EV_MAIN);
      expect(mine).toMatchObject({
        label: 'Door 1',
        eventName: 'Creators Summit',
      });
      expect(
        (
          data<{ items: unknown }>(res).items as Array<{ eventId: string }>
        ).some((e) => e.eventId === EV_OTHER),
      ).toBe(false);
    });

    it("door staff can check people in: let them in with the holder's name (E20)", async () => {
      const res = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        // A code typed by hand, in lower case with spaces around it.
        .send({ code: `  ${mainCodes[0].toLowerCase()} ` })
        .expect(201);
      expect(door(res).outcome).toBe('valid');
      expect(door(res).ticket).toMatchObject({
        code: mainCodes[0],
        tierName: 'Regular',
        holderName: 'Chidi Umeh',
        checkedInBy: { role: 'door_staff', label: 'Door 1' },
      });
      expect(typeof door(res).ticket!.checkedInAt).toBe('string');
      expect(door(res).totals).toEqual({
        sold: 7,
        checkedIn: 1,
        stillToArrive: 6,
        remaining: 120 - 7,
      });
    });

    it("the same ticket twice shows 'already used', with the first time and the door (E23)", async () => {
      const first = await prisma.eventTicket.findUniqueOrThrow({
        where: { code: mainCodes[0] },
      });
      // The host scans it again, on the host's own screen.
      const res = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(hostToken))
        .send({ code: mainCodes[0] })
        .expect(201);
      expect(door(res).outcome).toBe('already_used');
      expect(door(res).ticket!.checkedInAt).toBe(
        first.checkedInAt!.toISOString(),
      );
      expect(door(res).ticket!.checkedInBy).toEqual({
        role: 'door_staff',
        label: 'Door 1',
      });
      expect(door(res).totals.checkedIn).toBe(1);
    });

    it('the host checks someone in on the same route; it reads as the host', async () => {
      const res = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(hostToken))
        .send({ code: mainCodes[1] })
        .expect(201);
      expect(door(res).outcome).toBe('valid');
      expect(door(res).ticket!.checkedInBy).toEqual({
        role: 'host',
        label: null,
      });
    });

    it('two door staff scanning one code at once let it in exactly once', async () => {
      const outsiderScan = http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(outsider.token))
        .send({ code: mainCodes[2] });
      const staffScan = http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[2] });
      const [a, b] = await Promise.all([outsiderScan, staffScan]);
      const outcomes = [door(a).outcome, door(b).outcome].sort();
      expect(outcomes).toEqual(['already_used', 'valid']);
    });

    it('a ticket for another event is not valid here (E24), and nothing changes', async () => {
      const res = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: otherEventCode })
        .expect(201);
      expect(door(res).outcome).toBe('invalid');
      expect(door(res).ticket).toBeNull();
      const t = await prisma.eventTicket.findUniqueOrThrow({
        where: { code: otherEventCode },
      });
      expect(t.status).toBe('valid');

      const unknown = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })
        .expect(201);
      expect(door(unknown).outcome).toBe('invalid');
    });

    it('door staff of one event cannot check in at another', async () => {
      await http()
        .post(`/api/hub/events/${EV_OTHER}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: otherEventCode })
        .expect(403);
    });

    it('the protected host-only scan still refuses door staff, as before', async () => {
      await http()
        .post(`/api/hub/events/${EV_MAIN}/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[3] })
        .expect(403);
    });

    it('a stranger and an unknown event are refused at the door', async () => {
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(buyerToken))
        .send({ code: mainCodes[3] })
        .expect(403);
      await http()
        .post(`/api/hub/events/${UNKNOWN_EVENT}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[3] })
        .expect(404);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .send({ code: mainCodes[3] })
        .expect(401);
      await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: 'ab' })
        .expect(400);
    });

    it('removed door staff can no longer check in, and what they let in still names their door', async () => {
      await http()
        .delete(`/api/hub/events/${EV_MAIN}/door-staff/${staffRowId}`)
        .set(auth(hostToken))
        .expect(200);
      // Removing again is the same end state.
      await http()
        .delete(`/api/hub/events/${EV_MAIN}/door-staff/${staffRowId}`)
        .set(auth(hostToken))
        .expect(200);

      await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[3] })
        .expect(403);

      const again = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(hostToken))
        .send({ code: mainCodes[0] })
        .expect(201);
      expect(door(again).ticket!.checkedInBy).toEqual({
        role: 'door_staff',
        label: 'Door 1',
      });

      const list = await http()
        .get(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .expect(200);
      expect(
        (data<unknown>(list) as Array<{ wawuUserId: string }>).map(
          (s) => s.wawuUserId,
        ),
      ).toEqual([outsider.sub]);

      const doors = await http()
        .get('/api/hub/events/door/mine')
        .set(auth(staffToken))
        .expect(200);
      expect(
        (
          data<{ items: unknown }>(doors).items as Array<{ eventId: string }>
        ).some((e) => e.eventId === EV_MAIN),
      ).toBe(false);

      // Added back, they keep their label and can scan again.
      const back = await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: STAFF_SUB })
        .expect(201);
      expect(data<DoorStaffView>(back).label).toBe('Door 1');
      const scan = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[3] })
        .expect(201);
      expect(door(scan).outcome).toBe('valid');

      await http()
        .delete(
          `/api/hub/events/${EV_MAIN}/door-staff/e5000000-0000-4000-8000-00000000beef`,
        )
        .set(auth(hostToken))
        .expect(404);
    });

    it('a called-off event voids its tickets: they stop counting as sold or as link sales, and stop scanning', async () => {
      await http()
        .post(`/api/hub/events/${EV_MAIN}/cancel`)
        .set(auth(hostToken))
        .send({ reason: 'The venue withdrew at short notice.' })
        .expect(201);

      const sold = await http()
        .get('/api/hub/events/mine/sold')
        .set(auth(hostToken))
        .expect(200);
      const main = (
        data<{ items: unknown }>(sold).items as Array<{
          eventId: string;
          ticketsSold: number;
        }>
      ).find((i) => i.eventId === EV_MAIN)!;
      expect(main.ticketsSold).toBe(0);
      const dash = await http()
        .get(`/api/hub/events/${EV_MAIN}/dashboard`)
        .set(auth(hostToken))
        .expect(200);
      expect(data<{ ticketsSold: number }>(dash).ticketsSold).toBe(0);

      const links = await http()
        .get(`/api/hub/events/${EV_MAIN}/referrals`)
        .set(auth(hostToken))
        .expect(200);
      for (const r of data<unknown>(links) as Array<{ ticketsSold: number }>) {
        expect(r.ticketsSold).toBe(0);
      }

      const scan = await http()
        .post(`/api/hub/events/${EV_MAIN}/door/check-in`)
        .set(auth(staffToken))
        .send({ code: mainCodes[4] })
        .expect(201);
      expect(door(scan).outcome).toBe('invalid');

      await http()
        .post(`/api/hub/events/${EV_MAIN}/door-staff`)
        .set(auth(hostToken))
        .send({ wawuUserId: BUYER_SUB })
        .expect(409);
    });
  });
  // ── fix round 1: blocks, labels, another event's staff row ─────────────

  describe('door staff: blocks, unique labels, one event at a time', () => {
    const post = (token: string, eventId: string, body: object) =>
      http()
        .post(`/api/hub/events/${eventId}/door-staff`)
        .set(auth(token))
        .send(body);

    it('a host cannot add someone who has blocked them, or whom they blocked: a 404 like a missing account', async () => {
      for (const [userWawuId, blockedWawuId] of [
        [outsider.sub, HOST_SUB],
        [HOST_SUB, outsider.sub],
      ]) {
        await prisma.blockedAccount.create({
          data: { userWawuId, blockedWawuId },
        });
        try {
          const byId = await post(hostToken, EV_EMPTY, {
            wawuUserId: outsider.sub,
          }).expect(404);
          expect(JSON.stringify(byId.body)).toContain(
            'We could not find that account.',
          );
          await post(hostToken, EV_EMPTY, {
            handle: OUTSIDER_HANDLE,
          }).expect(404);
          expect(
            await prisma.eventDoorStaff.count({
              where: { eventId: EV_EMPTY, staffWawuId: outsider.sub },
            }),
          ).toBe(0);
        } finally {
          await prisma.blockedAccount.deleteMany({
            where: { userWawuId, blockedWawuId },
          });
        }
      }
    });

    it('people added at the same moment get different default labels', async () => {
      const results = await Promise.all(
        [STAFF_SUB, BUYER_SUB, outsider.sub].map((wawuUserId) =>
          post(hostToken, EV_EMPTY, { wawuUserId }),
        ),
      );
      for (const r of results) expect(r.status).toBe(201);
      const labels = results.map((r) => data<DoorStaffView>(r).label);
      expect(new Set(labels).size).toBe(3);
    });

    it('a label already used at the door is refused, whatever its case', async () => {
      const active = await prisma.eventDoorStaff.findMany({
        where: { eventId: EV_EMPTY, removedAt: null },
        orderBy: { addedAt: 'asc' },
      });
      expect(active.length).toBe(3);
      await http()
        .delete(`/api/hub/events/${EV_EMPTY}/door-staff/${active[2].id}`)
        .set(auth(hostToken))
        .expect(200);
      const res = await post(hostToken, EV_EMPTY, {
        wawuUserId: active[2].staffWawuId,
        label: active[0].label.toUpperCase(),
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('already has that name');
    });

    it("a staff row of another event cannot be removed through this event's path", async () => {
      const mine = await prisma.eventDoorStaff.findFirstOrThrow({
        where: { eventId: EV_EMPTY, removedAt: null },
      });
      await http()
        .delete(`/api/hub/events/${EV_OTHER}/door-staff/${mine.id}`)
        .set(auth(hostToken))
        .expect(404);
      const after = await prisma.eventDoorStaff.findUniqueOrThrow({
        where: { id: mine.id },
      });
      expect(after.removedAt).toBeNull();
    });

    it('the default label is the lowest free "Door n": a gap left by someone removed is filled', async () => {
      // Start this event's door from nothing, so the labels are known.
      await prisma.eventDoorStaff.deleteMany({ where: { eventId: EV_EMPTY } });
      const add = async (wawuUserId: string) =>
        data<DoorStaffView>(
          await post(hostToken, EV_EMPTY, { wawuUserId }).expect(201),
        );

      const first = await add(STAFF_SUB);
      const second = await add(BUYER_SUB);
      expect([first.label, second.label]).toEqual(['Door 1', 'Door 2']);

      // Door 1 leaves; the next person added takes Door 1, not Door 3.
      await http()
        .delete(`/api/hub/events/${EV_EMPTY}/door-staff/${first.id}`)
        .set(auth(hostToken))
        .expect(200);
      expect((await add(outsider.sub)).label).toBe('Door 1');
    });

    it('someone put back whose old label another person now holds gets a free one, never a shared one', async () => {
      // From the test above: Door 1 (the outsider) and Door 2 are active;
      // the first person, once Door 1, is removed and their old label is taken.
      const back = data<DoorStaffView>(
        await post(hostToken, EV_EMPTY, { wawuUserId: STAFF_SUB }).expect(201),
      );
      expect(back.label).toBe('Door 3');
      const active = await prisma.eventDoorStaff.findMany({
        where: { eventId: EV_EMPTY, removedAt: null },
        select: { label: true },
      });
      const labels = active.map((r) => r.label.toLowerCase());
      expect(active.length).toBe(3);
      expect(new Set(labels).size).toBe(3);
    });

    it('a custom label is stored without the spaces around it, and then collides with the same name', async () => {
      const outsiderRow = await prisma.eventDoorStaff.findUniqueOrThrow({
        where: {
          eventId_staffWawuId: { eventId: EV_EMPTY, staffWawuId: outsider.sub },
        },
      });
      await http()
        .delete(`/api/hub/events/${EV_EMPTY}/door-staff/${outsiderRow.id}`)
        .set(auth(hostToken))
        .expect(200);
      const gate = data<DoorStaffView>(
        await post(hostToken, EV_EMPTY, {
          wawuUserId: outsider.sub,
          label: '  Gate  ',
        }).expect(201),
      );
      expect(gate.label).toBe('Gate');
      const stored = await prisma.eventDoorStaff.findUniqueOrThrow({
        where: { id: outsiderRow.id },
      });
      expect(stored.label).toBe('Gate');

      // Another person named "Gate" with spaces of their own is refused.
      const buyerRow = await prisma.eventDoorStaff.findUniqueOrThrow({
        where: {
          eventId_staffWawuId: { eventId: EV_EMPTY, staffWawuId: BUYER_SUB },
        },
      });
      await http()
        .delete(`/api/hub/events/${EV_EMPTY}/door-staff/${buyerRow.id}`)
        .set(auth(hostToken))
        .expect(200);
      const res = await post(hostToken, EV_EMPTY, {
        wawuUserId: BUYER_SUB,
        label: ' Gate',
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('already has that name');
    });
  });
});

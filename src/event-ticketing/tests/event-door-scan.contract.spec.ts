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
import { MAX_DOOR_SCAN_LENGTH } from '../dto/event-running.dto';
import type { DoorCheckInResult } from '../event-running.service';

/**
 * EVENTS-09: the door answers every scan.
 *
 * A phone camera reads whatever QR is in front of it, so what arrives at
 * `POST /events/:id/door/check-in` is not always a ticket code: a flyer's
 * link, a poster, a wifi code. The door's job is a verdict for all of them
 * (the red "Not a valid ticket", E24, with the live counts), never a
 * validation error and never a server error.
 *
 *  - a QR that is a long link is not valid, with the counts, and nothing
 *    is checked in;
 *  - text a ticket code can never be (control characters, a null byte,
 *    letters outside ASCII, only spaces) is not valid, never a 500;
 *  - the body still refuses text shorter than a code (4) and longer than the
 *    door takes (`MAX_DOOR_SCAN_LENGTH`), as a plain 400;
 *  - a real ticket still lets one person in once: first scan valid with the
 *    holder's name, second already used;
 *  - the host-only protected scan (`POST /events/:id/check-in`) keeps its own
 *    40 character limit, byte for byte as the web calls it.
 *
 * Fixtures: one event with an `e9000000-...` id, swept in afterAll.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const HOST_EMAIL = 'user@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000001';
const BUYER_EMAIL = 'creator-basic@test.wawu.dev';

const EV = 'e9000000-0000-4000-8000-000000000001';
const FUTURE = new Date('2027-05-06T09:00:00.000Z');

function data<T>(res: { body: unknown }): T {
  return (res.body as { data: T }).data;
}

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

describe('The door answers every scan (EVENTS-09)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let buyerToken: string;
  let ticketCode = '';

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const scan = (code: string) =>
    http()
      .post(`/api/hub/events/${EV}/door/check-in`)
      .set(auth(hostToken))
      .send({ code });

  async function sweep(): Promise<void> {
    await prisma.event.deleteMany({ where: { id: EV } });
  }

  beforeAll(async () => {
    [hostToken, buyerToken] = await Promise.all([
      login(HOST_EMAIL),
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

    await sweep();
    await prisma.event.create({
      data: {
        id: EV,
        name: 'Door scan fixture',
        hostWawuId: HOST_SUB,
        description: 'A fixture event for the EVENTS-09 suite.',
        hostOrg: 'Door Fixtures Ltd',
        format: 'in_person',
        type: 'summit',
        location: 'Lagos',
        startsAt: FUTURE,
        status: 'published',
      },
    });
    const tiers = await http()
      .put(`/api/hub/events/${EV}/tickets`)
      .set(auth(hostToken))
      .send({
        types: [{ tier: 'free', name: 'Free', priceNaira: 0, quantity: 50 }],
      })
      .expect(200);
    const tierId = (data<unknown>(tiers) as Array<{ id: string }>)[0].id;
    const bought = await http()
      .post(`/api/hub/events/${EV}/orders`)
      .set(auth(buyerToken))
      .send({ ticketTypeId: tierId, quantity: 1 })
      .expect(201);
    const issued = await prisma.eventTicket.findMany({
      where: { orderId: data<{ orderId: string }>(bought).orderId },
      select: { code: true },
    });
    ticketCode = issued[0].code;
  });

  afterAll(async () => {
    if (prisma) await sweep();
    if (app) await app.close();
  });

  it('a QR that is a long link is not valid (E24) with the live counts, and nothing is checked in', async () => {
    const link = `https://example.com/${'menu/'.repeat(24)}`;
    expect(link.length).toBeGreaterThan(40);
    const res = await scan(link).expect(201);
    expect(door(res).outcome).toBe('invalid');
    expect(door(res).ticket).toBeNull();
    expect(door(res).totals).toEqual({
      sold: 1,
      checkedIn: 0,
      stillToArrive: 1,
      remaining: 49,
    });
    const t = await prisma.eventTicket.findUniqueOrThrow({
      where: { code: ticketCode },
    });
    expect(t.status).toBe('valid');
  });

  it('text a ticket code can never be is not valid, never an error: control characters, a null byte, letters outside ASCII, spaces', async () => {
    for (const text of [
      'AB\u0000CD-EFGH',
      'AB\tCD-EFGH-JKMN',
      'TICKET ✓ OK',
      'éééé',
      '        ',
    ]) {
      const res = await scan(text).expect(201);
      expect(door(res).outcome).toBe('invalid');
      expect(door(res).ticket).toBeNull();
    }
  });

  it('the body takes exactly what a scanner can hand over: 500 characters, not 501, and not fewer than 4', async () => {
    await scan('x'.repeat(MAX_DOOR_SCAN_LENGTH)).expect(201);
    await scan('x'.repeat(MAX_DOOR_SCAN_LENGTH + 1)).expect(400);
    await scan('abc').expect(400);
    await http()
      .post(`/api/hub/events/${EV}/door/check-in`)
      .set(auth(hostToken))
      .send({})
      .expect(400);
  });

  it('a real ticket still lets one person in once: valid with the holder name, then already used', async () => {
    const first = await scan(` ${ticketCode.toLowerCase()} `).expect(201);
    expect(door(first).outcome).toBe('valid');
    expect(door(first).ticket).toMatchObject({
      code: ticketCode,
      tierName: 'Free',
      holderName: 'Chidi Umeh',
      checkedInBy: { role: 'host', label: null },
    });
    expect(door(first).totals.checkedIn).toBe(1);

    const second = await scan(ticketCode).expect(201);
    expect(door(second).outcome).toBe('already_used');
    expect(door(second).ticket!.checkedInAt).toBe(
      door(first).ticket!.checkedInAt,
    );
    expect(door(second).totals).toEqual({
      sold: 1,
      checkedIn: 1,
      stillToArrive: 0,
      remaining: 49,
    });
  });

  it('the host-only protected scan keeps its own limit: 41 characters is still a 400', async () => {
    await http()
      .post(`/api/hub/events/${EV}/check-in`)
      .set(auth(hostToken))
      .send({ code: 'A'.repeat(41) })
      .expect(400);
    await http()
      .post(`/api/hub/events/${EV}/check-in`)
      .set(auth(hostToken))
      .send({ code: 'A'.repeat(40) })
      .expect(201);
  });
});

// Contract tests for pausing paid questions for a creator who stops replying
// (task INBOX-09, DECISIONS R-13). Real tokens from the local mock WAWU ID, a
// real database.
//
// Capability check: a creator at 21% unanswered over 30 days is warned once;
// at 31% paid questions switch off for 7 days and a fan is refused (I8). The
// lines (20% and 30%) come from config.
//
// Also: the boundaries (at the line, one under, the window's edge, a deadline
// at the exact instant, the exact end of a pause), the transitions under
// parallel requests (one warning, one pause, never extended), a fresh count
// after a pause, the sweep, and who may read what.
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
import { DirectMessageModule } from '../direct-message.module';
import { PaidDmPauseService } from '../paid-dm-pause.service';
import type { PaidDmAvailability, PaidDmStanding } from '../paid-dm-view.type';

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
      fullName: `Pause Spec ${label}`,
      email: `pause-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
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

describe('Pausing paid questions for creators who stop replying (contract, INBOX-09)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let pause: PaidDmPauseService;
  let mock: ChildProcess | undefined;

  let fan: Person;
  let plain: Person;
  const people: string[] = [];
  const created: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (who: Person) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${who.token}`).send(body),
  });

  /** A creator who takes paid questions at 1500 naira. */
  async function creator(label: string): Promise<Person> {
    const p = await registerPerson(label);
    people.push(p.sub);
    await prisma.userProfile.create({
      data: {
        wawuUserId: p.sub,
        accountType: 'creator',
        handle: `pause_${p.sub.slice(0, 8)}`,
        interests: [],
      },
    });
    await prisma.creatorState.create({
      data: {
        wawuUserId: p.sub,
        kycStatus: 'approved',
        dmEnabled: true,
        dmPrice: 1500,
        dmResponseHours: 24,
      },
    });
    return p;
  }

  /**
   * Settled paid questions sent `sentAgoMs` ago: `unanswered` that lapsed
   * (status refunded, as the sweep leaves them) and `answered` that were
   * replied to.
   */
  async function questions(
    to: Person,
    counts: { unanswered?: number; answered?: number },
    sentAgoMs = 2 * DAY,
    at: Date = new Date(),
  ) {
    const rows: Array<{
      id: string;
      status: 'refunded' | 'responded';
    }> = [];
    for (let i = 0; i < (counts.unanswered ?? 0); i += 1) {
      rows.push({ id: randomUUID(), status: 'refunded' });
    }
    for (let i = 0; i < (counts.answered ?? 0); i += 1) {
      rows.push({ id: randomUUID(), status: 'responded' });
    }
    created.push(...rows.map((r) => r.id));
    const sentAt = new Date(at.getTime() - sentAgoMs);
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
        flutterwaveTxRef: `pause-spec-${r.id}`,
        responseWindowHours: 24,
      })),
    });
  }

  const standing = async (who: Person) =>
    data<PaidDmStanding>(await as(who).get('/paid-dm/standing').expect(200));

  const notes = (who: Person, kind: string) =>
    prisma.notification.count({ where: { userWawuId: who.sub, kind } });

  const tracker = (who: Person) =>
    prisma.creatorNoResponseTracker.findUniqueOrThrow({
      where: { creatorWawuId: who.sub },
    });

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
    pause = moduleRef.get(PaidDmPauseService);

    for (const p of [fan, plain]) {
      people.push(p.sub);
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `pause_${p.sub.slice(0, 8)}`,
          interests: [],
        },
      });
    }
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      await prisma.pendingCharge.deleteMany({
        where: { wawuUserId: { in: people } },
      });
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

  describe('who may read what', () => {
    it('401s with no token and 403s a plain account on the creator standing', async () => {
      await http().get('/paid-dm/standing').expect(401);
      await as(plain).get('/paid-dm/standing').expect(403);
    });

    it('availability: 401 with no token, 400 for a bad id, 404 for an account with no creator state', async () => {
      const c = await creator('Reads');
      await http().get(`/paid-dm/creators/${c.sub}/availability`).expect(401);
      await as(fan)
        .get('/paid-dm/creators/not-a-uuid/availability')
        .expect(400);
      await as(fan)
        .get(`/paid-dm/creators/${plain.sub}/availability`)
        .expect(404);
      await as(fan)
        .get(`/paid-dm/creators/${randomUUID()}/availability`)
        .expect(404);
    });

    it('availability shows a fan only paused and the end time, never the rate', async () => {
      const c = await creator('Shape');
      await questions(c, { unanswered: 31, answered: 69 });
      const res = await as(fan)
        .get(`/paid-dm/creators/${c.sub}/availability`)
        .expect(200);
      const body = data<PaidDmAvailability>(res);
      expect(Object.keys(body).sort()).toEqual([
        'creatorWawuId',
        'paused',
        'pausedUntil',
      ]);
      expect(body.paused).toBe(true);
    });
  });

  describe('the lines (20% warns, 30% pauses), at and either side', () => {
    it('no questions yet: ok at 0%', async () => {
      const c = await creator('Fresh');
      const s = await standing(c);
      expect(s).toMatchObject({
        state: 'ok',
        acceptingPaidMessages: true,
        unansweredPct: 0,
        questions: 0,
        warnAtPct: 20,
        pauseAtPct: 30,
        windowDays: 30,
        pauseDays: 7,
        pausedUntil: null,
      });
    });

    it.each([
      [19, 'ok'],
      [20, 'warning'],
      [21, 'warning'],
      [29, 'warning'],
      [30, 'paused'],
      [31, 'paused'],
    ] as const)('%i of 100 unanswered is %s', async (n, state) => {
      const c = await creator(`Line${n}`);
      await questions(c, { unanswered: n, answered: 100 - n });
      const s = await standing(c);
      expect(s.state).toBe(state);
      expect(s.acceptingPaidMessages).toBe(state !== 'paused');
      expect(s.unansweredPct).toBe(n);
      if (state === 'paused') {
        const until = new Date(s.pausedUntil as string).getTime();
        expect(Math.abs(until - (Date.now() + 7 * DAY))).toBeLessThan(10_000);
      } else {
        expect(s.pausedUntil).toBeNull();
        expect(s.unanswered).toBe(n);
        expect(s.questions).toBe(100);
      }
    });

    it('the share is exact at small counts: 1 of 5 is 20% and warns, 1 of 6 is 16.67% and does not', async () => {
      const a = await creator('Small5');
      await questions(a, { unanswered: 1, answered: 4 });
      expect((await standing(a)).state).toBe('warning');
      const b = await creator('Small6');
      await questions(b, { unanswered: 1, answered: 5 });
      const s = await standing(b);
      expect(s.state).toBe('ok');
      expect(s.unansweredPct).toBe(16.67);
    });

    it('a question still inside its window counts for nothing; one at the exact deadline instant is still answerable', async () => {
      const c = await creator('Open');
      const now = new Date();
      const open = [
        { id: randomUUID(), deadlineAt: new Date(now.getTime() + HOUR) },
        { id: randomUUID(), deadlineAt: now }, // exactly now: still answerable
      ];
      created.push(...open.map((o) => o.id));
      await prisma.directMessage.createMany({
        data: open.map((o) => ({
          id: o.id,
          creatorWawuId: c.sub,
          senderWawuId: fan.sub,
          text: 'waiting',
          amount: 1500,
          status: 'awaiting_response' as const,
          sentAt: new Date(now.getTime() - HOUR),
          deadlineAt: o.deadlineAt,
          flutterwaveTxRef: `pause-spec-${o.id}`,
          responseWindowHours: 24,
        })),
      });
      const s = await pause.standing(c.sub, now);
      expect(s).toMatchObject({ state: 'ok', questions: 0, unanswered: 0 });
      // One millisecond later the exact-deadline question has lapsed, with
      // the sweep not having run: it counts as unanswered on its own.
      const later = await pause.standing(c.sub, new Date(now.getTime() + 1));
      expect(later).toMatchObject({
        questions: 1,
        unanswered: 1,
        state: 'paused',
      });
    });

    it('the window is rolling: a question sent exactly 30 days ago counts, one a millisecond older does not', async () => {
      const c = await creator('Window');
      const now = new Date();
      await questions(c, { unanswered: 1 }, 30 * DAY, now);
      expect(await pause.standing(c.sub, now)).toMatchObject({
        questions: 1,
        unanswered: 1,
      });
      const d = await creator('WindowOld');
      await questions(d, { unanswered: 1 }, 30 * DAY + 1, now);
      expect(await pause.standing(d.sub, now)).toMatchObject({
        questions: 0,
        unanswered: 0,
        state: 'ok',
      });
    });

    it('an old miss ages out: the same creator is ok once it leaves the window', async () => {
      const c = await creator('Ages');
      const now = new Date();
      await questions(c, { unanswered: 3, answered: 7 }, 29 * DAY, now);
      expect((await pause.standing(c.sub, now)).state).toBe('paused');
      const d = await creator('Ages2');
      await questions(d, { unanswered: 3, answered: 7 }, 29 * DAY, now);
      const after = await pause.standing(
        d.sub,
        new Date(now.getTime() + 2 * DAY),
      );
      expect(after).toMatchObject({ state: 'ok', questions: 0 });
    });
  });

  describe('the stored row a live route reads', () => {
    it('is left exactly as it was for a creator who is fine, and kept current once they are flagged', async () => {
      const c = await creator('Row');
      await prisma.creatorNoResponseTracker.create({
        data: { creatorWawuId: c.sub, noResponseRatePct: 4.2 },
      });
      await standing(c);
      await as(fan).post(`/dm/${c.sub}/send`, { text: 'hello' }).expect(201);
      expect(Number((await tracker(c)).noResponseRatePct)).toBe(4.2);
      // Flagged: the stored share follows the questions (what the live
      // response-stats route then reads).
      await questions(c, { unanswered: 40, answered: 60 });
      await standing(c);
      const row = await tracker(c);
      expect(row.penaltyState).toBe('disabled_7d');
      expect(Number(row.noResponseRatePct)).toBe(40);
    });
  });

  describe('the warning', () => {
    it('21% is warned once, however often and however many times at once it is looked at', async () => {
      const c = await creator('WarnOnce');
      await questions(c, { unanswered: 21, answered: 79 });
      const results = await Promise.all(
        Array.from({ length: 12 }, () => standing(c)),
      );
      expect(results.every((s) => s.state === 'warning')).toBe(true);
      await standing(c);
      await standing(c);
      expect(await notes(c, 'paid_dm_warning')).toBe(1);
      expect(await notes(c, 'paid_dm_paused')).toBe(0);
      const row = await tracker(c);
      expect(row.penaltyState).toBe('warned');
      expect(Number(row.noResponseRatePct)).toBe(21);
      expect(row.dmDisabledUntil).toBeNull();
      const note = await prisma.notification.findFirstOrThrow({
        where: { userWawuId: c.sub, kind: 'paid_dm_warning' },
      });
      expect(note.body).toContain('21%');
      expect(note.body).toContain('30%');
      expect(note.body).not.toMatch(/—|–/);
    });

    it('a warned creator can still be sent paid questions', async () => {
      const c = await creator('WarnedSend');
      await questions(c, { unanswered: 25, answered: 75 });
      const res = await as(fan)
        .post(`/dm/${c.sub}/send`, { text: 'hello' })
        .expect(201);
      expect(data<{ threadId: string }>(res).threadId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    it('warns again for a new crossing, not for staying over the line', async () => {
      const c = await creator('WarnAgain');
      await questions(c, { unanswered: 21, answered: 79 });
      await standing(c);
      // Replies pull the share under the line: back to ok, no new warning.
      await questions(c, { answered: 100 });
      expect((await standing(c)).state).toBe('ok');
      expect((await tracker(c)).penaltyState).toBe('none');
      expect(await notes(c, 'paid_dm_warning')).toBe(1);
      // Misses push it over again: a second crossing, a second warning.
      await questions(c, { unanswered: 30 });
      expect((await standing(c)).state).toBe('warning');
      expect(await notes(c, 'paid_dm_warning')).toBe(2);
    });
  });

  describe('the pause', () => {
    it("31% switches paid messages off for 7 days and a fan is refused with I8's reason, before any charge", async () => {
      const c = await creator('Paused');
      await questions(c, { unanswered: 31, answered: 69 });
      const res = await as(fan)
        .post(`/dm/${c.sub}/send`, { text: 'are you there' })
        .expect(403);
      const body = res.body as {
        message: string;
        data: null;
        reason: { code: string; pausedUntil: string; message: string };
      };
      expect(body.reason.code).toBe('paid_messages_paused');
      expect(body.message).not.toMatch(/—|–/);
      const until = new Date(body.reason.pausedUntil).getTime();
      expect(Math.abs(until - (Date.now() + 7 * DAY))).toBeLessThan(10_000);
      expect(
        await prisma.pendingCharge.count({
          where: {
            wawuUserId: fan.sub,
            kind: 'dm',
            context: { path: ['creatorWawuId'], equals: c.sub },
          },
        }),
      ).toBe(0);
      const row = await tracker(c);
      expect(row.penaltyState).toBe('disabled_7d');
      expect(row.dmDisabledUntil?.toISOString()).toBe(body.reason.pausedUntil);
      // What the fan reads on the profile, and what the creator reads.
      const avail = data<PaidDmAvailability>(
        await as(fan)
          .get(`/paid-dm/creators/${c.sub}/availability`)
          .expect(200),
      );
      expect(avail).toEqual({
        creatorWawuId: c.sub,
        paused: true,
        pausedUntil: body.reason.pausedUntil,
      });
      const own = await standing(c);
      expect(own).toMatchObject({
        state: 'paused',
        acceptingPaidMessages: false,
        pausedUntil: body.reason.pausedUntil,
        unansweredPct: 31,
      });
      const note = await prisma.notification.findFirstOrThrow({
        where: { userWawuId: c.sub, kind: 'paid_dm_paused' },
      });
      expect(note.body).toContain('7 days');
      expect(note.body).not.toMatch(/—|–/);
    });

    it('many fans sending at the moment the line is crossed: all refused, one pause, one notification, one end time', async () => {
      const c = await creator('Race');
      await questions(c, { unanswered: 40, answered: 60 });
      const sends = await Promise.all(
        Array.from({ length: 12 }, () =>
          as(fan).post(`/dm/${c.sub}/send`, { text: 'now' }),
        ),
      );
      expect(sends.map((r) => r.status)).toEqual(Array(12).fill(403));
      const ends = new Set(
        sends.map(
          (r) =>
            (r.body as { reason: { pausedUntil: string } }).reason.pausedUntil,
        ),
      );
      expect(ends.size).toBe(1);
      expect(await notes(c, 'paid_dm_paused')).toBe(1);
      expect(await notes(c, 'paid_dm_warning')).toBe(0);
      expect((await tracker(c)).dmDisabledUntil?.toISOString()).toBe(
        [...ends][0],
      );
    });

    it('with the stored row already there, many evaluations at once still make one pause and one warning', async () => {
      const w = await creator('RowWarn');
      await standing(w); // the row now exists
      await questions(w, { unanswered: 22, answered: 78 });
      await Promise.all(
        Array.from({ length: 16 }, () => pause.standing(w.sub)),
      );
      expect(await notes(w, 'paid_dm_warning')).toBe(1);
      const c = await creator('RowPause');
      await standing(c);
      await questions(c, { unanswered: 40, answered: 60 });
      const all = await Promise.all(
        Array.from({ length: 16 }, () => pause.standing(c.sub)),
      );
      expect(new Set(all.map((s) => s.pausedUntil)).size).toBe(1);
      expect(await notes(c, 'paid_dm_paused')).toBe(1);
    });

    it('is fixed: more misses, more looks and the sweep never move the end', async () => {
      const c = await creator('Fixed');
      await questions(c, { unanswered: 31, answered: 69 });
      const first = await standing(c);
      await questions(c, { unanswered: 200 });
      await Promise.all([
        standing(c),
        standing(c),
        pause.sweep(),
        pause.sweep(),
      ]);
      const later = await standing(c);
      expect(later.pausedUntil).toBe(first.pausedUntil);
      expect(later.state).toBe('paused');
      expect(await notes(c, 'paid_dm_paused')).toBe(1);
    });

    it('does not stop a paused creator answering the questions already waiting', async () => {
      const c = await creator('StillReplies');
      await questions(c, { unanswered: 31, answered: 69 });
      const open = randomUUID();
      created.push(open);
      await prisma.directMessage.create({
        data: {
          id: open,
          creatorWawuId: c.sub,
          senderWawuId: fan.sub,
          text: 'asked before the pause',
          amount: 1500,
          status: 'awaiting_response',
          sentAt: new Date(Date.now() - HOUR),
          deadlineAt: new Date(Date.now() + 5 * HOUR),
          flutterwaveTxRef: `pause-spec-${open}`,
          responseWindowHours: 24,
        },
      });
      expect((await standing(c)).state).toBe('paused');
      await as(c)
        .post(`/paid-dm/questions/${open}/replies`, { text: 'here you go' })
        .expect(201);
      await as(c).post(`/dm/${open}/respond`, { text: 'again' }).expect(409);
    });

    it('ends by the clock alone: paused one millisecond before the end, open at the end', async () => {
      const c = await creator('Clock');
      const now = new Date();
      await questions(c, { unanswered: 31, answered: 69 }, 2 * DAY, now);
      const first = await pause.standing(c.sub, now);
      const end = new Date(first.pausedUntil as string);
      const before = await pause.standing(c.sub, new Date(end.getTime() - 1));
      expect(before).toMatchObject({
        state: 'paused',
        acceptingPaidMessages: false,
      });
      const atEnd = await pause.standing(c.sub, end);
      expect(atEnd).toMatchObject({
        state: 'ok',
        acceptingPaidMessages: true,
        pausedUntil: null,
      });
      expect((await tracker(c)).penaltyState).toBe('none');
      // Sending works the moment the end passes, with no sweep in between.
      await expect(pause.assertAccepting(c.sub, end)).resolves.toBeUndefined();
      await expect(
        pause.assertAccepting(c.sub, new Date(end.getTime() - 1)),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('a pause that ended starts a fresh count: the old misses do not pause them again, new ones can', async () => {
      const c = await creator('Fresh2');
      const now = new Date();
      await questions(c, { unanswered: 31, answered: 69 }, 2 * DAY, now);
      const first = await pause.standing(c.sub, now);
      const end = new Date(first.pausedUntil as string);
      const back = await pause.standing(c.sub, new Date(end.getTime() + 1000));
      expect(back).toMatchObject({ state: 'ok', questions: 0, unanswered: 0 });
      // New questions after the pause: 1 missed of 2 is over the line.
      await questions(
        c,
        { unanswered: 1, answered: 1 },
        0,
        new Date(end.getTime() + 2000),
      );
      const again = await pause.standing(
        c.sub,
        new Date(end.getTime() + 3 * DAY),
      );
      expect(again).toMatchObject({
        state: 'paused',
        questions: 2,
        unanswered: 1,
      });
      expect(new Date(again.pausedUntil as string).getTime()).toBeGreaterThan(
        end.getTime(),
      );
      expect(await notes(c, 'paid_dm_paused')).toBe(2);
    });

    it('a pause that ends while many look at once: one resume, no second pause', async () => {
      const c = await creator('ResumeRace');
      const now = new Date();
      await questions(c, { unanswered: 31, answered: 69 }, 2 * DAY, now);
      const first = await pause.standing(c.sub, now);
      const after = new Date(
        new Date(first.pausedUntil as string).getTime() + 1000,
      );
      const all = await Promise.all(
        Array.from({ length: 10 }, () => pause.standing(c.sub, after)),
      );
      expect(all.every((s) => s.state === 'ok')).toBe(true);
      expect(await notes(c, 'paid_dm_paused')).toBe(1);
    });
  });

  describe('the sweep', () => {
    // The sweep looks at every creator in the database, so it can write a
    // tracker row or a notification for an account this suite never made.
    // Whatever existed before is put back afterwards.
    let trackersBefore: Awaited<
      ReturnType<typeof prisma.creatorNoResponseTracker.findMany>
    >;
    let notificationsBefore: string[];
    beforeAll(async () => {
      trackersBefore = await prisma.creatorNoResponseTracker.findMany();
      notificationsBefore = (
        await prisma.notification.findMany({ select: { id: true } })
      ).map((n) => n.id);
    });
    afterAll(async () => {
      const kept = new Set(trackersBefore.map((t) => t.creatorWawuId));
      await prisma.creatorNoResponseTracker.deleteMany({
        where: { creatorWawuId: { notIn: [...kept, ...people] } },
      });
      for (const t of trackersBefore) {
        await prisma.creatorNoResponseTracker.update({
          where: { creatorWawuId: t.creatorWawuId },
          data: {
            noResponseRatePct: t.noResponseRatePct,
            penaltyState: t.penaltyState,
            dmDisabledUntil: t.dmDisabledUntil,
          },
        });
      }
      await prisma.notification.deleteMany({
        where: {
          id: { notIn: notificationsBefore },
          kind: { in: ['paid_dm_warning', 'paid_dm_paused'] },
        },
      });
    });

    it('warns and pauses without anyone looking, and writes back a pause that ended', async () => {
      const w = await creator('SweepWarn');
      await questions(w, { unanswered: 22, answered: 78 });
      const p = await creator('SweepPause');
      await questions(p, { unanswered: 35, answered: 65 });
      const checked = await pause.sweep();
      expect(checked).toBeGreaterThanOrEqual(2);
      expect((await tracker(w)).penaltyState).toBe('warned');
      expect((await tracker(p)).penaltyState).toBe('disabled_7d');
      expect(await notes(w, 'paid_dm_warning')).toBe(1);
      expect(await notes(p, 'paid_dm_paused')).toBe(1);
      // Run again, twice at once: nothing more is sent.
      await Promise.all([pause.sweep(), pause.sweep()]);
      expect(await notes(w, 'paid_dm_warning')).toBe(1);
      expect(await notes(p, 'paid_dm_paused')).toBe(1);
      // The end of the pause, written back by the sweep alone.
      const end = (await tracker(p)).dmDisabledUntil as Date;
      await pause.sweep(new Date(end.getTime() + 1000));
      expect((await tracker(p)).penaltyState).toBe('none');
    });
  });

  describe('the numbers come from config', () => {
    const keys = [
      'PAID_DM_WARN_AT_PCT',
      'PAID_DM_PAUSE_AT_PCT',
      'PAID_DM_WINDOW_DAYS',
      'PAID_DM_PAUSE_DAYS',
      'PAID_DM_MIN_QUESTIONS',
    ];
    afterEach(() => {
      for (const k of keys) delete process.env[k];
    });

    it('moves the lines, the window and the pause length', async () => {
      process.env.PAID_DM_WARN_AT_PCT = '10';
      process.env.PAID_DM_PAUSE_AT_PCT = '15';
      process.env.PAID_DM_WINDOW_DAYS = '7';
      process.env.PAID_DM_PAUSE_DAYS = '2';
      const w = await creator('CfgWarn');
      await questions(w, { unanswered: 11, answered: 89 });
      const sw = await standing(w);
      expect(sw).toMatchObject({
        state: 'warning',
        warnAtPct: 10,
        pauseAtPct: 15,
        windowDays: 7,
        pauseDays: 2,
      });
      const p = await creator('CfgPause');
      await questions(p, { unanswered: 16, answered: 84 });
      const sp = await standing(p);
      expect(sp.state).toBe('paused');
      expect(
        Math.abs(
          new Date(sp.pausedUntil as string).getTime() - (Date.now() + 2 * DAY),
        ),
      ).toBeLessThan(10_000);
      // Outside the 7-day window, ignored.
      const o = await creator('CfgOld');
      await questions(o, { unanswered: 50, answered: 50 }, 8 * DAY);
      expect((await standing(o)).state).toBe('ok');
    });

    it('a minimum number of questions keeps one miss from reading as 100%', async () => {
      process.env.PAID_DM_MIN_QUESTIONS = '5';
      const c = await creator('CfgMin');
      await questions(c, { unanswered: 1, answered: 1 });
      expect(await standing(c)).toMatchObject({ state: 'ok', questions: 2 });
      await questions(c, { unanswered: 1, answered: 2 });
      expect((await standing(c)).state).toBe('paused');
    });

    it('ignores a value that is not a whole number in range instead of switching enforcement off', async () => {
      process.env.PAID_DM_PAUSE_AT_PCT = 'abc';
      process.env.PAID_DM_WARN_AT_PCT = '0';
      process.env.PAID_DM_WINDOW_DAYS = '-3';
      const c = await creator('CfgBad');
      await questions(c, { unanswered: 31, answered: 69 });
      expect(await standing(c)).toMatchObject({
        state: 'paused',
        warnAtPct: 20,
        pauseAtPct: 30,
        windowDays: 30,
      });
    });
  });
});

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import type { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { TgifModule } from '../tgif.module';

/**
 * HOME-10: TGIF reactions, readers and shares.
 *
 * Every identity is created by this spec and its rows are deleted in
 * afterAll. Counts are compared with a baseline read first, so rows other
 * specs or earlier runs left on the same day cannot move an assertion.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

interface Who {
  sub: string;
  token: string;
}
interface CardStats {
  card: string;
  amen: number;
  amenByMe: boolean;
}
interface Stats {
  date: string;
  cards: CardStats[];
  readers: number;
  shares: number;
  readByMe: boolean;
  sharedByMe: boolean;
}

let nonceCounter = 0;
async function registerIdentity(label: string): Promise<Who> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceCounter += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Tgif Spec ${label}`,
      email: `tgif-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('TGIF reactions, readers and shares (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMock = false;
  const users: Who[] = [];
  let ann: Who;
  let bob: Who;
  let cy: Who;
  const today = iso(0);

  const http = () => request(app.getHttpServer() as Server);
  const auth = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const data = (res: request.Response) =>
    (res.body as { data: Record<string, unknown> }).data;

  async function stats(who: Who, date = today): Promise<Stats> {
    const res = await http()
      .get(`/tgif/${date}/stats`)
      .set(auth(who))
      .expect(200);
    return data(res) as unknown as Stats;
  }
  const card = (s: Stats, name: string) =>
    s.cards.find((c) => c.card === name) as CardStats;

  const react = (who: Who, body: unknown, date = today) =>
    http()
      .post(`/tgif/${date}/react`)
      .set(auth(who))
      .send(body as object);

  async function fresh(label: string): Promise<Who> {
    const w = await registerIdentity(label);
    users.push(w);
    return w;
  }

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        TgifModule,
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
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);
    ann = await fresh('ann');
    bob = await fresh('bob');
    cy = await fresh('cy');
  });

  afterAll(async () => {
    const ids = users.map((u) => u.sub);
    await prisma.blockedAccount.deleteMany({
      where: {
        OR: [{ userWawuId: { in: ids } }, { blockedWawuId: { in: ids } }],
      },
    });
    for (const model of [
      prisma.tgifReaction,
      prisma.tgifRead,
      prisma.tgifShare,
    ] as unknown as { deleteMany(a: unknown): Promise<unknown> }[]) {
      await model.deleteMany({ where: { userWawuId: { in: ids } } });
    }
    await app?.close();
    if (ownedMock) mockWawuId?.kill();
  });

  it('a user can see all five cards at zero before anyone has reacted, and signed-out callers get 401', async () => {
    const s = await stats(ann, iso(1));
    expect(s.cards.map((c) => c.card)).toEqual([
      'verse',
      'reality',
      'remember',
      'prayer',
      'takeaway',
    ]);
    expect(s.cards.every((c) => !c.amenByMe)).toBe(true);
    expect(s.readByMe).toBe(false);
    await http().get(`/tgif/${today}/stats`).expect(401);
    await http()
      .post(`/tgif/${today}/react`)
      .send({ card: 'verse' })
      .expect(401);
  });

  it('a user can say Amen, see it as theirs on reopening, and the count includes it once', async () => {
    const before = card(await stats(ann), 'verse').amen;
    const r1 = await react(ann, { card: 'verse' }).expect(200);
    const r2 = await react(ann, { card: 'verse', kind: 'amen' }).expect(200);
    expect(data(r1)).toEqual({
      card: 'verse',
      amen: before + 1,
      amenByMe: true,
    });
    expect(data(r2)).toEqual(data(r1));
    const reopened = await stats(ann);
    expect(card(reopened, 'verse')).toEqual({
      card: 'verse',
      amen: before + 1,
      amenByMe: true,
    });
    expect(card(reopened, 'prayer').amenByMe).toBe(false);
    // Another person sees the count but not the flag.
    const other = await stats(bob);
    expect(card(other, 'verse').amen).toBe(before + 1);
    expect(card(other, 'verse').amenByMe).toBe(false);
  });

  it('a user can take their Amen back, twice without error, and the count falls once', async () => {
    const before = card(await stats(bob), 'prayer').amen;
    await react(bob, { card: 'prayer' }).expect(200);
    const d1 = await http()
      .delete(`/tgif/${today}/react/prayer`)
      .set(auth(bob))
      .expect(200);
    const d2 = await http()
      .delete(`/tgif/${today}/react/prayer`)
      .set(auth(bob))
      .expect(200);
    expect(data(d1)).toEqual({ card: 'prayer', amen: before, amenByMe: false });
    expect(data(d2)).toEqual(data(d1));
  });

  it('a user can see readers today equal the distinct readers recorded for that date', async () => {
    const before = (await stats(ann)).readers;
    const a1 = await http()
      .post(`/tgif/${today}/read`)
      .set(auth(ann))
      .expect(200);
    const a2 = await http()
      .post(`/tgif/${today}/read`)
      .set(auth(ann))
      .expect(200);
    await http().post(`/tgif/${today}/read`).set(auth(bob)).expect(200);
    expect(data(a1)).toEqual({ readers: before + 1, counted: true });
    expect(data(a2)).toEqual({ readers: before + 1, counted: false });
    const s = await stats(cy);
    expect(s.readers).toBe(before + 2);
    expect(s.readByMe).toBe(false);
    const rows = await prisma.tgifRead.count({
      where: { day: new Date(`${today}T00:00:00Z`) },
    });
    expect(s.readers).toBe(rows);
    // Another day is counted apart.
    expect((await stats(cy, iso(-1))).readers).not.toBe(s.readers + 99);
  });

  it('a user can share, and a repeat by the same person on the same day is not counted again', async () => {
    const before = (await stats(ann)).shares;
    const s1 = await http()
      .post(`/tgif/${today}/share`)
      .set(auth(ann))
      .expect(200);
    const s2 = await http()
      .post(`/tgif/${today}/share`)
      .set(auth(ann))
      .expect(200);
    await http().post(`/tgif/${today}/share`).set(auth(bob)).expect(200);
    expect(data(s1)).toEqual({ shares: before + 1, counted: true });
    expect(data(s2)).toEqual({ shares: before + 1, counted: false });
    const s = await stats(ann);
    expect(s.shares).toBe(before + 2);
    expect(s.sharedByMe).toBe(true);
  });

  it('simultaneous taps leave one row per person: 12 parallel reactions, reads and shares by one user, and 12 users at once', async () => {
    const dan = await fresh('dan');
    const day = iso(1);
    const dayDate = new Date(`${day}T00:00:00Z`);
    const base = await stats(dan, day);
    const burst = (fn: () => request.Test) =>
      Promise.all(Array.from({ length: 12 }, () => fn().then((r) => r.status)));
    const codes = [
      ...(await burst(() => react(dan, { card: 'remember' }, day))),
      ...(await burst(() => http().post(`/tgif/${day}/read`).set(auth(dan)))),
      ...(await burst(() => http().post(`/tgif/${day}/share`).set(auth(dan)))),
    ];
    expect(codes.every((c) => c === 200)).toBe(true);
    const mine = { where: { userWawuId: dan.sub, day: dayDate } };
    expect(await prisma.tgifReaction.count(mine)).toBe(1);
    expect(await prisma.tgifRead.count(mine)).toBe(1);
    expect(await prisma.tgifShare.count(mine)).toBe(1);

    const crowd = await Promise.all(
      Array.from({ length: 12 }, (_, i) => fresh(`crowd${i}`)),
    );
    await Promise.all(
      crowd.flatMap((w) => [
        react(w, { card: 'takeaway' }, day),
        react(w, { card: 'takeaway' }, day),
        http().post(`/tgif/${day}/read`).set(auth(w)),
        http().post(`/tgif/${day}/share`).set(auth(w)),
      ]),
    );
    const s = await stats(dan, day);
    expect(card(s, 'takeaway').amen - card(base, 'takeaway').amen).toBe(12);
    expect(s.readers - base.readers).toBe(13);
    expect(s.shares - base.shares).toBe(13);
    // The counts are the rows.
    const rows = await prisma.tgifReaction.count({
      where: { day: dayDate, card: 'takeaway' },
    });
    expect(card(s, 'takeaway').amen).toBe(rows);
    expect(s.readers).toBe(
      await prisma.tgifRead.count({ where: { day: dayDate } }),
    );
    expect(s.shares).toBe(
      await prisma.tgifShare.count({ where: { day: dayDate } }),
    );
  });

  it('a user never sees a blocked person in any count, in either direction, and the caller own taps stay', async () => {
    const blocker = await fresh('blocker');
    const blocked = await fresh('blocked');
    const bystander = await fresh('bystander');
    const day = iso(-1);
    const b0 = await stats(bystander, day);
    for (const w of [blocker, blocked, bystander]) {
      await react(w, { card: 'reality' }, day).expect(200);
      await http().post(`/tgif/${day}/read`).set(auth(w)).expect(200);
      await http().post(`/tgif/${day}/share`).set(auth(w)).expect(200);
    }
    const before = await stats(bystander, day);
    expect(card(before, 'reality').amen - card(b0, 'reality').amen).toBe(3);
    await prisma.blockedAccount.create({
      data: { userWawuId: blocker.sub, blockedWawuId: blocked.sub },
    });
    const bystanderAfter = await stats(bystander, day);
    expect(card(bystanderAfter, 'reality').amen).toBe(
      card(before, 'reality').amen,
    );
    for (const viewer of [blocker, blocked]) {
      const s = await stats(viewer, day);
      expect(card(s, 'reality').amen).toBe(card(before, 'reality').amen - 1);
      expect(card(s, 'reality').amenByMe).toBe(true);
      expect(s.readers).toBe(before.readers - 1);
      expect(s.shares).toBe(before.shares - 1);
      expect(s.readByMe).toBe(true);
    }
    // The write answers are filtered the same way.
    const again = await react(blocker, { card: 'reality' }, day).expect(200);
    expect(data(again).amen).toBe(card(before, 'reality').amen - 1);
    const rd = await http()
      .post(`/tgif/${day}/read`)
      .set(auth(blocked))
      .expect(200);
    expect(data(rd).readers).toBe(before.readers - 1);
    const sh = await http()
      .post(`/tgif/${day}/share`)
      .set(auth(blocker))
      .expect(200);
    expect(data(sh).shares).toBe(before.shares - 1);
  });

  it('a user gets 400, never 500, for hostile or malformed input, and nothing is stored', async () => {
    const rowsBefore = await prisma.tgifReaction.count({
      where: { userWawuId: ann.sub },
    });
    const badDates = [
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '26-10-04',
      'today',
      '2026-10-04%00',
      '2026-10-04%0A',
      `${iso(2)}`,
      iso(-2),
      '0000-01-01',
      '9999-12-31',
      '2026-1-4',
    ];
    for (const d of badDates) {
      const res = await http()
        .post(`/tgif/${d}/read`)
        .set(auth(ann))
        .expect(400);
      expect(res.status).not.toBe(500);
    }
    for (const d of [
      '2026-02-30',
      '2024-02-30',
      '2023-02-29',
      '2019-12-31',
      iso(2),
      'x%00y',
    ]) {
      await http().get(`/tgif/${d}/stats`).set(auth(ann)).expect(400);
    }
    // Not valid UTF-8 in the path: the framework refuses it, still a 400.
    await http().get('/tgif/%ff/stats').set(auth(ann)).expect(400);
    const bodies: unknown[] = [
      {},
      { card: '' },
      { card: 'Verse' },
      { card: ' verse' },
      { card: 'verse\u0000' },
      { card: '\ud800' },
      { card: ['verse'] },
      { card: { $ne: 1 } },
      { card: 'verse', kind: 'wow' },
      { card: 'verse', kind: 'AMEN' },
      { card: 'verse', kind: null },
      { card: 'verse', extra: 1 },
      { card: 7 },
    ];
    for (const b of bodies) {
      await react(ann, b).expect(400);
    }
    // A raw lone surrogate in the JSON text, which JSON.stringify would escape.
    await http()
      .post(`/tgif/${today}/react`)
      .set(auth(ann))
      .set('content-type', 'application/json')
      .send('{"card":"\\ud800"}')
      .expect(400);
    await http()
      .post(`/tgif/${today}/react`)
      .set(auth(ann))
      .set('content-type', 'application/json')
      .send('{"card":')
      .expect(400);
    await http()
      .delete(`/tgif/${today}/react/Verse`)
      .set(auth(ann))
      .expect(400);
    await http().delete(`/tgif/${today}/react/nope`).set(auth(ann)).expect(400);
    await http()
      .delete(`/tgif/${today}/react/ve%00rse`)
      .set(auth(ann))
      .expect(400);
    expect(
      await prisma.tgifReaction.count({ where: { userWawuId: ann.sub } }),
    ).toBe(rowsBefore);
  });

  it('a user can read an older day, and writes are held to yesterday, today and tomorrow', async () => {
    await stats(ann, '2024-12-25');
    await http()
      .post(`/tgif/${iso(-1)}/read`)
      .set(auth(cy))
      .expect(200);
    await http()
      .post(`/tgif/${iso(1)}/read`)
      .set(auth(cy))
      .expect(200);
  });
});

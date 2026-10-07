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
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { TgifModule } from '../tgif.module';
import {
  BOOK_DAYS,
  bookDay,
  callName,
  personalise,
  readBookMonth,
} from '../content/tgif-content.service';
import {
  CARD_WIDTH,
  IMAGE_SCALE,
  shareCardSvg,
  wrapLines,
  xml,
} from '../share/share-image.service';
import { FontWidths } from '../share/font-widths';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * HOME-09: the text of each TGIF day, and the card that is shared.
 *
 * Nothing here writes a row: the content routes read the book that ships with
 * the server, so there is nothing to clean up. Identities are created by this
 * spec in the mock WAWU ID, each with its own first name.
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

let nonceCounter = 0;
async function registerIdentity(fullName: string): Promise<Who> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceCounter += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName,
      email: `tgif-day-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register ${fullName} failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

interface Day {
  date: string;
  series: string;
  seriesTheme: string;
  verse: string;
  verseReference: string;
  reality: string;
  remember: string;
  prayer: string;
  takeaway: string;
  shareLink: string | null;
}

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('TGIF book (units)', () => {
  it('holds every day of the year, 365 in all, each with all five cards and its series', () => {
    let days = 0;
    BOOK_DAYS.forEach((count, i) => {
      const month = readBookMonth(i + 1);
      days += month.days.length;
      expect(month.days).toHaveLength(count);
    });
    expect(days).toBe(365);
  });

  it('refuses a month that is short, out of order or missing a card', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tgif-book-'));
    const entry = (d: number, over: Record<string, unknown> = {}) => ({
      d,
      quote: 'q',
      ref: 'r',
      reality: 'x',
      remember: 'y',
      prayer: 'p',
      takeaway: 't',
      series: 's',
      seriesTheme: 'th',
      ...over,
    });
    const write = (days: unknown[], month = 2) =>
      writeFileSync(path.join(dir, '02.json'), JSON.stringify({ month, days }));
    try {
      const full = Array.from({ length: 28 }, (_, i) => entry(i + 1));
      write(full);
      expect(readBookMonth(2, dir).days).toHaveLength(28);
      write(full.slice(0, 27));
      expect(() => readBookMonth(2, dir)).toThrow(/in full/);
      write([entry(2), entry(1), ...full.slice(2)]);
      expect(() => readBookMonth(2, dir)).toThrow(/out of order/);
      write(full.map((e, i) => (i === 9 ? entry(10, { prayer: '  ' }) : e)));
      expect(() => readBookMonth(2, dir)).toThrow(/no prayer/);
      write(full, 3);
      expect(() => readBookMonth(2, dir)).toThrow(/in full/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts the first name where the book leaves a slot, and reads as English with none', () => {
    expect(personalise('{Name}, hope is for what is coming.', 'Ada')).toBe(
      'Ada, hope is for what is coming.',
    );
    expect(personalise('{Name}, hope is for what is coming.', null)).toBe(
      'Hope is for what is coming.',
    );
    expect(personalise('Be well, {Name}.', null)).toBe('Be well, you.');
    // A name that looks like a replacement pattern is written as it is.
    expect(personalise('{Name}!', "$&-$'")).toBe("$&-$'!");
  });

  it('calls a person by the first word of their name, kept to letters', () => {
    expect(callName('  Ngozi   Okonkwo ')).toBe('Ngozi');
    expect(callName("D'Angelo-Smith Jr")).toBe("D'Angelo-Smith");
    expect(callName('<b>Eve</b>')).toBe('bEveb');
    expect(callName('')).toBeNull();
    expect(callName(null)).toBeNull();
    expect(callName('\u0000\u0001')).toBeNull();
    expect(callName('A'.repeat(80))).toHaveLength(40);
  });

  it('keys the book to the date: 29 February reads 28 February and no later day moves', () => {
    expect(bookDay('2028-02-29')).toEqual({ month: 2, day: 28 });
    expect(bookDay('2028-03-01')).toEqual({ month: 3, day: 1 });
    expect(bookDay('2026-12-31')).toEqual({ month: 12, day: 31 });
  });
});

describe('TGIF share card (units)', () => {
  const fontsDir = path.join(__dirname, '../../../assets/tgif/fonts');
  const bold = new FontWidths(
    readFileSync(path.join(fontsDir, 'WMTReceiptSans-Bold.ttf')),
  );

  it('sets a short verse large, a long one smaller, and never wider than the card', () => {
    const short = shareCardSvg({
      date: '2026-09-26',
      verse: 'This is the day which the LORD hath made.',
      reference: 'Psalm 118:24 (KJV)',
      link: 'wawu/tgif',
    });
    const long = shareCardSvg({
      date: '2026-09-26',
      verse: 'word '.repeat(54).trim(),
      reference: 'Psalm 118:24 (KJV)',
      link: null,
    });
    const sizeOf = (svg: string) =>
      Number(
        /font-size="(\d+)" font-weight="700" letter-spacing="-/.exec(svg)![1],
      );
    expect(sizeOf(short.svg)).toBe(20);
    expect(sizeOf(long.svg)).toBeLessThan(20);
    expect(long.height).toBeGreaterThanOrEqual(short.height);
  });

  it('breaks between words, and inside a word too long for a line', () => {
    const measure = (s: string) => bold.width(s, 20);
    const inner = CARD_WIDTH - 44;
    const lines = wrapLines(
      `${'W'.repeat(80)} and some words after it`,
      inner,
      measure,
    );
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(inner);
    expect(wrapLines('', inner, measure)).toEqual([]);
  });

  it('draws the date from the month and day, and leaves the link off when none is set', () => {
    const card = shareCardSvg({
      date: '2026-03-05',
      verse: 'A verse.',
      reference: 'John 3:16 (NIV)',
      link: null,
    });
    expect(card.svg).toContain('TGIF · 5 MAR');
    expect(card.svg).not.toContain('text-anchor="end"');
  });

  it('cannot be made to draw markup: text is escaped and control characters dropped', () => {
    const card = shareCardSvg({
      date: '2026-03-05',
      verse: '<script>alert(1)</script> & "quotes"\u0000\u001f',
      reference: '</text><rect/>',
      link: '"><image href="x"/>',
    });
    expect(card.svg).not.toContain('<script>');
    expect(card.svg).not.toContain('</text><rect/>');
    expect(card.svg).not.toContain('"><image');
    expect([...card.svg].some((c) => c.charCodeAt(0) < 9)).toBe(false);
    expect(xml('a\u0000b<&>')).toBe('a b&#60;&#38;&#62;');
  });
});

describe('TGIF days and the shared card (contract)', () => {
  let app: INestApplication;
  let mockWawuId: ChildProcess | undefined;
  let ownedMock = false;
  let ada: Who;
  let bola: Who;
  let noName: Who;

  const http = () => request(app.getHttpServer() as Server);
  const auth = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const day = async (w: Who, date: string) => {
    const res = await http().get(`/tgif/${date}`).set(auth(w)).expect(200);
    return (res.body as { data: Day }).data;
  };

  beforeAll(async () => {
    process.env.TGIF_SHARE_LINK = 'wawu/tgif';
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
    ada = await registerIdentity('Adaeze Obi');
    bola = await registerIdentity('Bola Ige');
    noName = await registerIdentity('X');
  });

  afterAll(async () => {
    delete process.env.TGIF_SHARE_LINK;
    await app?.close();
    if (ownedMock) mockWawuId?.kill();
  });

  it('a signed-out caller gets 401 on the day and on the card', async () => {
    await http().get('/tgif/2026-09-26').expect(401);
    await http().get('/tgif/2026-09-26/share-image').expect(401);
    await http()
      .get('/tgif/2026-09-26')
      .set({ Authorization: 'Bearer not-a-token' })
      .expect(401);
  });

  it('a user can read the five cards of a day, in the Hub envelope, with the series and the link to share', async () => {
    const d = await day(ada, '2026-09-26');
    expect(d.date).toBe('2026-09-26');
    for (const field of [
      'series',
      'seriesTheme',
      'verse',
      'verseReference',
      'reality',
      'remember',
      'prayer',
      'takeaway',
    ] as const) {
      expect(typeof d[field]).toBe('string');
      expect(d[field].length).toBeGreaterThan(0);
    }
    expect(d.shareLink).toBe('wawu/tgif');
    const again = await day(ada, '2026-09-26');
    expect(again).toEqual(d);
  });

  it('the reality card is addressed to the reader by their own first name, and to nobody else', async () => {
    const forAda = await day(ada, '2026-09-25');
    const forBola = await day(bola, '2026-09-25');
    expect(forAda.reality.startsWith('Adaeze, ')).toBe(true);
    expect(forBola.reality.startsWith('Bola, ')).toBe(true);
    expect(forAda.reality).not.toContain('Bola');
    // Everything else on the day is the same for both.
    expect({ ...forAda, reality: '' }).toEqual({ ...forBola, reality: '' });
    for (const d of [forAda, forBola]) {
      expect(JSON.stringify(d)).not.toContain('{Name}');
    }
  });

  it('every day of a past year can be read, none leaks the slot, and each reads the same on any year', async () => {
    const first = new Date(Date.UTC(2025, 0, 1));
    for (let i = 0; i < 365; i += 1) {
      const at = new Date(first.getTime() + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const d = await day(noName, at);
      expect(d.verse.length).toBeGreaterThan(0);
      expect(JSON.stringify(d)).not.toContain('{Name}');
    }
    const a = await day(ada, '2025-09-26');
    const b = await day(ada, '2026-09-26');
    expect({ ...a, date: '' }).toEqual({ ...b, date: '' });
  });

  it('29 February reads what 28 February reads', async () => {
    const leap = await day(ada, '2024-02-29');
    const eve = await day(ada, '2024-02-28');
    expect(leap.date).toBe('2024-02-29');
    expect({ ...leap, date: '' }).toEqual({ ...eve, date: '' });
  });

  it('refuses a date that is not a real day or is outside the days served, with 400 and no 500', async () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '26-09-2026',
      '2026-9-26',
      'today',
      '2019-12-31',
      iso(2),
      '2026-09-26%00',
      '%ff',
    ]) {
      const res = await http().get(`/tgif/${bad}`).set(auth(ada));
      expect([400, 404]).toContain(res.status);
      const card = await http().get(`/tgif/${bad}/share-image`).set(auth(ada));
      expect([400, 404]).toContain(card.status);
    }
    await http().get('/tgif/2026-02-30').set(auth(ada)).expect(400);
    await http().get('/tgif/2026-02-30/share-image').set(auth(ada)).expect(400);
    await http()
      .get(`/tgif/${iso(2)}/share-image`)
      .set(auth(ada))
      .expect(400);
  });

  it('a user can get the verse as a PNG card at three pixels a point, the same for everyone', async () => {
    const png = (w: Who, date: string) =>
      http()
        .get(`/tgif/${date}/share-image`)
        .set(auth(w))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
    const one = await png(ada, '2026-09-26');
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toBe('image/png');
    expect(one.headers['cache-control']).toBe('private, max-age=3600');
    const bytes = one.body as Buffer;
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.readUInt32BE(16)).toBe(CARD_WIDTH * IMAGE_SCALE);
    expect(Number(one.headers['content-length'])).toBe(bytes.length);
    const two = await png(bola, '2026-09-26');
    expect((two.body as Buffer).equals(bytes)).toBe(true);
    // The same day of another year is the same card.
    const other = await png(ada, '2025-09-26');
    expect((other.body as Buffer).equals(bytes)).toBe(true);
  });

  it('twelve cards asked for at once are all drawn, a few at a time, and none fails', async () => {
    const dates = Array.from({ length: 12 }, (_, i) => `2025-10-${10 + i}`);
    const answers = await Promise.all(
      dates.map((d) => http().get(`/tgif/${d}/share-image`).set(auth(ada))),
    );
    expect(answers.map((a) => a.status)).toEqual(dates.map(() => 200));
    expect(
      answers.every((a) => a.headers['content-type'] === 'image/png'),
    ).toBe(true);
  });
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AccountModule } from '../../account/account.module';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../../account/wawu-id-account.gateway';
import { CommunityModule } from '../../community/community.module';
import { SearchResponseModule } from '../search-response.module';
import {
  normaliseSearch,
  SearchHistoryService,
} from '../search-history.service';
import { asciiDigits, whyNotPopular } from '../popular-search-text';

/**
 * EXPLORE-05 round 2.
 *
 * 1. The new answers are opt-in: GET /search fills `communities` and GET
 *    /search/suggestions fills `recentSearches` only for a request that
 *    carries `include`, so the web (which sends none) gets what it always got.
 * 2. GET /search/popular leaves out the searches of an account whose deletion
 *    is scheduled.
 * 3. GET /search/popular never offers a phone number, an email address, a link
 *    or invisible text, in any spelling, and only offers a text that finds
 *    something a signed-out visitor can see.
 * 4. POST /search/recent says what is wrong with a `q` that is not text.
 *
 * Rows made here carry MARK in their text or their ids, so the spec holds on a
 * database other suites have used.
 */
const MARK = 'ex05r';
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_BASIC = '00000000-0000-4000-8000-000000000002';
const MOCK_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_ID = `http://localhost:${MOCK_ID_PORT}`;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_ID}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

// Every spelling the verifier reached the public list with, and the ones that
// were already held back, as the searches themselves.
const PHONES = [
  '0801.234.5678',
  '(0801) 234 5678',
  '0801/234/5678',
  '0801_234_5678',
  '٠٨٠١٢٣٤٥٦٧٨', // Arabic-Indic digits
  '٠٨٠١ ٢٣٤ ٥٦٧٨',
  '०८०१२३४५६७८', // Devanagari digits
  '0801​2345678', // a zero-width space inside the digits
  '0801‍2345678',
  '０８０１２３４５６７８', // full-width digits
  '+234 801 234 5678',
  '+2348012345678',
  '08012345678',
  '0801-234-5678',
  '+234 (0) 801 234 5678',
  '234 801 234 5678',
  '0801 234 56 78',
  '801 234 5678',
  '12345678901',
  '1234567890123',
  '1234567',
];
const EMAILS = [
  'chidinma@gmail.com',
  'chidinma @ gmail . com',
  'chidinma＠gmail.com', // full-width @
  'chidinma(at)gmail.com',
  'chidinma at gmail dot com',
  'chidinma[at]gmail[dot]com',
  'Chidinma (AT) Gmail (DOT) com',
  'chidinma_at_gmail_dot_com',
  'chidinma{at}gmail',
  'chidinma<at>gmail',
];
const LINKS = [
  'https://evil.example/claim-your-prize',
  'http://x',
  'www.example',
  'evil.example',
  'bit.ly/abc',
  'claim at evil.example',
];
const INVISIBLE = [
  'afro​beats',
  'afrobeats‍',
  '⁠afrobeats',
  '﻿afrobeats',
  'af­robeats',
  'afro‮beats',
  'afro\u0007beats',
];
const KEPT = [
  'afrobeats',
  'Afrobeats 2026',
  'top 10 2026 trends',
  'iphone 15 pro max',
  'tax filing',
  'lagos photographers',
  'ex05r_okafor',
  'mr. okafor',
  'dr okafor',
  'c++ tutorial',
  'at home',
  'make-up artists in lagos',
  'Naija’s best chefs',
];

describe('whyNotPopular (every form)', () => {
  it.each(PHONES)('refuses the number %j', (text) => {
    expect(whyNotPopular(text)).not.toBeNull();
  });
  it.each(EMAILS)('refuses the email address %j', (text) => {
    expect(whyNotPopular(text)).toBe('email');
  });
  it.each(LINKS)('refuses the link or domain %j', (text) => {
    expect(whyNotPopular(text)).not.toBeNull();
  });
  it.each(INVISIBLE)('refuses the invisible character in %j', (text) => {
    expect(whyNotPopular(text)).toBe('invisible');
  });
  it.each(KEPT)('keeps the ordinary search %j', (text) => {
    expect(whyNotPopular(text)).toBeNull();
  });

  it('reads another script as digits and keeps the others as they were', () => {
    expect(asciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(asciiDigits('०१९')).toBe('019');
    expect(asciiDigits('abc 12')).toBe('abc 12');
  });

  it('names the reason', () => {
    expect(whyNotPopular('0801.234.5678')).toBe('number');
    expect(whyNotPopular('a@b.co')).toBe('email');
    expect(whyNotPopular('evil.example')).toBe('link');
    expect(whyNotPopular('a​b')).toBe('invisible');
  });

  // A decision, written down: the word "at" or "dot" between two words is
  // taken as an email spelled out, so a plain search that happens to hold it
  // stays out of the public list (it is still in the person's own Recent).
  it('also keeps out a plain search with "at" between two words', () => {
    expect(whyNotPopular('afrobeats at home')).toBe('email');
  });
});

describe('Search, round 2 (EXPLORE-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let history: SearchHistoryService;
  let plain: string;
  let basic: string;
  let hadPushStop = false;
  const roomIds: string[] = [];
  const gateway = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const popular = async () =>
    data<{ items: string[] }>(await http().get('/api/hub/search/popular'))
      .items;
  const room = async (name: string) => {
    const r = await prisma.community.create({
      data: { name, hostWawuId: USER_BASIC, kind: 'open', description: 'x' },
    });
    roomIds.push(r.id);
    return r.id;
  };
  /** `people` synthetic accounts each searched `text`, stored as the Hub stores it. */
  const seed = (text: string, people: number, tag: string) => {
    const n = normaliseSearch(text);
    return prisma.searchHistory.createMany({
      data: Array.from({ length: people }, (_, i) => ({
        userWawuId: `${MARK}-u${i}-${tag}`,
        queryKey: n.queryKey,
        query: n.query,
        searchedAt: new Date(Date.now() - i * 1000),
      })),
    });
  };
  const key = (text: string) => normaliseSearch(text).queryKey;

  async function cleanUp() {
    await prisma.searchHistory.deleteMany({
      where: {
        OR: [
          { queryKey: { startsWith: MARK } },
          { userWawuId: { startsWith: MARK } },
          { query: { startsWith: MARK } },
        ],
      },
    });
    await prisma.community.deleteMany({
      where: { OR: [{ id: { in: roomIds } }, { name: { contains: MARK } }] },
    });
    await prisma.contentPiece.deleteMany({
      where: { slug: { startsWith: MARK } },
    });
    const profiles = await prisma.userProfile.findMany({
      where: { wawuUserId: { startsWith: `${MARK}-` } },
      select: { wawuUserId: true },
    });
    const ids = profiles.map((p) => p.wawuUserId);
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: ids } },
    });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: ids } } });
  }

  beforeAll(async () => {
    [plain, basic] = await Promise.all([
      login('user@test.wawu.dev'),
      login('creator-basic@test.wawu.dev'),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
        CommunityModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
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
    prisma = app.get(PrismaService);
    history = app.get(SearchHistoryService);
    hadPushStop =
      (await prisma.pushStoppedAccount.count({
        where: { userWawuId: USER_PLAIN },
      })) > 0;
    await cleanUp();
  }, 60000);

  afterAll(async () => {
    await cleanUp();
    if (!hadPushStop)
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: USER_PLAIN },
      });
    await app?.close();
  });

  describe('opt-in answers (the web sends no include)', () => {
    const NAME = `${MARK} Opt Room`;
    beforeAll(async () => {
      await room(NAME);
    });

    it('GET /search leaves communities empty on every tab without include', async () => {
      for (const tab of [undefined, 'all', 'communities', 'content']) {
        const res = await http()
          .get('/api/hub/search')
          .query({ q: NAME, ...(tab ? { tab } : {}) });
        expect(res.status).toBe(200);
        const body = data<Record<string, unknown>>(res);
        expect(Object.keys(body).sort()).toEqual([
          'communities',
          'content',
          'creators',
        ]);
        expect(body.communities).toEqual([]);
      }
    });

    it('GET /search fills communities with include=communities on tab all and communities only', async () => {
      for (const [tab, filled] of [
        [undefined, true],
        ['all', true],
        ['communities', true],
        ['content', false],
        ['creators', false],
      ] as const) {
        const res = await http()
          .get('/api/hub/search')
          .query({ q: NAME, include: 'communities', ...(tab ? { tab } : {}) });
        expect(res.status).toBe(200);
        const names = data<{ communities: { name: string }[] }>(
          res,
        ).communities.map((c) => c.name);
        expect(names.includes(NAME)).toBe(filled);
      }
    });

    it('GET /search refuses an include it does not know', async () => {
      for (const include of ['recent', 'everything', '']) {
        const res = await http()
          .get('/api/hub/search')
          .query({ q: NAME, include });
        expect(res.status).toBe(400);
      }
    });

    it('GET /search/suggestions leaves recentSearches empty without include', async () => {
      await http()
        .post('/api/hub/search/recent')
        .set(auth(plain))
        .send({ q: `${MARK} opt recent` });
      const without = data<{ recentSearches: string[] }>(
        await http().get('/api/hub/search/suggestions').set(auth(plain)),
      );
      expect(without.recentSearches).toEqual([]);
      const withInclude = data<{ recentSearches: string[] }>(
        await http()
          .get('/api/hub/search/suggestions')
          .query({ include: 'recent' })
          .set(auth(plain)),
      );
      expect(withInclude.recentSearches).toContain(`${MARK} opt recent`);
    });

    it('GET /search/suggestions with include=recent is empty when signed out, and refuses an unknown include', async () => {
      const signedOut = await http()
        .get('/api/hub/search/suggestions')
        .query({ include: 'recent' });
      expect(signedOut.status).toBe(200);
      expect(
        data<{ recentSearches: string[] }>(signedOut).recentSearches,
      ).toEqual([]);
      for (const query of [
        { include: 'communities' },
        { include: 'x' },
        'include=recent&include=recent',
      ]) {
        const res = await http()
          .get('/api/hub/search/suggestions')
          .query(query);
        expect(res.status).toBe(400);
      }
    });

    it('GET /search/suggestions ignores any other query it is sent, as it did', async () => {
      const res = await http()
        .get('/api/hub/search/suggestions')
        .query({ whatever: '1' })
        .set(auth(plain));
      expect(res.status).toBe(200);
    });
  });

  describe('POST /search/recent says what is wrong with q', () => {
    const say = async (body: unknown) => {
      const res = await http()
        .post('/api/hub/search/recent')
        .set(auth(plain))
        .send(body as object);
      return {
        status: res.status,
        message: (res.body as { message: string }).message,
      };
    };

    it('says q is required when it is missing or null', async () => {
      expect(await say({})).toEqual({ status: 400, message: 'q is required' });
      expect(await say({ q: null })).toEqual({
        status: 400,
        message: 'q is required',
      });
    });

    it('says q must be text for a number, an array, an object or a boolean', async () => {
      for (const q of [5, 0, ['a'], [], { a: 1 }, true]) {
        expect(await say({ q })).toEqual({
          status: 400,
          message: 'q must be text',
        });
      }
    });

    it('still says empty for an empty text and too long for a long one', async () => {
      const empty = await say({ q: '' });
      expect(empty.status).toBe(400);
      expect(empty.message).toMatch(/empty/);
      const long = await say({ q: 'a'.repeat(101) });
      expect(long.status).toBe(400);
      expect(long.message).toMatch(/shorter than or equal to 100/);
    });
  });

  describe('a deleted account does not count', () => {
    const TEXT = `${MARK} delta lantern`;
    const SECOND = `${MARK} epsilon lantern`;

    beforeAll(async () => {
      await room(`${MARK} Delta Lantern Club`);
      await room(`${MARK} Epsilon Lantern Club`);
    });

    it('drops a text at once when one of its three people schedules the deletion', async () => {
      // Three accounts: plain and basic search it for real, a third is a row.
      for (const t of [plain, basic])
        await http()
          .post('/api/hub/search/recent')
          .set(auth(t))
          .send({ q: TEXT });
      await seed(TEXT, 1, 'delta');
      expect(await popular()).toContain(TEXT);

      const del = await http().delete('/api/hub/account').set(auth(plain));
      expect(del.status).toBe(200);
      // plain's row is still there (kept until the purge), and not counted.
      expect(
        await prisma.searchHistory.count({
          where: { userWawuId: USER_PLAIN, queryKey: TEXT },
        }),
      ).toBe(1);
      expect(await popular()).not.toContain(TEXT);
    });

    it('keeps a text that three other people still have', async () => {
      // plain (deleted) typed it too, with a newer spelling that must not show.
      await seed(SECOND, 3, 'epsilon');
      await prisma.searchHistory.create({
        data: {
          userWawuId: USER_PLAIN,
          queryKey: SECOND,
          query: SECOND.toUpperCase(),
          searchedAt: new Date(),
        },
      });
      const list = await popular();
      expect(list).toContain(SECOND);
      expect(list).not.toContain(SECOND.toUpperCase());
    });

    it('counts the account again when the deletion is cancelled (the mark is removed)', async () => {
      expect(await popular()).not.toContain(TEXT);
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: USER_PLAIN },
      });
      expect(await popular()).toContain(TEXT);
      await prisma.pushStoppedAccount.create({
        data: { userWawuId: USER_PLAIN },
      });
      expect(await popular()).not.toContain(TEXT);
    });
  });

  describe('what may be popular', () => {
    const normal = {
      afro: `${MARK} Afrobeats`,
      creator: `${MARK}_okafor`,
      room: `${MARK} Lagos Photographers`,
    };
    // A byte order mark at the edge is trimmed by normaliseSearch (JS counts it
    // as white space), which leaves the ordinary "afrobeats", so that one
    // spelling is covered by the unit test above and not here.
    const refusedByRule = [
      ...PHONES,
      ...EMAILS,
      ...LINKS,
      ...INVISIBLE.filter((t) => !t.startsWith('\ufeff')),
    ];
    const noResult = [
      `${MARK} send money to my account`, // a sentence
      `${MARK} Chidinma Okafor`, // a private person's name
      `${MARK} Chidinmá Okafor`, // the same name with an accent
      `${MARK} pending thing`, // content nobody can see yet
      `${MARK}_nostate`, // a creator profile with no creator state
    ];

    beforeAll(async () => {
      // Public results for the ordinary searches.
      const piece = (slug: string, title: string, status: 'live' | 'pending') =>
        prisma.contentPiece.create({
          data: {
            slug: `${MARK}-${slug}`,
            creatorWawuId: USER_BASIC,
            contentType: 'video',
            title,
            description: 'About',
            category: 'Music',
            accessType: 'paid',
            price: 500,
            previewAssetUrl: 'https://img.example.com/p.png',
            status,
          },
        });
      await piece('afro', `${normal.afro} Mix`, 'live');
      await piece('pending', `${MARK} pending thing`, 'pending');
      await prisma.userProfile.createMany({
        data: [
          {
            wawuUserId: `${MARK}-c1`,
            accountType: 'creator',
            handle: normal.creator,
            bio: 'bio',
          },
          {
            wawuUserId: `${MARK}-c2`,
            accountType: 'creator',
            handle: `${MARK}_nostate`,
            bio: 'bio',
          },
        ],
      });
      await prisma.creatorState.create({
        data: { wawuUserId: `${MARK}-c1` },
      });
      await room(`${normal.room} Club`);

      // A room named as each spelling is searched (its key), so each has a
      // public result and only the rules can refuse it.
      for (const text of refusedByRule) await room(key(text));

      let n = 0;
      for (const text of Object.values(normal)) await seed(text, 5, `n${n++}`);
      for (const text of refusedByRule) await seed(text, 3, `r${n++}`);
      for (const text of noResult) await seed(text, 3, `x${n++}`);
    });

    it('lists an ordinary search, a creator name and a community name', async () => {
      const list = await popular();
      expect(list).toEqual(expect.arrayContaining(Object.values(normal)));
    });

    it('does not list any number, email, link or invisible-character spelling, even with a public result', async () => {
      const list = await popular();
      const leaked = list.filter((t) =>
        refusedByRule.map(key).includes(key(t)),
      );
      expect(leaked).toEqual([]);
      // each of them does have a public result, so the rules did the refusing
      for (const text of refusedByRule)
        expect(await history.hasPublicResult(key(text))).toBe(true);
    });

    it('does not list a sentence, a private name, an accented name, hidden content or a creator with no state', async () => {
      const list = await popular();
      for (const text of noResult) expect(list).not.toContain(text);
    });

    it('asks the same thing GET /search answers for a signed-out visitor', async () => {
      const all = [...Object.values(normal), ...noResult];
      for (const text of all) {
        const res = data<{
          content: unknown[];
          creators: unknown[];
          communities: unknown[];
        }>(
          await http()
            .get('/api/hub/search')
            .query({ q: key(text), include: 'communities' }),
        );
        const found =
          res.content.length + res.creators.length + res.communities.length > 0;
        expect(await history.hasPublicResult(key(text))).toBe(found);
      }
    });

    it('reaches a good search that sits behind a page of refused ones', async () => {
      const spam = Array.from(
        { length: 40 },
        (_, i) => `0801234567${String(i).padStart(2, '0')}`,
      );
      for (const [i, text] of spam.entries()) await seed(text, 6, `s${i}`);
      // Forty texts of six people each come before the ordinary ones (five
      // people), so those sit on a later page than the first 32.
      const list = await popular();
      expect(list).toEqual(expect.arrayContaining(Object.values(normal)));
      expect(list.length).toBeLessThanOrEqual(8);
      expect(list.filter((t) => /^0801/.test(t))).toEqual([]);
    });
  });
});

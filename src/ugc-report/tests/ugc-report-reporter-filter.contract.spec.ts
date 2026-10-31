// REPORT-UGC round 1 (MEDIUM 2 and MEDIUM 4). The reporter's filter, pinned on its own.
//
// The main spec's filter test cannot pin the piece filters: there the same person also reported the creator's profile, which
// takes the creator's pieces out of every list anyway. Here a person reports ONE PIECE of a creator and nothing else, so the
// only thing that can take that piece out of their lists is the piece filter itself. Another person is the control: for them
// the piece is still there in every list. The profile case is its own check: a reported profile still opens.
//
// Real HTTP, the real database, real RS256 tokens from mock-wawu-id. The people are registered here, so no other suite's
// reports reach them. The rows it writes are removed after.

process.env.UGC_REPORT_MAIL_RETRY_MS = '5';

import { ChildProcess, spawn } from 'child_process';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { NotificationModule } from '../../notification/notification.module';
import { PurchaseModule } from '../../purchase/purchase.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { MeModule } from '../../me/me.module';
import { SearchResponseModule } from '../../search-response/search-response.module';
import { UserProfileModule } from '../../user-profile/user-profile.module';
import { UgcReportModule } from '../ugc-report.module';
import { UgcReportMailService } from '../ugc-report-mail.service';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK = `http://localhost:${MOCK_PORT}`;
const REPO_ROOT = path.resolve(__dirname, '../../../');
// A seeded creator: a profile exists for them, so their shelf (GET /users/{id}/content) opens.
const CREATOR = '00000000-0000-4000-8000-000000000003';
const TAG = `ugcf${Date.now()}`;

interface Who {
  sub: string;
  token: string;
}

async function healthy(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${MOCK}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let nonce = 0;
async function register(label: string): Promise<Who> {
  nonce += 1;
  const tag = `${Date.now().toString().slice(-8)}${nonce}`;
  const res = await fetch(`${MOCK}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Report Filter ${label}`,
      email: `report-filter-${label}-${tag}@test.wawu.dev`,
      phone: `+2347${tag}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
  const b = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: b.user.id, token: b.accessToken };
}

describe('REPORT-UGC: a reported piece, on its own, leaves the reporter lists only', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let mail: UgcReportMailService;
  let mockId: ChildProcess | undefined;
  let ana: Who; // reports ONE piece, nothing else
  let bayo: Who; // never reports anything: the control
  let cara: Who; // reports the creator's PROFILE, nothing else
  let pieceOne: string; // the one ana reports
  let pieceTwo: string; // the same creator's other piece: stays for everybody

  const http = () => request(app.getHttpServer() as Server);
  const get = (who: Who, url: string) =>
    http().get(`/api/hub${url}`).set('Authorization', `Bearer ${who.token}`);
  /** The answer's `data`, typed by the caller. */
  const dataOf = <T>(res: { body: unknown }): T =>
    (res.body as { data: T }).data;
  const ids = (res: { body: { data: unknown } }): string[] => {
    const data = res.body.data as
      Array<{ id: string }> | { items: Array<{ id: string }> };
    return (Array.isArray(data) ? data : data.items).map((i) => i.id);
  };
  const savedIds = (res: { body: { data: { items: unknown[] } } }): string[] =>
    (
      res.body.data.items as Array<{
        content: { id: string } | null;
      }>
    )
      .map((i) => i.content?.id)
      .filter((id): id is string => !!id);

  /** Every list the reporter used to meet the piece in, as [name, ids] for one person. */
  async function listsFor(who: Who): Promise<Array<[string, string[]]>> {
    const q = `perPage=100`;
    return [
      [
        'feed, trending',
        ids(await get(who, `/content?${q}&sort=trending`).expect(200)),
      ],
      [
        'feed, recent',
        ids(await get(who, `/content?${q}&sort=recent`).expect(200)),
      ],
      ['feed, top', ids(await get(who, `/content?${q}&sort=top`).expect(200))],
      [
        'following',
        ids(await get(who, `/content?${q}&scope=following`).expect(200)),
      ],
      [
        'search',
        dataOf<{ content: Array<{ id: string }> }>(
          await get(who, `/search?q=${TAG}&tab=content`).expect(200),
        ).content.map((i) => i.id),
      ],
      ['closest', ids(await get(who, `/search/closest?q=${TAG}`).expect(200))],
      [
        'the creator shelf',
        ids(
          await get(who, `/users/${CREATOR}/content?perPage=100`).expect(200),
        ),
      ],
      ['saved', savedIds(await get(who, `/me/saved?type=content`).expect(200))],
    ];
  }

  beforeAll(async () => {
    if (!(await healthy(1000))) {
      mockId = spawn('node', ['server.js'], {
        cwd: path.join(REPO_ROOT, 'mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await healthy(15000)))
        throw new Error('mock-wawu-id did not become healthy in time');
    }
    [ana, bayo, cara] = [
      await register('ana'),
      await register('bayo'),
      await register('cara'),
    ];
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        PurchaseModule,
        ContentPieceModule,
        DirectMessageModule,
        FollowRelationshipModule,
        BlockedAccountModule,
        MeModule,
        SearchResponseModule,
        UserProfileModule,
        UgcReportModule,
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
    mail = moduleRef.get(UgcReportMailService);

    const piece = (n: string) =>
      prisma.contentPiece.create({
        data: {
          slug: `${TAG}-${n}`,
          creatorWawuId: CREATOR,
          contentType: 'video',
          title: `${TAG} ${n}`,
          description: 'A fixture piece',
          category: 'fixture',
          accessType: 'paid',
          price: 100,
          previewAssetUrl: 'https://example.invalid/p.jpg',
          status: 'live',
        },
        select: { id: true },
      });
    pieceOne = (await piece('one')).id;
    pieceTwo = (await piece('two')).id;
    // Each of the three follows the creator (the "following" list) and saved both pieces (Saved).
    for (const who of [ana, bayo, cara]) {
      await prisma.followRelationship.create({
        data: { followerWawuId: who.sub, followingWawuId: CREATOR },
      });
      await prisma.savedItem.createMany({
        data: [
          { userWawuId: who.sub, contentId: pieceOne },
          { userWawuId: who.sub, contentId: pieceTwo },
        ],
      });
    }
  });

  afterAll(async () => {
    if (mail) await mail.settled();
    if (prisma) {
      const people = [ana, bayo, cara].filter(Boolean).map((w) => w.sub);
      await prisma.ugcReport.deleteMany({
        where: { reporterWawuId: { in: people } },
      });
      await prisma.savedItem.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await prisma.followRelationship.deleteMany({
        where: { followerWawuId: { in: people }, followingWawuId: CREATOR },
      });
      await prisma.contentPiece.deleteMany({
        where: { slug: { startsWith: TAG } },
      });
    }
    await app?.close();
    mockId?.kill();
  });

  it('before any report, every list holds both pieces for everybody', async () => {
    for (const who of [ana, bayo]) {
      for (const [name, got] of await listsFor(who)) {
        expect([name, got]).toEqual([
          name,
          expect.arrayContaining([pieceOne, pieceTwo]),
        ]);
      }
    }
  });

  it('a person who reports ONE piece loses it from the feed (trending, recent, top, following), search, closest, the creator shelf and Saved, and keeps the creator other piece', async () => {
    await http()
      .post('/api/hub/reports')
      .set('Authorization', `Bearer ${ana.token}`)
      .send({ kind: 'piece', targetId: pieceOne, reason: 'spam' })
      .expect(200);
    // The only report this person has made: the piece. Nothing else can explain a missing piece below.
    expect(
      await prisma.ugcReport.count({ where: { reporterWawuId: ana.sub } }),
    ).toBe(1);

    // Every list at once, so a failure names each list that still shows it.
    const lists = await listsFor(ana);
    expect(
      lists.filter(([, got]) => got.includes(pieceOne)).map(([n]) => n),
    ).toEqual([]);
    expect(
      lists.filter(([, got]) => !got.includes(pieceTwo)).map(([n]) => n),
    ).toEqual([]);
    // The shelf's count leaves it out too, and Saved's own count.
    const shelf = await get(
      ana,
      `/users/${CREATOR}/content?perPage=100`,
    ).expect(200);
    expect(
      ids(shelf).filter((id) => [pieceOne, pieceTwo].includes(id)),
    ).toHaveLength(1);
    const counts = dataOf<{ saved: number }>(
      await get(ana, '/me/counts').expect(200),
    );
    expect(counts.saved).toBe(1);
  });

  it('for another person the same piece is still there in every list', async () => {
    for (const [name, got] of await listsFor(bayo)) {
      expect([name, got.includes(pieceOne)]).toEqual([name, true]);
      expect([name, got.includes(pieceTwo)]).toEqual([name, true]);
    }
    const counts = dataOf<{ saved: number }>(
      await get(bayo, '/me/counts').expect(200),
    );
    expect(counts.saved).toBe(2);
  });

  it('the public shelf for a signed-out reader is unchanged, and the reported piece still opens by its own link', async () => {
    const pub = await http()
      .get(`/api/hub/content/public/creator/${CREATOR}/content?perPage=100`)
      .expect(200);
    expect(ids(pub)).toEqual(expect.arrayContaining([pieceOne, pieceTwo]));
    // Opening it by its own link: the person chose to open it.
    const open = await get(ana, `/content/${pieceOne}`).expect(200);
    expect(dataOf<{ id: string }>(open).id).toBe(pieceOne);
  });

  it('a reported PROFILE still opens, with its shelf: hiding a person is what Block does', async () => {
    await http()
      .post('/api/hub/reports')
      .set('Authorization', `Bearer ${cara.token}`)
      .send({ kind: 'profile', targetId: CREATOR, reason: 'impersonation' })
      .expect(200);
    await get(cara, `/users/${CREATOR}/visitor-profile`).expect(200);
    await get(cara, `/users/${CREATOR}/profile-fields`).expect(200);
    const shelf = await get(
      cara,
      `/users/${CREATOR}/content?perPage=100`,
    ).expect(200);
    expect(ids(shelf)).toEqual(expect.arrayContaining([pieceOne, pieceTwo]));
  });
});

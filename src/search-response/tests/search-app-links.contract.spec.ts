import * as crypto from 'crypto';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageModule } from '../../storage/storage.module';
import { PriceListModule } from '../../price-list/price-list.module';
import { SearchResponseModule } from '../search-response.module';
import { OptionalWawuAuthGuard } from '../guards/optional-wawu-auth.guard';

/**
 * HUB-SWEEP-1 (F1 of the 31 Oct 2026 walk): GET /search served a piece's `previewAssetUrl` as the raw storage key the
 * row holds (`content/preview/<uid>/...`), so a photo in the app's Search drew the kind mark, never its picture. The
 * feed, the saved list and My content sign theirs. The routes are in the protected registry (the website calls them),
 * so the rule is the header rule (CONVENTIONS 3a): a request carrying `X-Wawu-Client: app` gets fresh links; one
 * without it is answered exactly as before, byte for byte.
 *
 * Over HTTP on the real database. The bucket is a small server on this machine that answers a GET only when the link
 * is signed (`X-Amz-Signature`, the access key in `X-Amz-Credential`, an `X-Amz-Expires`), so "a link that loads" is
 * tested by loading it. Every shape of the three search routes that holds a stored file is covered: the content rows
 * (`GET /search`, `GET /search/closest`), the creators (`GET /search`, `GET /search/suggestions`) and the communities
 * (`GET /search`, `include=communities`). `GET /search/people` signs its avatars already and is not touched.
 */
const OWN = (n: number) =>
  `5e4a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAKER = OWN(1);
const BUYER = OWN(2);
const OWNED = [MAKER, BUYER];
const APP = { 'X-Wawu-Client': 'app' };
const TAG = 'HUBSWEEPSPEC';
const BUCKET_PORT = 11731;
const BUCKET = 'hubsweep-bucket';
const ACCESS_KEY = 'hubsweep-key';
const uid = (n: number) =>
  `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PIECE = {
  freePhoto: OWN(11),
  paidPhoto: OWN(12),
  staleLink: OWN(13),
  seedLink: OWN(14),
};
const KEY = {
  freePreview: `content/preview/${MAKER}/${uid(1)}.jpg`,
  freeFull: `content/full/${MAKER}/${uid(2)}.jpg`,
  paidPreview: `content/preview/${MAKER}/${uid(3)}.jpg`,
  paidFull: `content/full/${MAKER}/${uid(4)}.jpg`,
  stalePreview: `content/preview/${MAKER}/${uid(5)}.jpg`,
  avatar: `avatars/${MAKER}/${uid(6)}.jpg`,
  cover: `profile/cover/${MAKER}/${uid(7)}.jpg`,
  room: `community/image/${MAKER}/${uid(8)}.jpg`,
};
/** What a link signed a week ago and stored on the row looks like: long dead, and not a fresh signature. */
const STALE = `http://127.0.0.1:${BUCKET_PORT}/${BUCKET}/${KEY.stalePreview}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${ACCESS_KEY}%2F20260101%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260101T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=${'0'.repeat(64)}`;
/** A link on a host that is not our bucket (what the seed writes): never touched. */
const SEED_LINK = 'https://storage.seed.local/content/hubsweep-preview.pdf';

type Piece = {
  id: string;
  previewAssetUrl: string;
  fullAssetUrl: string | null;
  fullAssetLocked: boolean;
  coverUrl?: string | null;
};
type Creator = {
  wawuUserId: string;
  avatarUrl: string | null;
  coverUrl: string | null;
};
type Room = { id: string; name: string; imageUrl: string | null };

describe('GET /search serves signed links to the app and the stored values to the web (HUB-SWEEP-1, F1)', () => {
  let app: INestApplication;
  const server = (): App => app.getHttpServer() as App;
  let prisma: PrismaService;
  let bucket: http.Server;
  let publicKey: string;
  let privateKey: string;
  const envSnapshot: Record<string, string | undefined> = {};
  const STORAGE_ENV: Record<string, string> = {
    STORAGE_ENDPOINT: `http://127.0.0.1:${BUCKET_PORT}`,
    STORAGE_FORCE_PATH_STYLE: 'true',
    STORAGE_ACCESS_KEY_ID: ACCESS_KEY,
    STORAGE_SECRET_ACCESS_KEY: 'hubsweep-secret',
    STORAGE_BUCKET: BUCKET,
    STORAGE_REGION: 'auto',
  };
  let community = '';

  const bearer = (sub: string) =>
    `Bearer ${jwt.sign(
      { sub, email: `${sub}@test.wawu.dev`, status: 'active' },
      privateKey,
      {
        algorithm: 'RS256',
        expiresIn: '15m',
      },
    )}`;
  const data = <T>(res: request.Response) => (res.body as { data: T }).data;

  /** The bucket: a GET answers 200 with `bytes:<key>` only for a link that is signed, 403 for anything else. */
  function startBucket(): Promise<void> {
    bucket = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${BUCKET_PORT}`);
      const prefix = `/${BUCKET}/`;
      const signed =
        /^[0-9a-f]{64}$/.test(url.searchParams.get('X-Amz-Signature') ?? '') &&
        url.searchParams.get('X-Amz-Signature') !== '0'.repeat(64) &&
        (url.searchParams.get('X-Amz-Credential') ?? '').startsWith(
          `${ACCESS_KEY}/`,
        ) &&
        Number(url.searchParams.get('X-Amz-Expires')) > 0;
      if (req.method !== 'GET' || !url.pathname.startsWith(prefix) || !signed) {
        res.statusCode = 403;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end(`bytes:${decodeURIComponent(url.pathname.slice(prefix.length))}`);
    });
    return new Promise((resolve) =>
      bucket.listen(BUCKET_PORT, '127.0.0.1', resolve),
    );
  }
  /** Opens a link the way a phone does and returns what the bucket sent. */
  async function open(
    link: string | null,
  ): Promise<{ status: number; body: string }> {
    expect(link).toEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:/));
    const res = await fetch(link as string);
    return { status: res.status, body: await res.text() };
  }
  const loadsAs = async (link: string | null, key: string) =>
    expect(await open(link)).toEqual({ status: 200, body: `bytes:${key}` });

  beforeAll(async () => {
    for (const [key, value] of Object.entries(STORAGE_ENV)) {
      envSnapshot[key] = process.env[key];
      process.env[key] = value;
    }
    await startBucket();
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        StorageModule,
        // Registers the middleware that reads `X-Wawu-Client` on every route (CONVENTIONS 3a), as the app module does.
        PriceListModule,
        SearchResponseModule,
      ],
    })
      .overrideGuard(OptionalWawuAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{
            headers: Record<string, string | undefined>;
            user?: unknown;
          }>();
          const h = req.headers['authorization'];
          if (h?.startsWith('Bearer '))
            req.user = jwt.verify(h.slice(7), publicKey, {
              algorithms: ['RS256'],
            });
          return true;
        },
      })
      .compile();
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

    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: MAKER,
          accountType: 'creator' as const,
          handle: `${TAG.toLowerCase()}-maker`,
          avatarUrl: KEY.avatar,
          coverUrl: KEY.cover,
        },
        {
          wawuUserId: BUYER,
          accountType: 'user' as const,
          handle: `${TAG.toLowerCase()}-buyer`,
        },
      ],
      skipDuplicates: true,
    });
    await prisma.creatorState.create({ data: { wawuUserId: MAKER } });
    // Top of the suggestions: the highest score there is, so GET /search/suggestions lists this creator.
    await prisma.evgScore.create({
      data: { creatorWawuId: MAKER, score: 2_000_000_000 },
    });
    const piece = (
      id: string,
      slug: string,
      title: string,
      accessType: 'free' | 'paid',
      previewAssetUrl: string,
      fullAssetUrl: string,
    ) => ({
      id,
      slug: `${TAG.toLowerCase()}-${slug}`,
      creatorWawuId: MAKER,
      contentType: 'image' as const,
      title: `${TAG} ${title}`,
      description: 'a photograph',
      category: 'photography',
      accessType,
      price: accessType === 'paid' ? 1500 : 0,
      previewAssetUrl,
      fullAssetUrl,
      status: 'live' as const,
      // Most viewed first, so the order of the answer is the same on every run.
      views: 1000 - Number(id.slice(-2)),
    });
    await prisma.contentPiece.createMany({
      data: [
        piece(
          PIECE.freePhoto,
          'free',
          'free photo',
          'free',
          KEY.freePreview,
          KEY.freeFull,
        ),
        piece(
          PIECE.paidPhoto,
          'paid',
          'paid photo',
          'paid',
          KEY.paidPreview,
          KEY.paidFull,
        ),
        piece(PIECE.staleLink, 'stale', 'stale link', 'free', STALE, STALE),
        piece(
          PIECE.seedLink,
          'seed',
          'seed link',
          'free',
          SEED_LINK,
          SEED_LINK,
        ),
      ],
    });
    await prisma.purchase.create({
      data: {
        contentId: PIECE.paidPhoto,
        type: 'content',
        buyerWawuId: BUYER,
        creatorWawuId: MAKER,
        amount: 1500,
        commissionRate: 0.15,
        flutterwaveTxRef: `hubsweep-${PIECE.paidPhoto}`,
        flutterwaveTxId: null,
        status: 'completed',
        note: null,
      },
    });
    community = (
      await prisma.community.create({
        data: {
          name: `${TAG} room`,
          description: 'a room',
          hostWawuId: MAKER,
          kind: 'open',
          imageUrl: KEY.room,
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.purchase.deleteMany({ where: { buyerWawuId: BUYER } });
    await prisma.community.deleteMany({ where: { hostWawuId: MAKER } });
    await prisma.contentPiece.deleteMany({ where: { creatorWawuId: MAKER } });
    await prisma.evgScore.deleteMany({ where: { creatorWawuId: MAKER } });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: MAKER } });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app?.close();
    await new Promise((resolve) => bucket?.close(resolve));
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const search = (headers: Record<string, string>, sub?: string) =>
    request(server())
      .get('/search')
      .query({ q: TAG, include: 'communities' })
      .set(sub ? { ...headers, Authorization: bearer(sub) } : headers)
      .expect(200);
  const piecesOf = (res: request.Response) =>
    data<{ content: Piece[] }>(res).content;
  const byId = (rows: Piece[], id: string) =>
    rows.find((r) => r.id === id) as Piece;

  /** What the Hub answered for a piece before this task: the row as stored, with the lock decided. No coverKey. */
  async function asBefore(id: string, locked: boolean): Promise<string> {
    const { coverKey: _coverKey, ...row } =
      await prisma.contentPiece.findUniqueOrThrow({ where: { id } });
    void _coverKey;
    return JSON.stringify({
      ...row,
      fullAssetUrl: locked ? null : row.fullAssetUrl,
      fullAssetLocked: locked,
    });
  }

  describe('the app (X-Wawu-Client: app)', () => {
    it('a photo in Search carries a signed preview link that loads, and a free one a signed full link', async () => {
      const rows = piecesOf(await search(APP));
      const free = byId(rows, PIECE.freePhoto);
      await loadsAs(free.previewAssetUrl, KEY.freePreview);
      await loadsAs(free.fullAssetUrl, KEY.freeFull);
      expect(free.fullAssetLocked).toBe(false);
      // The key itself is no longer what is served.
      expect(free.previewAssetUrl).not.toBe(KEY.freePreview);
      expect(free.coverUrl).toBeNull();
    });

    it('a paid piece the caller has not bought shows its preview and keeps the full file locked (null)', async () => {
      const paid = byId(piecesOf(await search(APP)), PIECE.paidPhoto);
      await loadsAs(paid.previewAssetUrl, KEY.paidPreview);
      expect(paid.fullAssetLocked).toBe(true);
      expect(paid.fullAssetUrl).toBeNull();
    });

    it('a buyer who paid gets a signed full link on the piece they bought', async () => {
      const paid = byId(piecesOf(await search(APP, BUYER)), PIECE.paidPhoto);
      expect(paid.fullAssetLocked).toBe(false);
      await loadsAs(paid.fullAssetUrl, KEY.paidFull);
    });

    it('a link stored a week ago is signed again; a link on another host is left alone', async () => {
      const rows = piecesOf(await search(APP));
      const stale = byId(rows, PIECE.staleLink);
      expect(stale.previewAssetUrl).not.toBe(STALE);
      await loadsAs(stale.previewAssetUrl, KEY.stalePreview);
      await loadsAs(stale.fullAssetUrl, KEY.stalePreview);
      // The stored one is dead: the bucket refuses it.
      expect((await fetch(STALE)).status).toBe(403);
      const seed = byId(rows, PIECE.seedLink);
      expect(seed.previewAssetUrl).toBe(SEED_LINK);
      expect(seed.fullAssetUrl).toBe(SEED_LINK);
    });

    it('a creator found in Search carries a signed avatar and cover that load', async () => {
      const res = await request(server())
        .get('/search')
        .query({ q: TAG, tab: 'creators' })
        .set(APP)
        .expect(200);
      const maker = data<{ creators: Creator[] }>(res).creators.find(
        (c) => c.wawuUserId === MAKER,
      ) as Creator;
      await loadsAs(maker.avatarUrl, KEY.avatar);
      await loadsAs(maker.coverUrl, KEY.cover);
    });

    it('a room found in Search carries a signed picture that loads', async () => {
      const room = data<{ communities: Room[] }>(
        await search(APP),
      ).communities.find((c) => c.id === community) as Room;
      await loadsAs(room.imageUrl, KEY.room);
    });

    it('the closest-match route signs its pieces', async () => {
      const res = await request(server())
        .get('/search/closest')
        .query({ q: `${TAG} nothing-like-it` })
        .set(APP)
        .expect(200);
      const free = byId(data<{ items: Piece[] }>(res).items, PIECE.freePhoto);
      await loadsAs(free.previewAssetUrl, KEY.freePreview);
      await loadsAs(free.fullAssetUrl, KEY.freeFull);
      expect(
        byId(data<{ items: Piece[] }>(res).items, PIECE.paidPhoto).fullAssetUrl,
      ).toBeNull();
    });

    it('the suggested creators sign their avatar and cover', async () => {
      const res = await request(server())
        .get('/search/suggestions')
        .set(APP)
        .expect(200);
      const maker = data<{ suggestedCreators: Creator[] }>(
        res,
      ).suggestedCreators.find((c) => c.wawuUserId === MAKER) as Creator;
      await loadsAs(maker.avatarUrl, KEY.avatar);
      await loadsAs(maker.coverUrl, KEY.cover);
    });

    it('the header is read without case and with spaces; any other value is the web', async () => {
      const loud = piecesOf(await search({ 'X-Wawu-Client': ' APP ' }));
      await loadsAs(
        byId(loud, PIECE.freePhoto).previewAssetUrl,
        KEY.freePreview,
      );
      const other = piecesOf(await search({ 'X-Wawu-Client': 'web' }));
      expect(byId(other, PIECE.freePhoto).previewAssetUrl).toBe(
        KEY.freePreview,
      );
    });
  });

  describe('the web (no header): the answer is the one it always had, byte for byte', () => {
    it('every piece is exactly the stored row with the lock decided, in the same key order, with no coverUrl', async () => {
      const res = await search({});
      const raw = piecesOf(res);
      expect(raw.map((r) => r.id).sort()).toEqual(Object.values(PIECE).sort());
      for (const [id, locked] of [
        [PIECE.freePhoto, false],
        [PIECE.paidPhoto, true],
        [PIECE.staleLink, false],
        [PIECE.seedLink, false],
      ] as const) {
        expect(JSON.stringify(byId(raw, id))).toBe(await asBefore(id, locked));
      }
      expect(byId(raw, PIECE.freePhoto).previewAssetUrl).toBe(KEY.freePreview);
      expect(byId(raw, PIECE.staleLink).previewAssetUrl).toBe(STALE);
    });

    it('a buyer on the web sees the stored full value of the piece they bought, not a signed one', async () => {
      const paid = byId(piecesOf(await search({}, BUYER)), PIECE.paidPhoto);
      expect(JSON.stringify(paid)).toBe(await asBefore(PIECE.paidPhoto, false));
      expect(paid.fullAssetUrl).toBe(KEY.paidFull);
    });

    it('creators and rooms keep the stored values', async () => {
      const res = await search({});
      const maker = data<{ creators: Creator[] }>(res).creators.find(
        (c) => c.wawuUserId === MAKER,
      ) as Creator;
      expect(maker.avatarUrl).toBe(KEY.avatar);
      expect(maker.coverUrl).toBe(KEY.cover);
      const room = data<{ communities: Room[] }>(res).communities.find(
        (c) => c.id === community,
      ) as Room;
      expect(room.imageUrl).toBe(KEY.room);
    });

    it('the closest-match and suggestion routes keep the stored values', async () => {
      const closest = await request(server())
        .get('/search/closest')
        .query({ q: `${TAG} nothing-like-it` })
        .expect(200);
      const free = byId(
        data<{ items: Piece[] }>(closest).items,
        PIECE.freePhoto,
      );
      expect(JSON.stringify(free)).toBe(await asBefore(PIECE.freePhoto, false));
      const sug = await request(server())
        .get('/search/suggestions')
        .expect(200);
      const maker = data<{ suggestedCreators: Creator[] }>(
        sug,
      ).suggestedCreators.find((c) => c.wawuUserId === MAKER) as Creator;
      expect(maker.avatarUrl).toBe(KEY.avatar);
      expect(maker.coverUrl).toBe(KEY.cover);
    });
  });
});

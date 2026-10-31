import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import { parseBuffer } from 'music-metadata';
import request from 'supertest';
import type { App } from 'supertest/types';
import { mp3File, wavFile } from '../../../test/ai-tools/media-fixtures';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { StorageModule } from '../../storage/storage.module';
import { StorageService, objectKeyFrom } from '../../storage/storage.service';
import { ContentPieceModule } from '../content-piece.module';
import { CUT_WORDS } from '../preview-cut/cut-types';
import {
  NEEDS_PREVIEW,
  CANNOT_MAKE,
  NEEDS_COVER,
} from '../preview-cut.service';
import {
  syntheticMp4,
  pdfFile,
  pdfPageCount,
} from '../../../test/content-piece/preview-fixtures';

/**
 * PREVIEW-AUTO (owner, 31 Oct 2026: "why would audio ask for a 30 60 second preview clip?"). Over HTTP on the real database; the
 * bucket is an in-memory set of files that answers HEAD, ranged GET, PUT and DELETE.
 *  - a FREE piece is accepted with no preview: its preview is its own file, and nothing new is stored or counted
 *  - a PAID audio piece with `previewFromFile` gets a 30 second preview cut by the Hub (its length read back from the stored cut)
 *  - a PAID video piece the same; a file under 45 seconds gets its first third
 *  - the creator's own clip still works, unchanged, and nothing is cut
 *  - a file too short, a paid piece asking for nothing, and a pdf asking for a cut are refused in the Hub's own words
 *  - the cut counts once in the creator's storage; a publish that fails gives it back; a retry replaces it in place
 */
const OWN = (n: number) =>
  `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAKER = OWN(1);
const APP = { 'X-Wawu-Client': 'app' };

describe('A paid audio or video piece has its preview made from its file (PREVIEW-AUTO, contract)', () => {
  let app: INestApplication;
  const server = (): App => app.getHttpServer() as App;
  let prisma: PrismaService;
  let storage: StorageService;
  let privateKey: string;
  let publicKey: string;
  const envSnapshot: Record<string, string | undefined> = {};
  const STORAGE_ENV: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://bucket.example-storage.dev',
    STORAGE_ACCESS_KEY_ID: 'prevauto-test-key',
    STORAGE_SECRET_ACCESS_KEY: 'prevauto-test-secret',
    STORAGE_BUCKET: 'prevauto-test-bucket',
    STORAGE_REGION: 'auto',
  };
  let bucket = new Map<string, Buffer>();
  let puts: string[] = [];

  const bearer = (sub: string) =>
    `Bearer ${jwt.sign({ sub, email: `${sub}@test.wawu.dev`, status: 'active' }, privateKey, { algorithm: 'RS256', expiresIn: '15m' })}`;

  class TestAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        user?: unknown;
      }>();
      const header = req.headers['authorization'];
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
      try {
        req.user = jwt.verify(header.slice('Bearer '.length), publicKey, {
          algorithms: ['RS256'],
        });
        return true;
      } catch {
        throw new UnauthorizedException();
      }
    }
  }

  /** A full file that has landed: presigned, in the bucket with its real bytes, confirmed. */
  const fullFile = (contentType: string, body: Buffer) =>
    landed('content/full', contentType, body);

  async function landed(folder: string, contentType: string, body: Buffer) {
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(MAKER))
      .send({
        folder,
        contentType,
        extension: 'x',
        contentLength: body.length,
      });
    expect(res.status).toBe(200);
    const out = (res.body as { data: { key: string; fileUrl: string } }).data;
    bucket.set(out.key, body);
    await prisma.storageObject.update({
      where: { key: out.key },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        bytes: body.length,
      },
    });
    return out;
  }
  const listing = (extra: Record<string, unknown>) => ({
    contentType: 'audio',
    title: 'PREVIEW-AUTO spec piece',
    description: 'A piece whose preview the Hub makes',
    category: 'business_entrepreneurship',
    tags: [],
    accessType: 'paid',
    price: 2000,
    ...extra,
  });
  const post = (body: Record<string, unknown>) =>
    request(server())
      .post('/content')
      .set('Authorization', bearer(MAKER))
      .set(APP)
      .send(body);
  const used = async () => (await storage.usageFor(MAKER)).usedBytes;
  const seconds = async (b: Buffer, mimeType: string) =>
    (await parseBuffer(new Uint8Array(b), { mimeType }, { duration: true }))
      .format.duration ?? 0;
  type Piece = { id: string; previewAssetUrl?: string };
  const pieceRow = (res: request.Response) =>
    prisma.contentPiece.findUniqueOrThrow({
      where: { id: (res.body as { data: Piece }).data.id },
    });
  const message = (res: request.Response) =>
    (res.body as { message?: string }).message ?? '';

  beforeAll(async () => {
    for (const [key, value] of Object.entries(STORAGE_ENV)) {
      envSnapshot[key] = process.env[key];
      process.env[key] = value;
    }
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(((
      command: unknown,
    ) => {
      if (command instanceof HeadObjectCommand) {
        const file = bucket.get(command.input.Key as string);
        if (file) return Promise.resolve({ ContentLength: file.length });
        return Promise.reject(
          Object.assign(new Error('NotFound'), {
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      if (command instanceof GetObjectCommand) {
        const file = bucket.get(command.input.Key as string);
        if (!file)
          return Promise.reject(
            Object.assign(new Error('NoSuchKey'), {
              $metadata: { httpStatusCode: 404 },
            }),
          );
        const m = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '');
        const part = m ? file.subarray(Number(m[1]), Number(m[2]) + 1) : file;
        return Promise.resolve({
          Body: {
            transformToByteArray: () => Promise.resolve(new Uint8Array(part)),
          },
          ContentLength: part.length,
        });
      }
      if (command instanceof PutObjectCommand) {
        bucket.set(
          command.input.Key as string,
          Buffer.from(command.input.Body as Buffer),
        );
        puts.push(command.input.Key as string);
        return Promise.resolve({});
      }
      if (command instanceof DeleteObjectCommand) {
        bucket.delete(command.input.Key as string);
        return Promise.resolve({});
      }
      return Promise.reject(new Error('unexpected bucket call'));
    }) as never);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        StorageModule,
        ContentPieceModule,
      ],
    })
      .overrideGuard(WawuAuthGuard)
      .useClass(TestAuthGuard)
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
    storage = moduleRef.get(StorageService);
    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: MAKER,
          accountType: 'creator' as const,
          handle: 'prevauto01',
        },
      ],
      skipDuplicates: true,
    });
    await prisma.makerTier.create({
      data: {
        wawuUserId: MAKER,
        tierId: 'swa5-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 30,
        pointsIncluded: 0,
      },
    });
  }, 60_000);

  beforeEach(() => {
    bucket = new Map();
    puts = [];
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.productDraft.deleteMany({ where: { wawuUserId: MAKER } });
    await prisma.contentPiece.deleteMany({ where: { creatorWawuId: MAKER } });
    await prisma.storageObject.deleteMany({ where: { wawuUserId: MAKER } });
    await prisma.makerTier.deleteMany({ where: { wawuUserId: MAKER } });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: MAKER } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(async () => {
    await prisma.contentPiece.deleteMany({ where: { creatorWawuId: MAKER } });
    await prisma.storageObject.deleteMany({ where: { wawuUserId: MAKER } });
    await prisma.creatorState.updateMany({
      where: { wawuUserId: MAKER },
      data: { slotsUsed: 0 },
    });
  });

  it('accepts a FREE piece with no preview: the preview is its own file and nothing new is stored or counted', async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const res = await post(
      listing({ accessType: 'free', price: 0, fullAsset: full.fileUrl }),
    );
    expect(res.status).toBe(201);
    const row = await pieceRow(res);
    expect(objectKeyFrom(row.previewAssetUrl)).toBe(full.key);
    expect(puts).toEqual([]);
    expect(
      await prisma.storageObject.count({ where: { wawuUserId: MAKER } }),
    ).toBe(1);
    expect(await used()).toBe(mp3File(100).length);
  });

  it("cuts a PAID audio piece's preview from its file: 30 seconds, read back from the stored cut, counted once", async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const res = await post(
      listing({ fullAsset: full.fileUrl, previewFromFile: true }),
    );
    expect(res.status).toBe(201);
    const row = await pieceRow(res);
    const key = objectKeyFrom(row.previewAssetUrl);
    expect(key).toMatch(
      new RegExp(`^content/preview/${MAKER}/auto-[0-9a-f]{20}\\.mp3$`),
    );
    expect(puts).toEqual([key]);
    const stored = bucket.get(key)!;
    expect(await seconds(stored, 'audio/mpeg')).toBeCloseTo(30, 0);
    const cutRow = await prisma.storageObject.findUniqueOrThrow({
      where: { key },
    });
    expect(cutRow).toMatchObject({
      status: 'confirmed',
      folder: 'content/preview',
      wawuUserId: MAKER,
      contentType: 'audio/mpeg',
    });
    expect(Number(cutRow.bytes)).toBe(stored.length);
    // the full file and the cut: each counted once
    expect(await used()).toBe(mp3File(100).length + stored.length);
    expect(
      await prisma.storageObject.count({
        where: { wawuUserId: MAKER, status: 'confirmed' },
      }),
    ).toBe(2);
  });

  it("cuts a PAID video piece's preview from its file", async () => {
    const full = await fullFile('video/mp4', syntheticMp4(100));
    const res = await post(
      listing({
        contentType: 'video',
        fullAsset: full.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(res.status).toBe(201);
    const key = objectKeyFrom((await pieceRow(res)).previewAssetUrl);
    expect(key).toMatch(/\/auto-[0-9a-f]{20}\.mp4$/);
    expect(await seconds(bucket.get(key)!, 'video/mp4')).toBeCloseTo(30, 0);
  });

  it('takes the first third of a file under 45 seconds', async () => {
    const full = await fullFile('audio/wav', wavFile(30));
    const res = await post(
      listing({ fullAsset: full.fileUrl, previewFromFile: true }),
    );
    expect(res.status).toBe(201);
    const key = objectKeyFrom((await pieceRow(res)).previewAssetUrl);
    expect(await seconds(bucket.get(key)!, 'audio/wav')).toBeCloseTo(10, 1);
  });

  it("still takes the creator's own clip, unchanged, and cuts nothing", async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const clip = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(MAKER))
      .send({
        folder: 'content/preview',
        format: 'audio',
        contentType: 'audio/mpeg',
        extension: 'mp3',
        contentLength: 5000,
      });
    const own = (clip.body as { data: { key: string; fileUrl: string } }).data;
    bucket.set(own.key, Buffer.alloc(5000));
    await prisma.storageObject.update({
      where: { key: own.key },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    const res = await post(
      listing({
        fullAsset: full.fileUrl,
        previewAsset: own.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(objectKeyFrom((await pieceRow(res)).previewAssetUrl)).toBe(own.key);
    expect(puts).toEqual([]);
  });

  it("refuses a file too short to cut, in the Hub's own words, and stores nothing", async () => {
    const full = await fullFile('audio/mpeg', mp3File(2));
    const res = await post(
      listing({ fullAsset: full.fileUrl, previewFromFile: true }),
    );
    expect(res.status).toBe(400);
    expect(message(res)).toBe(CUT_WORDS.too_short);
    expect(puts).toEqual([]);
    expect(
      await prisma.contentPiece.count({ where: { creatorWawuId: MAKER } }),
    ).toBe(0);
  });

  it('refuses a paid piece that asks for no preview, and a picture that asks the Hub for its preview', async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const none = await post(listing({ fullAsset: full.fileUrl }));
    expect(none.status).toBe(400);
    expect(message(none)).toBe(NEEDS_PREVIEW);
    const picture = await fullFile(
      'image/png',
      Buffer.from('not really a png'),
    );
    const cut = await post(
      listing({
        contentType: 'image',
        fullAsset: picture.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(cut.status).toBe(400);
    expect(message(cut)).toBe(CANNOT_MAKE);
  });

  it('gives the cut back when the publish does not go through, and a retry replaces it in place (counted once)', async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const bad = await post(
      listing({ fullAsset: full.fileUrl, previewFromFile: true, price: 0 }),
    );
    expect(bad.status).toBe(400);
    expect(puts).toHaveLength(1);
    expect(await used()).toBe(mp3File(100).length); // the cut is not counted
    const good = await post(
      listing({ fullAsset: full.fileUrl, previewFromFile: true }),
    );
    expect(good.status).toBe(201);
    expect(puts[1]).toBe(puts[0]); // the same name: replaced in place
    const cutBytes = bucket.get(puts[0])!.length;
    expect(await used()).toBe(mp3File(100).length + cutBytes);
  });

  it('refuses a cut when the creator has no room for it (the storage 413)', async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    // Fill the creator's storage to 100 bytes short of its limit (a row's byte count is a 32 bit number, so in steps of 1.5 GB).
    const limit = (await storage.usageFor(MAKER)).limitBytes;
    let left = limit - (await used()) - 100;
    for (let i = 0; left > 0; i += 1) {
      const bytes = Math.min(left, 1_500_000_000);
      await prisma.storageObject.create({
        data: {
          wawuUserId: MAKER,
          key: `content/full/${MAKER}/filler-${i}.mp4`,
          bytes,
          contentType: 'video/mp4',
          folder: 'content/full',
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });
      left -= bytes;
    }
    const res = await post(
      listing({ fullAsset: full.fileUrl, previewFromFile: true }),
    );
    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
  });

  it('publishes a draft the same way: a free draft needs no preview', async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const draft = await request(server())
      .post('/product-drafts')
      .set('Authorization', bearer(MAKER))
      .send({
        title: 'A free draft',
        contentType: 'audio',
        description: 'Free audio',
        category: 'business_entrepreneurship',
        accessType: 'free',
        price: 0,
      });
    expect(draft.status).toBe(201);
    const id = (draft.body as { data: { id: string } }).data.id;
    const res = await request(server())
      .post(`/product-drafts/${id}/publish`)
      .set('Authorization', bearer(MAKER))
      .send({ fullAsset: full.fileUrl });
    expect(res.status).toBe(201);
    expect(objectKeyFrom((await pieceRow(res)).previewAssetUrl)).toBe(full.key);
  });

  // ── R-118 for the other kinds ─────────────────────────────────────────────

  it("makes a PAID PDF piece's preview from its first 3 pages (counted from the stored preview), counted once", async () => {
    const whole = await pdfFile(12, { pad: 30_000 });
    const full = await fullFile('application/pdf', whole);
    const res = await post(
      listing({
        contentType: 'pdf',
        fullAsset: full.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(res.status).toBe(201);
    const key = objectKeyFrom((await pieceRow(res)).previewAssetUrl);
    expect(key).toMatch(
      new RegExp(`^content/preview/${MAKER}/auto-[0-9a-f]{20}\\.pdf$`),
    );
    expect(puts).toEqual([key]);
    const stored = bucket.get(key)!;
    expect(await pdfPageCount(stored)).toBe(3);
    expect(stored.length).toBeLessThan(whole.length / 2);
    const row = await prisma.storageObject.findUniqueOrThrow({
      where: { key },
    });
    expect(row).toMatchObject({
      status: 'confirmed',
      folder: 'content/preview',
      contentType: 'application/pdf',
    });
    expect(await used()).toBe(whole.length + stored.length);
  });

  it('takes the first page of a PDF under 6 pages, and refuses a one page PDF and a locked one in words', async () => {
    const short = await fullFile('application/pdf', await pdfFile(4));
    const ok = await post(
      listing({
        contentType: 'pdf',
        fullAsset: short.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(ok.status).toBe(201);
    expect(
      await pdfPageCount(
        bucket.get(objectKeyFrom((await pieceRow(ok)).previewAssetUrl))!,
      ),
    ).toBe(1);
    puts = [];
    const one = await fullFile('application/pdf', await pdfFile(1));
    const refused = await post(
      listing({
        contentType: 'pdf',
        fullAsset: one.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(refused.status).toBe(400);
    expect(message(refused)).toBe(CUT_WORDS.single_page);
    const locked = await fullFile(
      'application/pdf',
      await pdfFile(9, { locked: true }),
    );
    const lockedRes = await post(
      listing({
        contentType: 'pdf',
        fullAsset: locked.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(lockedRes.status).toBe(400);
    expect(message(lockedRes)).toBe(CUT_WORDS.locked);
    expect(puts).toEqual([]);
  });

  it("cuts a PAID course's preview from its FIRST LESSON when that is a video", async () => {
    const lesson = await fullFile('video/mp4', syntheticMp4(100));
    const res = await post(
      listing({
        contentType: 'course',
        fullAsset: lesson.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(res.status).toBe(201);
    const key = objectKeyFrom((await pieceRow(res)).previewAssetUrl);
    expect(key).toMatch(/\/auto-[0-9a-f]{20}\.mp4$/);
    expect(await seconds(bucket.get(key)!, 'video/mp4')).toBeCloseTo(30, 0);
    expect(await used()).toBe(
      syntheticMp4(100).length + bucket.get(key)!.length,
    );
  });

  it("makes a course's preview from its cover when the first lesson is not a video, and a template's from its cover; each is a copy of its own, counted once", async () => {
    const cover = await landed(
      'content/cover',
      'image/png',
      Buffer.from('89504e470d0a1a0a-cover-bytes', 'utf8'),
    );
    const doc = await fullFile('application/pdf', await pdfFile(9));
    const course = await post(
      listing({
        contentType: 'course',
        fullAsset: doc.fileUrl,
        coverAsset: cover.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(course.status).toBe(201);
    const key = objectKeyFrom((await pieceRow(course)).previewAssetUrl);
    expect(key).toMatch(
      new RegExp(`^content/preview/${MAKER}/auto-[0-9a-f]{20}\\.png$`),
    );
    expect(key).not.toBe(cover.key);
    expect(bucket.get(key)!.equals(bucket.get(cover.key)!)).toBe(true);
    const sheet = await fullFile(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.alloc(5000, 7),
    );
    const template = await post(
      listing({
        contentType: 'template',
        fullAsset: sheet.fileUrl,
        coverAsset: cover.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(template.status).toBe(201);
    const tKey = objectKeyFrom((await pieceRow(template)).previewAssetUrl);
    expect(tKey).toBe(key); // the same name for the same cover: replaced in place, never counted twice
    const previews = await prisma.storageObject.count({
      where: {
        wawuUserId: MAKER,
        folder: 'content/preview',
        status: 'confirmed',
      },
    });
    expect(previews).toBe(1);
  });

  it('asks for a cover, in words, when a template or a course of documents has none', async () => {
    const sheet = await fullFile(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.alloc(5000, 7),
    );
    const template = await post(
      listing({
        contentType: 'template',
        fullAsset: sheet.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(template.status).toBe(400);
    expect(message(template)).toBe(NEEDS_COVER);
    const doc = await fullFile('application/pdf', await pdfFile(9));
    const course = await post(
      listing({
        contentType: 'course',
        fullAsset: doc.fileUrl,
        previewFromFile: true,
      }),
    );
    expect(course.status).toBe(400);
    expect(message(course)).toBe(NEEDS_COVER);
    expect(puts).toEqual([]);
  });

  it("a picture's own smaller copy is used as sent, and a FREE picture needs none", async () => {
    const full = await fullFile('image/png', Buffer.alloc(9000, 3));
    const small = await landed(
      'content/preview',
      'image/jpeg',
      Buffer.alloc(900, 4),
    );
    const paid = await post(
      listing({
        contentType: 'image',
        fullAsset: full.fileUrl,
        previewAsset: small.fileUrl,
      }),
    );
    expect(paid.status).toBe(201);
    expect(objectKeyFrom((await pieceRow(paid)).previewAssetUrl)).toBe(
      small.key,
    );
    const free = await post(
      listing({
        contentType: 'image',
        accessType: 'free',
        price: 0,
        fullAsset: full.fileUrl,
      }),
    );
    expect(free.status).toBe(201);
    expect(objectKeyFrom((await pieceRow(free)).previewAssetUrl)).toBe(
      full.key,
    );
  });

  // ── UPLOAD-REST: a free piece edited to paid needs no separate preview either (R-118) ─────────────────────────

  const patch = (id: string, body: Record<string, unknown>) =>
    request(server())
      .patch(`/content/${id}`)
      .set('Authorization', bearer(MAKER))
      .set(APP)
      .send(body);
  const pieceOf = (res: request.Response) =>
    (res.body as { data: Piece }).data.id;
  const freeAudio = async () => {
    const full = await fullFile('audio/mpeg', mp3File(100));
    const made = await post(
      listing({ accessType: 'free', price: 0, fullAsset: full.fileUrl }),
    );
    expect(made.status).toBe(201);
    return { full, id: pieceOf(made) };
  };

  it("an edit to paid with previewFromFile cuts a free audio piece's preview from its stored file, counted once", async () => {
    const { full, id } = await freeAudio();
    const before = await used();
    const res = await patch(id, {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(res.status).toBe(200);
    const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id } });
    expect(row.accessType).toBe('paid');
    expect(row.price).toBe(2000);
    const key = objectKeyFrom(row.previewAssetUrl);
    expect(key).toMatch(
      new RegExp(`^content/preview/${MAKER}/auto-[0-9a-f]{20}\\.mp3$`),
    );
    expect(key).not.toBe(full.key);
    expect(await seconds(bucket.get(key)!, 'audio/mpeg')).toBeCloseTo(30, 0);
    expect(await used()).toBe(before + bucket.get(key)!.length);
    // Saved again (a retry, or a new price): the piece has a preview of its own now, so nothing more is made or counted.
    const again = await patch(id, {
      price: 2500,
      previewFromFile: true,
    });
    expect(again.status).toBe(200);
    expect(puts).toHaveLength(1);
    expect(await used()).toBe(before + bucket.get(key)!.length);
  });

  it('refuses the same edit without the flag exactly as before, and ignores the flag while the piece stays free', async () => {
    const { id } = await freeAudio();
    const plain = await patch(id, { accessType: 'paid', price: 2000 });
    expect(plain.status).toBe(400);
    expect(message(plain)).toContain(
      'Paid content needs a separate free preview',
    );
    const stillFree = await patch(id, {
      title: 'A new title',
      previewFromFile: true,
    });
    expect(stillFree.status).toBe(200);
    expect(puts).toEqual([]);
    const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id } });
    expect(row.accessType).toBe('free');
    expect(objectKeyFrom(row.previewAssetUrl)).toBe(
      objectKeyFrom(row.fullAssetUrl!),
    );
  });

  it("makes a free PDF's preview on an edit to paid (3 pages), and refuses a picture and a file too short in the Hub's words, storing nothing", async () => {
    const pdf = await fullFile('application/pdf', await pdfFile(9));
    const made = await post(
      listing({
        contentType: 'pdf',
        accessType: 'free',
        price: 0,
        fullAsset: pdf.fileUrl,
      }),
    );
    const res = await patch(pieceOf(made), {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(res.status).toBe(200);
    const row = await pieceRow(made);
    const key = objectKeyFrom(row.previewAssetUrl);
    expect(key).toMatch(/\/auto-[0-9a-f]{20}\.pdf$/);
    expect(await pdfPageCount(bucket.get(key)!)).toBe(3);

    const png = await fullFile('image/png', Buffer.alloc(9000, 3));
    const picture = await post(
      listing({
        contentType: 'image',
        accessType: 'free',
        price: 0,
        fullAsset: png.fileUrl,
      }),
    );
    const putsBefore = puts.length;
    const refused = await patch(pieceOf(picture), {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(refused.status).toBe(400);
    expect(message(refused)).toBe(CANNOT_MAKE);
    expect(puts).toHaveLength(putsBefore);
    expect((await pieceRow(picture)).accessType).toBe('free');

    const short = await fullFile('audio/mpeg', mp3File(2));
    const tiny = await post(
      listing({ accessType: 'free', price: 0, fullAsset: short.fileUrl }),
    );
    const tooShort = await patch(pieceOf(tiny), {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(tooShort.status).toBe(400);
    expect(message(tooShort)).toBe(CUT_WORDS.too_short);
    expect((await pieceRow(tiny)).accessType).toBe('free');
  });

  it('makes a template preview from its cover on an edit, and asks for a cover in words when it has none', async () => {
    const sheet = await fullFile(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.alloc(5000, 7),
    );
    const bare = await post(
      listing({
        contentType: 'template',
        accessType: 'free',
        price: 0,
        fullAsset: sheet.fileUrl,
      }),
    );
    const needsCover = await patch(pieceOf(bare), {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(needsCover.status).toBe(400);
    expect(message(needsCover)).toBe(NEEDS_COVER);
    const cover = await landed(
      'content/cover',
      'image/png',
      Buffer.from('89504e470d0a1a0a-cover-bytes', 'utf8'),
    );
    const withCover = await patch(pieceOf(bare), {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
      coverAsset: cover.fileUrl,
    });
    expect(withCover.status).toBe(200);
    const key = objectKeyFrom((await pieceRow(bare)).previewAssetUrl);
    expect(key).not.toBe(cover.key);
    expect(bucket.get(key)!.equals(bucket.get(cover.key)!)).toBe(true);
  });

  it('gives the cut back when the edit does not go through (counted once, nothing left over)', async () => {
    const { id } = await freeAudio();
    const before = await used();
    const missingCover = `https://bucket.example-storage.dev/content/cover/${MAKER}/${crypto.randomUUID()}.png`;
    const bad = await patch(id, {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
      coverAsset: missingCover,
    });
    expect(bad.status).toBe(400);
    expect(puts).toHaveLength(1); // it was cut, then the edit was refused
    expect(await used()).toBe(before); // and given back
    const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id } });
    expect(row.accessType).toBe('free');
    const good = await patch(id, {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(good.status).toBe(200);
    expect(puts[1]).toBe(puts[0]); // the same name: replaced in place
    expect(await used()).toBe(before + bucket.get(puts[0])!.length);
  });

  it('refuses the cut when the creator has no room for it (the storage 413) and the piece stays free', async () => {
    const { id } = await freeAudio();
    const limit = (await storage.usageFor(MAKER)).limitBytes;
    let left = limit - (await used()) - 100;
    for (let i = 0; left > 0; i += 1) {
      const bytes = Math.min(left, 1_500_000_000);
      await prisma.storageObject.create({
        data: {
          wawuUserId: MAKER,
          key: `content/full/${MAKER}/filler-edit-${i}.mp4`,
          bytes,
          contentType: 'video/mp4',
          folder: 'content/full',
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });
      left -= bytes;
    }
    const res = await patch(id, {
      accessType: 'paid',
      price: 2000,
      previewFromFile: true,
    });
    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
    expect(
      (await prisma.contentPiece.findUniqueOrThrow({ where: { id } }))
        .accessType,
    ).toBe('free');
  });
});

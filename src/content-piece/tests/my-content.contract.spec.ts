import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece.module';

/**
 * ME-09: a creator can edit a piece while it waits, see why it was rejected,
 * send it again, and see sales per piece (M25, M26, M28).
 *
 * Runs against real Postgres and the mock WAWU ID, like the other content
 * contract suite. Every fixture carries the `ME09 ` title prefix and is
 * removed in afterAll, and the owner's CreatorState is put back as found.
 */
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000003'; // creator-pro
const OTHER_CREATOR = '00000000-0000-4000-8000-000000000002'; // creator-basic
const NO_SUCH_ID = 'ffffffff-0000-4000-8000-0000000000aa';
const PREFIX = 'ME09 ';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

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

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('My content: edit, send again, reason, sales (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let ownedMock = false;
  let ownerToken: string;
  let otherToken: string;
  let plainToken: string;
  let ownerState: { slotsUsed: number } | null = null;
  let seq = 0;

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => `Bearer ${token}`;

  async function piece(
    status: 'pending' | 'live' | 'rejected',
    over: Record<string, unknown> = {},
  ) {
    seq += 1;
    return prisma.contentPiece.create({
      data: {
        slug: `me09-${Date.now()}-${seq}`,
        creatorWawuId: OWNER,
        contentType: 'video',
        title: `${PREFIX}piece ${seq}`,
        description: 'A description',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 2500,
        previewAssetUrl: 'https://cdn.example.com/p.jpg',
        fullAssetUrl: 'https://cdn.example.com/f.mp4',
        status,
        ...over,
      },
    });
  }

  async function reject(contentId: string, reason: string, at: Date) {
    await prisma.adminContentReview.create({
      data: {
        contentId,
        creatorWawuId: OWNER,
        decision: 'rejected',
        previousStatus: 'pending',
        newStatus: 'rejected',
        reason,
        slotReturned: true,
        reviewedByAdminId: 'admin-secret-id',
        reviewedByAdminEmail: 'reviewer-secret@wawu.test',
        reviewedByAdminRole: 'superadmin',
        reviewedAt: at,
      },
    });
  }

  async function slots(): Promise<number> {
    const s = await prisma.creatorState.findUnique({
      where: { wawuUserId: OWNER },
    });
    return s?.slotsUsed ?? 0;
  }

  async function setSlots(n: number) {
    await prisma.creatorState.upsert({
      where: { wawuUserId: OWNER },
      create: { wawuUserId: OWNER, slotsUsed: n },
      update: { slotsUsed: n },
    });
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ownerToken = await login('creator-pro@test.wawu.dev');
    otherToken = await login('creator-basic@test.wawu.dev');
    plainToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        ContentPieceModule,
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
    ownerState = await prisma.creatorState.findUnique({
      where: { wawuUserId: OWNER },
      select: { slotsUsed: true },
    });
  }, 30000);

  afterEach(async () => {
    const mine = await prisma.contentPiece.findMany({
      where: { title: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = mine.map((m) => m.id);
    await prisma.purchase.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.adminContentReview.deleteMany({
      where: { contentId: { in: ids } },
    });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    if (ownerState) await setSlots(ownerState.slotsUsed);
  });

  afterAll(async () => {
    await app?.close();
    if (ownedMock && mock) mock.kill();
  });

  describe('GET /content/mine/library', () => {
    it('a creator can see how many sales each piece has, counting only completed purchases', async () => {
      const sold = await piece('live');
      const unsold = await piece('live');
      const buy = (n: number, status: 'completed' | 'pending' | 'failed') =>
        prisma.purchase.create({
          data: {
            contentId: sold.id,
            type: 'content',
            buyerWawuId: USER_PLAIN,
            creatorWawuId: OWNER,
            amount: 2500,
            commissionRate: 0.15,
            flutterwaveTxRef: `me09-tx-${sold.id}-${n}`,
            status,
          },
        });
      await buy(1, 'completed');
      await buy(2, 'completed');
      await buy(3, 'pending');
      await buy(4, 'failed');

      const res = await request(server())
        .get('/content/mine/library')
        .set('Authorization', as(ownerToken))
        .expect(200);
      const items = res.body.data as {
        id: string;
        salesCount: number;
      }[];
      expect(items.find((i) => i.id === sold.id)?.salesCount).toBe(2);
      expect(items.find((i) => i.id === unsold.id)?.salesCount).toBe(0);
    });

    it('a creator can see why a piece was rejected, the newest reason when it was rejected twice', async () => {
      const p = await piece('rejected');
      await reject(
        p.id,
        'Old reason from the first review.',
        new Date('2026-09-01'),
      );
      await reject(
        p.id,
        'Charts on pages 22 to 24 came from another publisher.',
        new Date('2026-09-20'),
      );

      const res = await request(server())
        .get('/content/mine/library?status=rejected')
        .set('Authorization', as(ownerToken))
        .expect(200);
      const row = (
        res.body.data as {
          id: string;
          rejectionReason: string | null;
          rejectedAt: string | null;
        }[]
      ).find((i) => i.id === p.id);
      expect(row?.rejectionReason).toBe(
        'Charts on pages 22 to 24 came from another publisher.',
      );
      expect(row?.rejectedAt).toBe('2026-09-20T00:00:00.000Z');
    });

    it('the reviewer is never named to the creator', async () => {
      const p = await piece('rejected');
      await reject(p.id, 'Blurry preview.', new Date('2026-09-20'));
      const res = await request(server())
        .get(`/content/mine/library/${p.id}`)
        .set('Authorization', as(ownerToken))
        .expect(200);
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain('admin-secret-id');
      expect(wire).not.toContain('reviewer-secret@wawu.test');
      expect(wire).not.toContain('superadmin');
    });

    it('a creator can filter to one status, and a piece they deleted is gone', async () => {
      const live = await piece('live');
      const waiting = await piece('pending');
      const gone = await piece('live');
      await prisma.contentPiece.update({
        where: { id: gone.id },
        data: { status: 'removed' },
      });

      const get = async (q: string) =>
        (
          (
            await request(server())
              .get(`/content/mine/library${q}`)
              .set('Authorization', as(ownerToken))
              .expect(200)
          ).body.data as { id: string }[]
        ).map((i) => i.id);

      expect(await get('?status=pending')).toContain(waiting.id);
      expect(await get('?status=pending')).not.toContain(live.id);
      expect(await get('?status=live')).toContain(live.id);
      const all = await get('');
      expect(all).toEqual(expect.arrayContaining([live.id, waiting.id]));
      expect(all).not.toContain(gone.id);
    });

    it('a creator can read the tab counts, matching what the list holds', async () => {
      const before = (
        await request(server())
          .get('/content/mine/library/counts')
          .set('Authorization', as(ownerToken))
          .expect(200)
      ).body.data as Record<string, number>;
      await piece('live');
      await piece('pending');
      await piece('pending');
      await piece('rejected');
      const after = (
        await request(server())
          .get('/content/mine/library/counts')
          .set('Authorization', as(ownerToken))
          .expect(200)
      ).body.data as Record<string, number>;
      expect(after.live - before.live).toBe(1);
      expect(after.pending - before.pending).toBe(2);
      expect(after.rejected - before.rejected).toBe(1);
      expect(after.all).toBe(after.live + after.pending + after.rejected);
    });

    it('a creator can open one of their own pieces, and a piece id in the wrong format is refused', async () => {
      const p = await piece('pending');
      const ok = await request(server())
        .get(`/content/mine/library/${p.id}`)
        .set('Authorization', as(ownerToken))
        .expect(200);
      expect((ok.body.data as { id: string }).id).toBe(p.id);
      await request(server())
        .get('/content/mine/library/0801234567')
        .set('Authorization', as(ownerToken))
        .expect(400);
      await request(server())
        .get(`/content/mine/library/${NO_SUCH_ID}`)
        .set('Authorization', as(ownerToken))
        .expect(404);
    });

    it("another creator cannot read someone else's piece, and an account that is not a creator cannot read the library", async () => {
      const p = await piece('rejected');
      await request(server())
        .get(`/content/mine/library/${p.id}`)
        .set('Authorization', as(otherToken))
        .expect(403);
      await request(server())
        .get('/content/mine/library')
        .set('Authorization', as(plainToken))
        .expect(403);
      await request(server()).get('/content/mine/library').expect(401);
    });
  });

  describe('PATCH /content/:id', () => {
    it('a creator can edit the details of a piece that is waiting, and it stays in review', async () => {
      const p = await piece('pending');
      const res = await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(ownerToken))
        .send({ title: `${PREFIX}renamed`, price: 3000, tags: ['a', 'b'] })
        .expect(200);
      const body = res.body.data as {
        title: string;
        price: number;
        status: string;
        slug: string;
      };
      expect(body).toMatchObject({
        title: `${PREFIX}renamed`,
        price: 3000,
        status: 'pending',
        slug: p.slug,
      });
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.price).toBe(3000);
      expect(row.tags).toEqual(['a', 'b']);
    });

    it('a creator can replace the file of a rejected piece, and it stays rejected until they send it again', async () => {
      const p = await piece('rejected');
      await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(ownerToken))
        .send({ fullAsset: 'https://cdn.example.com/f2.mp4' })
        .expect(200);
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.fullAssetUrl).toBe('https://cdn.example.com/f2.mp4');
      expect(row.status).toBe('rejected');
    });

    it('a creator can switch a waiting piece to free without typing a price', async () => {
      const p = await piece('pending');
      await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(ownerToken))
        .send({ accessType: 'free' })
        .expect(200);
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect([row.accessType, row.price]).toEqual(['free', 0]);
    });

    it('a creator cannot edit a live piece', async () => {
      const p = await piece('live');
      await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(ownerToken))
        .send({ title: `${PREFIX}sneaky` })
        .expect(409);
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.title).not.toBe(`${PREFIX}sneaky`);
    });

    it('a creator cannot move their own piece to live, or change its type, through an edit', async () => {
      const p = await piece('pending');
      for (const body of [
        { status: 'live' },
        { contentType: 'pdf' },
        { views: 99999 },
      ]) {
        await request(server())
          .patch(`/content/${p.id}`)
          .set('Authorization', as(ownerToken))
          .send(body)
          .expect(400);
      }
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect([row.status, row.contentType, row.views]).toEqual([
        'pending',
        'video',
        0,
      ]);
    });

    it('an edit that would break the price rules is refused, whichever fields it sends', async () => {
      const p = await piece('pending');
      const patch = (body: object) =>
        request(server())
          .patch(`/content/${p.id}`)
          .set('Authorization', as(ownerToken))
          .send(body);
      await patch({ price: 0 }).expect(400); // paid at 0
      await patch({ accessType: 'free', price: 100 }).expect(400); // free at 100
      await patch({ previewAsset: 'https://cdn.example.com/f.mp4' }).expect(
        400,
      ); // preview is the paid file
      await patch({}).expect(400); // nothing to change
      await patch({ price: -5 }).expect(400);
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect([row.price, row.accessType]).toEqual([2500, 'paid']);
    });

    it("another creator cannot edit someone else's piece, and a missing piece is 404", async () => {
      const p = await piece('pending');
      await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(otherToken))
        .send({ title: `${PREFIX}hijack` })
        .expect(403);
      await request(server())
        .patch(`/content/${NO_SUCH_ID}`)
        .set('Authorization', as(ownerToken))
        .send({ title: `${PREFIX}x` })
        .expect(404);
      await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(plainToken))
        .send({ title: `${PREFIX}x` })
        .expect(403);
    });
  });

  describe('POST /content/:id/resubmit', () => {
    it('a creator can send a rejected piece again: it goes back to review, takes a slot, and the old reason stops showing', async () => {
      await setSlots(2);
      const p = await piece('rejected');
      await reject(p.id, 'Replace the charts.', new Date('2026-09-20'));

      const res = await request(server())
        .post(`/content/${p.id}/resubmit`)
        .set('Authorization', as(ownerToken))
        .expect(200);
      const body = res.body.data as {
        status: string;
        rejectionReason: string | null;
      };
      expect(body.status).toBe('pending');
      expect(body.rejectionReason).toBeNull();
      expect(await slots()).toBe(3);
    });

    it('pressing Send again twice takes one slot, not two', async () => {
      await setSlots(2);
      const p = await piece('rejected');
      const send = () =>
        request(server())
          .post(`/content/${p.id}/resubmit`)
          .set('Authorization', as(ownerToken));
      await send().expect(200);
      await send().expect(200);
      expect(await slots()).toBe(3);
    });

    it('two Send again taps at the same moment take one slot', async () => {
      await setSlots(2);
      const p = await piece('rejected');
      const send = () =>
        request(server())
          .post(`/content/${p.id}/resubmit`)
          .set('Authorization', as(ownerToken));
      const results = await Promise.all([send(), send()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
      expect(await slots()).toBe(3);
    });

    it('a creator with every slot used is told so, and the piece stays rejected', async () => {
      await setSlots(25);
      const p = await piece('rejected');
      const res = await request(server())
        .post(`/content/${p.id}/resubmit`)
        .set('Authorization', as(ownerToken))
        .expect(403);
      expect(JSON.stringify(res.body)).toContain('upload_limit_reached');
      const row = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row.status).toBe('rejected');
      expect(await slots()).toBe(25);
    });

    it("a creator cannot send a live piece again, and cannot send someone else's", async () => {
      const live = await piece('live');
      await request(server())
        .post(`/content/${live.id}/resubmit`)
        .set('Authorization', as(ownerToken))
        .expect(409);
      const rejected = await piece('rejected');
      await request(server())
        .post(`/content/${rejected.id}/resubmit`)
        .set('Authorization', as(otherToken))
        .expect(403);
      await request(server())
        .post(`/content/${rejected.id}/resubmit`)
        .set('Authorization', as(plainToken))
        .expect(403);
      await request(server())
        .post(`/content/${NO_SUCH_ID}/resubmit`)
        .set('Authorization', as(ownerToken))
        .expect(404);
    });

    it('a creator can fix a rejected piece and send it again, then see it in the In review tab', async () => {
      await setSlots(1);
      const p = await piece('rejected');
      await request(server())
        .patch(`/content/${p.id}`)
        .set('Authorization', as(ownerToken))
        .send({ description: 'Charts replaced and sourced.' })
        .expect(200);
      await request(server())
        .post(`/content/${p.id}/resubmit`)
        .set('Authorization', as(ownerToken))
        .expect(200);
      const list = await request(server())
        .get('/content/mine/library?status=pending')
        .set('Authorization', as(ownerToken))
        .expect(200);
      const row = (
        list.body.data as { id: string; description: string }[]
      ).find((i) => i.id === p.id);
      expect(row?.description).toBe('Charts replaced and sourced.');
    });
  });
});

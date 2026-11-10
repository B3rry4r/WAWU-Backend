/* eslint-disable */
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AccountPurgeModule } from '../../account-purge/account-purge.module';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MeModule } from '../../me/me.module';
import { MePurchasesService } from '../../me/me-purchases.service';
import { ContentPieceModule } from '../content-piece.module';
import { ContentPieceService } from '../content-piece.service';
import { ContentDetailService } from '../content-detail.service';
import { ContentEngagementService } from '../content-engagement.service';
import { ContentMediaService } from '../content-media.service';
import { CourseLessonsService } from '../course-lessons.service';
import { StorageService } from '../../storage/storage.service';
import { AdminContentReviewService } from '../../admin/content-review/admin-content-review.service';
import { hiddenByDeletion } from '../deletion-hid';

/**
 * CREATOR-TAKEDOWN (R-130, owner, 10 Nov 2026): a piece its creator took down
 * (DELETE /content/:id) stays with everyone who paid for it: it opens and
 * plays for them (detail, media, lessons, the piece itself, My purchases, save,
 * rate) and is gone for everyone else. A piece an admin removed is not the
 * buyers', as it never was.
 */
describe('CREATOR-TAKEDOWN: buyers keep a piece its creator took down', () => {
  jest.setTimeout(120000);
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
  let prisma: PrismaService;
  let content: ContentPieceService;
  let detail: ContentDetailService;
  let media: ContentMediaService;
  let engagement: ContentEngagementService;
  let lessons: CourseLessonsService;
  let mine: MePurchasesService;
  let purge: AccountPurgeService;
  const made = { pieces: [] as string[], people: [] as string[] };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, ContentPieceModule, MeModule, AccountPurgeModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    content = moduleRef.get(ContentPieceService);
    detail = moduleRef.get(ContentDetailService, { strict: false });
    media = moduleRef.get(ContentMediaService, { strict: false });
    engagement = moduleRef.get(ContentEngagementService, { strict: false });
    lessons = moduleRef.get(CourseLessonsService, { strict: false });
    mine = moduleRef.get(MePurchasesService, { strict: false });
    purge = moduleRef.get(AccountPurgeService);
    // No object store here: the link is the only thing stood in; every visibility rule before it is real.
    jest.spyOn(moduleRef.get(StorageService, { strict: false }), 'readUrlFor').mockResolvedValue('https://store.example.invalid/lesson');
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = made.pieces;
    await prisma.savedItem.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.contentRating.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.purchase.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.courseLesson.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    await prisma.storageObject.deleteMany({ where: { key: { startsWith: 'content/ctd-' } } });
    await prisma.creatorState.deleteMany({ where: { wawuUserId: { in: made.people } } });
    await moduleRef?.close();
  });

  const gone = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundException);

  async function world(type: 'course' | 'video' = 'course') {
    const creator = randomUUID();
    made.people.push(creator);
    const buyer = randomUUID();
    const pendingBuyer = randomUUID();
    const outsider = randomUUID();
    const tag = creator.slice(0, 8);
    await prisma.creatorState.create({ data: { wawuUserId: creator, slotsUsed: 3 } });
    const mk = async (name: string, status: 'live' | 'pending' = 'live') => {
      const id = randomUUID();
      made.pieces.push(id);
      const preview = `content/ctd-${tag}-${name}-preview.jpg`;
      const full = `content/ctd-${tag}-${name}-full.mp4`;
      const p = await prisma.contentPiece.create({
        data: {
          id, slug: `ctd-${tag}-${name}`, creatorWawuId: creator, contentType: type,
          title: `${name} piece`, description: 'A full piece.', category: 'beauty', tags: ['makeup'],
          specializations: [], accessType: 'paid', price: 500000, previewAssetUrl: preview, fullAssetUrl: full, status,
        },
      });
      for (const k of [preview, full]) {
        await prisma.storageObject.create({
          data: { wawuUserId: creator, key: k, bytes: 1000, contentType: 'video/mp4', folder: 'content', status: 'confirmed', confirmedAt: new Date() },
        });
      }
      return p;
    };
    const buy = (pieceId: string, status: 'completed' | 'pending' | 'failed', who: string, kind: 'content' | 'tip' = 'content') =>
      prisma.purchase.create({
        data: {
          contentId: pieceId, type: kind, buyerWawuId: who, creatorWawuId: creator, amount: 500000,
          commissionRate: '0.1500', flutterwaveTxRef: `ctd-${randomUUID()}`, status,
        },
      });
    const sold = await mk('sold');
    await buy(sold.id, 'completed', buyer);
    await buy(sold.id, 'pending', pendingBuyer);
    return { creator, buyer, pendingBuyer, outsider, sold, mk, buy };
  }

  it('the creator takes a sold course down: the buyer still opens the piece, its detail, media and a lesson; nobody else does', async () => {
    const w = await world('course');
    const lesson = await prisma.courseLesson.create({
      data: { contentId: w.sold.id, title: 'One', order: 1, assetKey: `content/ctd-${w.creator.slice(0, 8)}-sold-full.mp4` },
    });
    expect((await content.findOne(w.sold.id, w.buyer)).id).toBe(w.sold.id); // before: as ever

    await content.delete(w.sold.id, w.creator);
    const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.sold.id } });
    expect(row.status).toBe('removed');
    expect(row.ownerRemovedAt).toBeInstanceOf(Date);

    const opened = await content.findOne(w.sold.id, w.buyer);
    expect(opened.fullAssetUrl).toBeTruthy(); // the whole file, not the locked view
    expect((await detail.detail(w.sold.id, w.buyer)).contentId).toBe(w.sold.id);
    expect((await media.get(w.sold.id, w.buyer)).contentId).toBe(w.sold.id);
    expect((await engagement.engagement(w.sold.id, w.buyer)).likes).toBe(0);
    expect((await lessons.play(w.sold.id, lesson.id, w.buyer)).url).toBeTruthy();

    for (const who of [w.outsider, w.pendingBuyer, undefined]) {
      await gone(content.findOne(w.sold.id, who));
      if (who) {
        await gone(detail.detail(w.sold.id, who));
        await gone(media.get(w.sold.id, who));
        await gone(engagement.engagement(w.sold.id, who));
        await gone(lessons.play(w.sold.id, lesson.id, who));
      }
    }
    await gone(content.findOne(w.sold.id, w.creator)); // removed is gone for the owner too
    await gone(detail.detail(w.sold.id, w.creator));
  });

  it('it is in the buyer\'s My purchases, and off the creator\'s shelf, the feed and sale', async () => {
    const w = await world('video');
    await content.delete(w.sold.id, w.creator);
    const page = await mine.list(w.buyer, undefined, undefined, 20);
    expect(page.items.map((i: any) => i.content.id)).toContain(w.sold.id);
    expect(await mine.count(w.buyer)).toBe(1);
    const shelf = await content.list(w.creator, 'mine', undefined, 1, 50);
    expect(shelf.items.map((p: any) => p.id)).not.toContain(w.sold.id);
    const feed = await content.list(w.outsider, 'feed', undefined, 1, 50);
    expect(feed.items.map((p: any) => p.id)).not.toContain(w.sold.id);
    expect(await prisma.contentPiece.count({ where: { id: w.sold.id, status: 'live' } })).toBe(0);
  });

  it('a non-buyer cannot save or rate it; the buyer can', async () => {
    const w = await world('video');
    await content.delete(w.sold.id, w.creator);
    await gone(content.save(w.sold.id, w.outsider));
    await gone(content.save(w.sold.id, w.pendingBuyer));
    await expect(content.save(w.sold.id, w.buyer)).resolves.toBeTruthy();
  });

  it('a failed or tip purchase does not open it; a piece nobody bought is gone for all', async () => {
    const w = await world('video');
    const failedBuyer = randomUUID();
    const tipper = randomUUID();
    await w.buy(w.sold.id, 'failed', failedBuyer);
    await w.buy(w.sold.id, 'completed', tipper, 'tip');
    const unsold = await w.mk('unsold');
    await content.delete(w.sold.id, w.creator);
    await content.delete(unsold.id, w.creator);
    await gone(content.findOne(w.sold.id, failedBuyer));
    await gone(content.findOne(w.sold.id, tipper));
    await gone(content.findOne(unsold.id, w.buyer));
  });

  it('a piece in review is taken down the same way, and the place is freed once', async () => {
    const w = await world('video');
    const waiting = await w.mk('waiting', 'pending');
    await w.buy(waiting.id, 'completed', w.buyer); // cannot happen in life; shows the flag, not the status, decides
    await content.delete(waiting.id, w.creator);
    const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(row.status).toBe('removed');
    expect(row.ownerRemovedAt).toBeInstanceOf(Date);
    const before = (await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: w.creator } })).slotsUsed;
    expect(before).toBe(2);
    await gone(content.delete(waiting.id, w.creator)); // a repeat frees nothing
    expect((await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: w.creator } })).slotsUsed).toBe(2);
  });

  it('a piece an admin removed (no owner flag) is still gone for its buyer', async () => {
    const w = await world('video');
    await prisma.contentPiece.update({ where: { id: w.sold.id }, data: { status: 'removed' } });
    await gone(content.findOne(w.sold.id, w.buyer));
    await gone(detail.detail(w.sold.id, w.buyer));
    await gone(media.get(w.sold.id, w.buyer));
    expect(
      await hiddenByDeletion(prisma, { id: w.sold.id, status: 'removed', creatorWawuId: w.creator }),
    ).toBe(false);
  });

  it('hiddenByDeletion reads the flag itself when the caller did not select it', async () => {
    const w = await world('video');
    await content.delete(w.sold.id, w.creator);
    expect(
      await hiddenByDeletion(prisma, { id: w.sold.id, status: 'removed', creatorWawuId: w.creator }),
    ).toBe(true);
  });

  it('a later deletion of the creator\'s account keeps the taken-down piece for its buyers', async () => {
    const w = await world('video');
    await content.delete(w.sold.id, w.creator);
    const found = await (purge as any).findSoldContent(w.creator);
    expect(found.ids).toContain(w.sold.id);
    expect(found.stripIds).not.toContain(w.sold.id);
  });

  it('an admin can still remove a piece its creator took down: the buyer is then shut out, the place is not returned twice, and a second removal is refused as before', async () => {
    const w = await world('video');
    await content.delete(w.sold.id, w.creator);
    await expect(content.findOne(w.sold.id, w.buyer)).resolves.toBeTruthy();
    const slots = async () => (await prisma.creatorState.findUniqueOrThrow({ where: { wawuUserId: w.creator } })).slotsUsed;
    const before = await slots();
    const admin = { id: randomUUID(), email: 'ct@admin.test.wawu.dev', name: 'CT', role: 'superadmin', status: 'active', lastLoginAt: null, createdAt: new Date() } as never;
    const stub = { signedUrlFor: async () => null, readUrlFor: async (k: string) => k, coverUrlFor: async () => null } as never;
    const service = new AdminContentReviewService(prisma, {} as never, stub, {} as never);
    jest.spyOn(service as any, 'toDetail').mockResolvedValue({} as never);
    const out = await service.takeDown(w.sold.id, { reason: 'Breaks the rules.' }, admin);
    expect(out.review.decision).toBe('removed');
    expect(out.review.slotReturned).toBe(false);
    expect(await slots()).toBe(before);
    const row = await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.sold.id } });
    expect(row.status).toBe('removed');
    expect(row.ownerRemovedAt).toBeNull();
    await gone(content.findOne(w.sold.id, w.buyer));
    await gone(detail.detail(w.sold.id, w.buyer));
    await gone(media.get(w.sold.id, w.buyer));
    await gone(engagement.engagement(w.sold.id, w.buyer));
    await expect(service.takeDown(w.sold.id, { reason: 'Again.' }, admin)).rejects.toThrow('already been removed');
  });
});

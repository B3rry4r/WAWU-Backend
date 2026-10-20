/* eslint-disable */
// SETTINGS-06 round 7, OWNER RULING (16 Oct 2026): when a creator deletes their
// account, buyers KEEP the content they already paid for. The purge must not
// delete a piece (or its files) that has a completed paid purchase: it is
// hidden from everything public, stays readable in each buyer's library, and
// carries no name of the creator. Pieces nobody bought go as before.
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AccountPurgeModule } from '../account-purge.module';
import { AccountPurgeService } from '../account-purge.service';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { ContentPieceService } from '../../content-piece/content-piece.service';
import { ContentDetailService } from '../../content-piece/content-detail.service';
import { ContentMediaService } from '../../content-piece/content-media.service';
import { FeedCardsService } from '../../content-piece/feed-cards.service';
import { DELETED_CREATOR_ID, DELETED_CREATOR_NAME } from '../../content-piece/deleted-creator';
import { MeModule } from '../../me/me.module';
import { MePurchasesService } from '../../me/me-purchases.service';

describe('SETTINGS-06 round 7: a creator deletes their account, the buyers keep what they paid for', () => {
  jest.setTimeout(120000);
  let prisma: PrismaService;
  let purge: AccountPurgeService;
  let content: ContentPieceService;
  let detail: ContentDetailService;
  let media: ContentMediaService;
  let purchases: MePurchasesService;
  let cards: FeedCardsService;
  const created: { creators: string[]; buyers: string[]; pieces: string[] } = { creators: [], buyers: [], pieces: [] };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, AccountPurgeModule, ContentPieceModule, MeModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    purge = moduleRef.get(AccountPurgeService);
    content = moduleRef.get(ContentPieceService);
    detail = moduleRef.get(ContentDetailService);
    media = moduleRef.get(ContentMediaService);
    purchases = moduleRef.get(MePurchasesService);
    cards = moduleRef.get(FeedCardsService);
  });

  afterAll(async () => {
    const pieces = await prisma.contentPiece.findMany({ where: { OR: [{ id: { in: created.pieces } }, { creatorWawuId: { in: created.creators } }] }, select: { id: true } });
    const ids = pieces.map((p) => p.id);
    await prisma.purchase.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    await prisma.storageObject.deleteMany({ where: { OR: [{ wawuUserId: { in: [...created.creators, DELETED_CREATOR_ID] }, key: { startsWith: 'content/s06r7-' } }] } });
    await prisma.$disconnect();
  });

  async function world() {
    const creator = randomUUID();
    const buyer = randomUUID();
    const stranger = randomUUID();
    created.creators.push(creator);
    created.buyers.push(buyer);
    const tag = creator.slice(0, 8);
    const key = (name: string) => `content/s06r7-${tag}-${name}`;
    const mk = async (name: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      created.pieces.push(id);
      const p = await prisma.contentPiece.create({
        data: {
          id, slug: `s06r7-${tag}-${name}-ada`, creatorWawuId: creator, contentType: 'course',
          title: `${name} course`, description: 'A full course.', category: 'beauty',
          tags: ['ada-okafor'], specializations: [], accessType: 'paid', price: 500000,
          previewAssetUrl: key(`${name}-preview.jpg`), fullAssetUrl: key(`${name}-full.mp4`),
          status: 'live', ...extra,
        },
      });
      for (const k of [key(`${name}-preview.jpg`), key(`${name}-full.mp4`)]) {
        await prisma.storageObject.create({ data: { wawuUserId: creator, key: k, bytes: 1000, contentType: 'video/mp4', folder: 'content', status: 'confirmed', confirmedAt: new Date() } });
      }
      return p;
    };
    const sold = await mk('sold');
    const unsold = await mk('unsold');
    const pending = await mk('pending');
    await prisma.courseLesson.create({ data: { contentId: sold.id, title: 'Lesson one', order: 1 } });
    await prisma.contentFrame.create({ data: { contentId: sold.id, position: 0, url: key('sold-frame.jpg') } });
    await prisma.storageObject.create({ data: { wawuUserId: creator, key: key('sold-frame.jpg'), bytes: 10, contentType: 'image/jpeg', folder: 'content', status: 'confirmed', confirmedAt: new Date() } });
    // an upload of the creator's that no piece uses
    await prisma.storageObject.create({ data: { wawuUserId: creator, key: key('stray.jpg'), bytes: 10, contentType: 'image/jpeg', folder: 'content', status: 'confirmed', confirmedAt: new Date() } });
    const buy = (pieceId: string, status: 'completed' | 'pending' | 'failed', buyerId = buyer) =>
      prisma.purchase.create({
        data: { contentId: pieceId, type: 'content', buyerWawuId: buyerId, creatorWawuId: creator, amount: 500000, commissionRate: '0.1500', flutterwaveTxRef: `s06r7-${randomUUID()}`, status },
      });
    await buy(sold.id, 'completed');
    await buy(pending.id, 'pending');
    return { creator, buyer, stranger, sold, unsold, pending, key };
  }

  it('a sold piece survives the purge, its files stay, and its creator\'s name does not', async () => {
    const w = await world();
    const out = await purge.purge(w.creator);
    expect(out.failed).toEqual([]);
    expect(out.keptForBuyers).toBe(1);

    const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.sold.id } });
    expect(left.status).toBe('removed'); // hidden from everything public
    expect(left.creatorWawuId).toBe(DELETED_CREATOR_ID); // the creator is gone from it
    expect(left.title).toBe('sold course'); // what the buyer paid for is intact
    expect(left.previewAssetUrl).toBe(w.key('sold-preview.jpg'));
    expect(left.fullAssetUrl).toBe(w.key('sold-full.mp4'));
    expect(left.slug).toBe(`removed-${w.sold.id}`); // nothing that names the person
    expect(left.tags).toEqual([]);
    expect(await prisma.courseLesson.count({ where: { contentId: w.sold.id } })).toBe(1);
    expect(await prisma.contentFrame.count({ where: { contentId: w.sold.id } })).toBe(1);
    // its files are kept, and no longer filed under the person
    const files = await prisma.storageObject.findMany({ where: { key: { in: [w.key('sold-preview.jpg'), w.key('sold-full.mp4'), w.key('sold-frame.jpg')] } } });
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.wawuUserId === DELETED_CREATOR_ID)).toBe(true);
    // nothing of the person is left by their id
    expect(await prisma.contentPiece.count({ where: { creatorWawuId: w.creator, id: w.sold.id } })).toBe(0);
    expect(await prisma.storageObject.count({ where: { wawuUserId: w.creator } })).toBe(0);
  });

  it('an unsold piece and its files are deleted, as before', async () => {
    const w = await world();
    await purge.purge(w.creator);
    expect(await prisma.contentPiece.count({ where: { id: w.unsold.id } })).toBe(0);
    expect(await prisma.storageObject.count({ where: { key: { in: [w.key('unsold-preview.jpg'), w.key('unsold-full.mp4'), w.key('stray.jpg')] } } })).toBe(0);
  });

  it('a piece with only an unfinished purchase is kept hidden and stripped, as before (nobody paid)', async () => {
    const w = await world();
    const out = await purge.purge(w.creator);
    expect(out.failed).toEqual([]);
    const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.pending.id } });
    expect(left.status).toBe('removed');
    expect(left.title).toBe('Removed content');
    expect(left.fullAssetUrl).toBeNull();
  });

  it('the buyer can still open it, in the library, the detail and the media; nobody else can find, open or buy it', async () => {
    const w = await world();
    await purge.purge(w.creator);

    // the buyer's library keeps it, with the creator's name replaced
    const lib = await purchases.list(w.buyer, undefined, undefined, 20);
    const item = lib.items.find((i) => i.content.id === w.sold.id)!;
    expect(item).toBeDefined();
    expect(item.content.title).toBe('sold course');
    expect(item.content.creator.displayName).toBe(DELETED_CREATOR_NAME);
    expect(item.content.creator.handle).toBeNull();
    expect(item.content.creator.avatarUrl).toBeNull();
    expect(item.lessons).toEqual({ total: 1, done: 0 });

    // the buyer opens it
    const open = await content.findOne(w.sold.id, w.buyer);
    expect(open.fullAssetLocked).toBe(false);
    expect(open.fullAssetUrl).not.toBeNull();
    const d = await detail.detail(w.sold.id, w.buyer);
    expect(d.lessons).toHaveLength(1);
    expect(d.purchasedAt).not.toBeNull();
    const m = await media.get(w.sold.id, w.buyer);
    expect(m).toBeDefined(); // opened, not a 404

    // nobody else: not a stranger, not signed out, not the buyer of the other piece
    for (const who of [w.stranger, undefined]) {
      await expect(content.findOne(w.sold.id, who)).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(detail.detail(w.sold.id, w.stranger)).rejects.toBeInstanceOf(NotFoundException);
    // no new sales
    await expect(content.unlock(w.sold.id, w.stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(content.unlock(w.sold.id, w.buyer)).rejects.toBeInstanceOf(NotFoundException);
    // not in the feed, not in anyone's list of the creator's work
    const feed = await content.list(w.stranger, 'feed', undefined, 1, 100);
    expect(feed.items.some((p) => p.id === w.sold.id)).toBe(false);
    const buyerFeed = await content.list(w.buyer, 'feed', undefined, 1, 100);
    expect(buyerFeed.items.some((p) => p.id === w.sold.id)).toBe(false);
  });

  it('a retry of the purge changes nothing more', async () => {
    const w = await world();
    await purge.purge(w.creator);
    const again = await purge.purge(w.creator);
    expect(again.failed).toEqual([]);
    expect(again.keptForBuyers).toBe(0);
    expect(await prisma.contentPiece.count({ where: { id: w.sold.id } })).toBe(1);
    expect(await prisma.storageObject.count({ where: { wawuUserId: DELETED_CREATOR_ID, key: w.key('sold-full.mp4') } })).toBe(1);
  });

  it('the deleted creator card is the same everywhere the creator is read', async () => {
    const m = await cards.creatorsFor([DELETED_CREATOR_ID]);
    expect(m.get(DELETED_CREATOR_ID)).toMatchObject({ displayName: DELETED_CREATOR_NAME, handle: null, avatarUrl: null });
  });
});

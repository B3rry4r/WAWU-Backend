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
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { ContentPieceService } from '../../content-piece/content-piece.service';
import { ContentDetailService } from '../../content-piece/content-detail.service';
import { ContentMediaService } from '../../content-piece/content-media.service';
import { DELETED_CREATOR_ID } from '../../content-piece/deleted-creator';
import { useHarness } from './round5-harness';

/**
 * SETTINGS-06 round 9 (verifier round 8, lead rulings 17 Oct 2026).
 *
 *   R8-1  no 404 for a completed buyer at the instant of the purge or of a
 *         cancel: the marker is looked up by the piece alone, and the purge
 *         moves it to the deleted account in the transaction that re-keys the
 *         piece.
 *   R8-2  contact details: one phone number at a time (the table is in
 *         src/account-purge/tests/scrub-contact-details.spec.ts); here, the
 *         purge scrubs the verifier's leaking examples in the database.
 *   R8-3  a deletion never undoes a takedown: buyers keep access only to
 *         pieces that were LIVE when the deletion started.
 */
describe('SETTINGS-06 round 9: no gap at the purge or a cancel, takedowns stay down', () => {
  jest.setTimeout(600000);
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
  let prisma: PrismaService;
  let content: ContentPieceService;
  let detail: ContentDetailService;
  let media: ContentMediaService;
  let purge: AccountPurgeService;
  const made: { pieces: string[]; people: string[] } = { pieces: [], people: [] };
  // A spy left over from a test that failed must not reach the next one.
  const spies: jest.SpyInstance[] = [];
  afterEach(() => {
    while (spies.length > 0) spies.pop()!.mockRestore();
  });

  afterAll(async () => {
    if (!prisma) return;
    const pieces = await prisma.contentPiece.findMany({
      where: { OR: [{ id: { in: made.pieces } }, { creatorWawuId: { in: made.people } }] },
      select: { id: true },
    });
    const ids = pieces.map((p) => p.id);
    await prisma.accountDeletionContent.deleteMany({ where: { contentPieceId: { in: ids } } });
    await prisma.purchase.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    await prisma.storageObject.deleteMany({ where: { key: { startsWith: 'content/s06r9-' } } });
    await moduleRef?.close();
  });

  const h = useHarness();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, AccountPurgeModule, ContentPieceModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    content = moduleRef.get(ContentPieceService);
    detail = moduleRef.get(ContentDetailService);
    media = moduleRef.get(ContentMediaService);
    purge = moduleRef.get(AccountPurgeService);
  });

  async function world() {
    const { id: creator } = await h.person(0);
    made.people.push(creator);
    const buyer = randomUUID();
    const outsider = randomUUID();
    const tag = creator.slice(0, 8);
    const mk = async (name: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      made.pieces.push(id);
      const preview = `content/s06r9-${tag}-${name}-preview.jpg`;
      const full = `content/s06r9-${tag}-${name}-full.mp4`;
      const p = await prisma.contentPiece.create({
        data: {
          id, slug: `s06r9-${tag}-${name}`, creatorWawuId: creator, contentType: 'course',
          title: `${name} course`, description: 'A full course.', category: 'beauty', tags: ['makeup'],
          specializations: [], accessType: 'paid', price: 500000, previewAssetUrl: preview, fullAssetUrl: full,
          status: 'live', ...extra,
        },
      });
      for (const k of [preview, full]) {
        await prisma.storageObject.create({
          data: { wawuUserId: creator, key: k, bytes: 1000, contentType: 'video/mp4', folder: 'content', status: 'confirmed', confirmedAt: new Date() },
        });
      }
      return p;
    };
    const buy = (pieceId: string, status: 'completed' | 'pending' | 'failed', who: string) =>
      prisma.purchase.create({
        data: {
          contentId: pieceId, type: 'content', buyerWawuId: who, creatorWawuId: creator, amount: 500000,
          commissionRate: '0.1500', flutterwaveTxRef: `s06r9-${randomUUID()}`, status,
        },
      });
    const sold = await mk('sold');
    await buy(sold.id, 'completed', buyer);
    return { creator, buyer, outsider, sold, mk, buy, tag };
  }

  const routes = {
    '/content/:id': (id: string, who: string | undefined) => content.findOne(id, who),
    '/detail': (id: string, who: string) => detail.detail(id, who),
    '/media': (id: string, who: string) => media.get(id, who),
  } as const;
  const opens = async (id: string, who: string) => {
    for (const run of Object.values(routes)) expect((await run(id, who) as any).id ?? (await run(id, who) as any).contentId).toBe(id);
  };
  const closed = async (id: string, who: string | undefined) => {
    await expect(content.findOne(id, who)).rejects.toBeInstanceOf(NotFoundException);
    if (who) {
      await expect(detail.detail(id, who)).rejects.toBeInstanceOf(NotFoundException);
      await expect(media.get(id, who)).rejects.toBeInstanceOf(NotFoundException);
    }
  };

  /**
   * Runs `during` once, in the middle of the first lookup of the deletion's
   * mark (after the request read the piece, before it asks for the mark): the
   * interleaving the verifier held open with a table lock.
   */
  function atMarkerLookup(during: () => Promise<unknown>) {
    const real = prisma.accountDeletionContent.findFirst.bind(prisma.accountDeletionContent);
    let fired = false;
    const spy = jest.spyOn(prisma.accountDeletionContent, 'findFirst').mockImplementation(((args: unknown) => {
      if (fired) return (real as any)(args);
      fired = true;
      return during().then(() => (real as any)(args));
    }) as any);
    spies.push(spy);
    return { done: () => { spy.mockRestore(); return fired; } };
  }

  /** What the purge did before this round: re-key the piece, then drop the mark. */
  async function oldStylePurge(w: { creator: string; sold: { id: string } }) {
    await prisma.contentPiece.update({ where: { id: w.sold.id }, data: { creatorWawuId: DELETED_CREATOR_ID } });
    await prisma.accountDeletionContent.deleteMany({ where: { wawuUserId: w.creator } });
  }

  describe('R8-1: no 404 for a completed buyer across the purge or a cancel', () => {
    for (const [name, run] of Object.entries(routes)) {
      it(`${name}: the real purge lands between the read of the piece and the look-up of the mark`, async () => {
        const w = await world();
        await h.del(h.accounts, w.creator);
        const hook = atMarkerLookup(() => purge.purge(w.creator));
        const got = await run(w.sold.id, w.buyer);
        expect(hook.done()).toBe(true);
        expect((got as any).id ?? (got as any).contentId).toBe(w.sold.id);
        // an outsider caught in the same window is still turned away
        const w2 = await world();
        await h.del(h.accounts, w2.creator);
        const hook2 = atMarkerLookup(() => purge.purge(w2.creator));
        await expect(run(w2.sold.id, w2.outsider)).rejects.toBeInstanceOf(NotFoundException);
        hook2.done();
      });

      it(`${name}: a purge that re-keys the piece and drops the mark (the old purge) lands in the same window`, async () => {
        const w = await world();
        await h.del(h.accounts, w.creator);
        const hook = atMarkerLookup(() => oldStylePurge(w));
        const got = await run(w.sold.id, w.buyer);
        expect(hook.done()).toBe(true);
        expect((got as any).id ?? (got as any).contentId).toBe(w.sold.id);
        const w2 = await world();
        await h.del(h.accounts, w2.creator);
        const hook2 = atMarkerLookup(() => oldStylePurge(w2));
        await expect(run(w2.sold.id, w2.outsider)).rejects.toBeInstanceOf(NotFoundException);
        hook2.done();
      });

      it(`${name}: a cancel lands in the same window`, async () => {
        const w = await world();
        await h.del(h.accounts, w.creator);
        const hook = atMarkerLookup(() => h.can(h.accounts, w.creator));
        const got = await run(w.sold.id, w.buyer);
        expect(hook.done()).toBe(true);
        expect((got as any).id ?? (got as any).contentId).toBe(w.sold.id);
        expect(await h.pieceState(w.sold.id)).toBe('live');
      });
    }

    it('a piece taken down before the deletion stays 404 in the same windows', async () => {
      const w = await world();
      const old = await w.mk('old', { status: 'removed' });
      await w.buy(old.id, 'completed', w.buyer);
      await h.del(h.accounts, w.creator);
      const hook = atMarkerLookup(() => purge.purge(w.creator));
      await expect(content.findOne(old.id, w.buyer)).rejects.toBeInstanceOf(NotFoundException);
      hook.done();
      await closed(old.id, w.buyer);
    });

    it('sixteen readers over thirty purges: no buyer misses, no outsider gets in', async () => {
      let buyerReads = 0;
      let misses = 0;
      let leaks = 0;
      for (let round = 0; round < 30; round += 1) {
        const w = await world();
        await h.del(h.accounts, w.creator);
        let done = false;
        const reader = async (who: string, buyerRead: boolean) => {
          let after = 0;
          while (!done || after < 3) {
            if (done) after += 1;
            const via = [routes['/content/:id'], routes['/detail'], routes['/media']][(buyerReads + after) % 3];
            try {
              await via(w.sold.id, who);
              if (buyerRead) buyerReads += 1;
              else leaks += 1;
            } catch (e) {
              if (!(e instanceof NotFoundException)) throw e;
              if (buyerRead) { buyerReads += 1; misses += 1; }
            }
          }
        };
        const readers = [
          ...Array.from({ length: 16 }, () => reader(w.buyer, true)),
          ...Array.from({ length: 2 }, () => reader(w.outsider, false)),
        ];
        const out = await purge.purge(w.creator).finally(() => { done = true; });
        await Promise.all(readers);
        expect(out.failed).toEqual([]);
        expect(out.keptForBuyers).toBe(1);
      }
      console.info(`round 9 race: ${buyerReads} buyer reads over 30 purges, ${misses} misses, ${leaks} outsider leaks`);
      expect(buyerReads).toBeGreaterThan(30 * 16);
      expect(misses).toBe(0);
      expect(leaks).toBe(0);
    });
  });

  describe('R8-2: the purge scrubs the verifier\'s leaking examples', () => {
    it('numbers that follow a number, a date or a reference are scrubbed; prices and years stay', async () => {
      const w = await world();
      const p = await w.mk('words', {
        title: 'Call 08012345678 08098765432',
        description:
          'Ref 24680. 08012345678. Tiers 5000 10000 15000 for 2026 2027. Sold 2026-10-17 08012345678, WhatsApp08098765432, ada@localhost. 12 lessons.',
      });
      await w.buy(p.id, 'completed', w.buyer);
      const out = await purge.purge(w.creator);
      expect(out.failed).toEqual([]);
      const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: p.id } });
      expect(left.title).toBe('Call [removed] [removed]');
      expect(left.description).toBe(
        'Ref 24680. [removed]. Tiers 5000 10000 15000 for 2026 2027. Sold 2026-10-17 [removed], WhatsApp[removed], [removed]. 12 lessons.',
      );
    });
  });

  describe('R8-3: a deletion never undoes a takedown', () => {
    const cases = [
      { prior: 'live', buyerBefore: true, buyerDuring: true, afterCancel: true, afterPurge: true },
      { prior: 'removed', buyerBefore: false, buyerDuring: false, afterCancel: false, afterPurge: false },
      { prior: 'rejected', buyerBefore: false, buyerDuring: false, afterCancel: false, afterPurge: false },
      { prior: 'pending', buyerBefore: false, buyerDuring: false, afterCancel: false, afterPurge: false },
    ] as const;

    const seen = async (id: string, who: string, opensIt: boolean) => {
      if (opensIt) await opens(id, who);
      else await closed(id, who);
    };

    for (const c of cases) {
      it(`a ${c.prior} piece with a completed buyer: before the DELETE, in the 30 days, after a cancel, after the purge`, async () => {
        const w = await world();
        const name: string = c.prior === 'live' ? 'sold' : c.prior;
        const piece = c.prior === 'live' ? w.sold : await w.mk(c.prior, { status: c.prior });
        if (c.prior !== 'live') await w.buy(piece.id, 'completed', w.buyer);
        await seen(piece.id, w.buyer, c.buyerBefore);

        // the 30 days
        await h.del(h.accounts, w.creator);
        const mark = await prisma.accountDeletionContent.findFirst({ where: { contentPieceId: piece.id } });
        // a piece already removed has no mark; any other has one that says what it was
        expect(mark?.priorStatus ?? 'removed').toBe(c.prior);
        expect(await h.pieceState(piece.id)).toBe('removed');
        await seen(piece.id, w.buyer, c.buyerDuring);
        await closed(piece.id, w.outsider);

        // a cancel puts every piece back as it was
        expect((await h.can(h.accounts, w.creator)).ok).toBe(true);
        expect(await h.pieceState(piece.id)).toBe(c.prior);
        await seen(piece.id, w.buyer, c.afterCancel);

        // and the purge, after a second DELETE
        await h.del(h.accounts, w.creator);
        const out = await purge.purge(w.creator);
        expect(out.failed).toEqual([]);
        const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: piece.id } });
        expect(left.creatorWawuId).toBe(DELETED_CREATOR_ID);
        expect(left.status).toBe('removed');
        await seen(piece.id, w.buyer, c.afterPurge);
        await closed(piece.id, w.outsider);
        const mine = await prisma.accountDeletionContent.findMany({ where: { contentPieceId: piece.id } });
        expect(mine.map((m) => m.wawuUserId)).toEqual([DELETED_CREATOR_ID]);
        const files = await prisma.storageObject.count({ where: { key: { startsWith: `content/s06r9-${w.tag}-${name}-` } } });
        if (c.afterPurge) {
          // kept whole: the words as bought, the files filed under the deleted account
          expect(mine[0].priorStatus).toBe('live');
          expect(left.title).toBe(`${name} course`);
          expect(left.fullAssetUrl).toBeTruthy();
          expect(files).toBe(2);
          expect(await prisma.storageObject.count({ where: { wawuUserId: w.creator } })).toBe(0);
        } else {
          // treated like an unsold piece: the row stays (a Purchase points at it), stripped, and its files go
          expect(mine[0].priorStatus).toBe(c.prior);
          expect(left.title).toBe('Removed content');
          expect(left.description).toBe('');
          expect(left.fullAssetUrl).toBeNull();
          expect(left.previewAssetUrl).toBe('');
          expect(files).toBe(0);
        }
        // a second purge changes nothing
        const again = await purge.purge(w.creator);
        expect(again.failed).toEqual([]);
        expect(again.keptForBuyers).toBe(0);
      });
    }

    it('a purchase that completes after the purge does not open a stripped piece', async () => {
      const w = await world();
      const pend = await w.mk('pend');
      const late = randomUUID();
      const lateBuy = await w.buy(pend.id, 'pending', late);
      await h.del(h.accounts, w.creator);
      await purge.purge(w.creator);
      await prisma.purchase.update({ where: { id: lateBuy.id }, data: { status: 'completed' } });
      await closed(pend.id, late);
      await opens(w.sold.id, w.buyer);
    });

    it('a purge whose list of kept pieces is lost touches no piece, file or mark; the retry keeps them', async () => {
      const w = await world();
      await h.del(h.accounts, w.creator);
      const real = prisma.contentPiece.findMany.bind(prisma.contentPiece);
      let first = true;
      const spy = jest.spyOn(prisma.contentPiece, 'findMany').mockImplementation(((args: any) => {
        if (first) { first = false; return Promise.reject(new Error('db hiccup')); }
        return (real as any)(args);
      }) as any);
      spies.push(spy);
      const out = await purge.purge(w.creator);
      spy.mockRestore();
      expect(out.failed).toContain('ContentPiece.creatorWawuId');
      expect(await prisma.contentPiece.count({ where: { id: w.sold.id, creatorWawuId: w.creator } })).toBe(1);
      expect(await prisma.storageObject.count({ where: { wawuUserId: w.creator, key: { startsWith: `content/s06r9-${w.tag}-sold-` } } })).toBe(2);
      expect(await prisma.accountDeletionContent.count({ where: { wawuUserId: w.creator } })).toBe(1);
      await opens(w.sold.id, w.buyer);
      const again = await purge.purge(w.creator);
      expect(again.failed).toEqual([]);
      expect(again.keptForBuyers).toBe(1);
      await opens(w.sold.id, w.buyer);
    });
  });
});

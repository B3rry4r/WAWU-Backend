/* eslint-disable */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AccountPurgeModule } from '../../account-purge/account-purge.module';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommentModule } from '../../comment/comment.module';
import { CommentService } from '../../comment/comment.service';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { ContentPieceService } from '../../content-piece/content-piece.service';
import { ContentDetailService } from '../../content-piece/content-detail.service';
import { ContentMediaService } from '../../content-piece/content-media.service';
import { DELETED_CREATOR_ID } from '../../content-piece/deleted-creator';
import { scrubContactDetails } from '../../account-purge/scrub-contact-details';
import { useHarness } from './round5-harness';

/**
 * SETTINGS-06 round 8 (verifier round 7, lead rulings 17 Oct 2026).
 *
 *   R7-1  buyers keep what they paid for from the moment of DELETE, not only
 *         after the purge: a completed buyer opens a piece a deletion hid, on
 *         the three routes they can open after the purge (/content/:id,
 *         /detail, /media). Everyone else gets 404; a cancel puts it all back.
 *   R7-2  title and description stay as bought, but the purge takes email
 *         addresses and phone numbers out of them.
 *   R7-3  pieces stripped for a pending, failed or tip purchase are re-keyed
 *         to the deleted account too.
 *   R7-4  on a piece a deletion hid, a non-buyer cannot read or post comments
 *         or save it. Any other removed piece is exactly as before.
 *   R7-5  the rollbacks refuse while cancelled rows owe an unfreeze.
 */
describe('SETTINGS-06 round 8: buyers keep what they paid for, from the DELETE on', () => {
  jest.setTimeout(300000);
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
  let prisma: PrismaService;
  let content: ContentPieceService;
  let detail: ContentDetailService;
  let media: ContentMediaService;
  let comments: CommentService;
  let purge: AccountPurgeService;
  const made: { pieces: string[]; keys: string[]; people: string[] } = { pieces: [], keys: [], people: [] };

  // Declared before the harness: its cleanup deletes the people's pieces, which
  // fails while purchases of ours still point at them.
  afterAll(async () => {
    if (!prisma) return;
    const pieces = await prisma.contentPiece.findMany({
      where: { OR: [{ id: { in: made.pieces } }, { creatorWawuId: { in: made.people } }] },
      select: { id: true },
    });
    const ids = pieces.map((p) => p.id);
    await prisma.comment.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.savedItem.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.purchase.deleteMany({ where: { contentId: { in: ids } } });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    await prisma.storageObject.deleteMany({ where: { key: { startsWith: 'content/s06r8-' } } });
    await moduleRef?.close();
  });

  const h = useHarness();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, AccountPurgeModule, ContentPieceModule, CommentModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    content = moduleRef.get(ContentPieceService);
    detail = moduleRef.get(ContentDetailService);
    media = moduleRef.get(ContentMediaService);
    comments = moduleRef.get(CommentService, { strict: false });
    purge = moduleRef.get(AccountPurgeService);
  });

  const gone = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundException);

  /** A creator with a paid piece, a completed buyer, a pending buyer, an outsider. */
  async function world() {
    const { id: creator } = await h.person(0);
    made.people.push(creator);
    const buyer = randomUUID();
    const pendingBuyer = randomUUID();
    const outsider = randomUUID();
    const tag = creator.slice(0, 8);
    const mk = async (name: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      made.pieces.push(id);
      const preview = `content/s06r8-${tag}-${name}-preview.jpg`;
      const full = `content/s06r8-${tag}-${name}-full.mp4`;
      const p = await prisma.contentPiece.create({
        data: {
          id, slug: `s06r8-${tag}-${name}`, creatorWawuId: creator, contentType: 'course',
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
    const buy = (pieceId: string, status: 'completed' | 'pending' | 'failed', who: string, type: 'content' | 'tip' = 'content') =>
      prisma.purchase.create({
        data: {
          contentId: pieceId, type, buyerWawuId: who, creatorWawuId: creator, amount: 500000,
          commissionRate: '0.1500', flutterwaveTxRef: `s06r8-${randomUUID()}`, status,
        },
      });
    const sold = await mk('sold');
    await buy(sold.id, 'completed', buyer);
    await buy(sold.id, 'pending', pendingBuyer);
    return { creator, buyer, pendingBuyer, outsider, sold, mk, buy };
  }

  const opensAll = async (id: string, who: string) => {
    expect((await content.findOne(id, who)).id).toBe(id);
    expect((await detail.detail(id, who)).contentId).toBe(id);
    expect((await media.get(id, who)).contentId).toBe(id);
  };
  const closedAll = async (id: string, who: string | undefined) => {
    await gone(content.findOne(id, who));
    if (who) {
      await gone(detail.detail(id, who));
      await gone(media.get(id, who));
    }
  };

  describe('R7-1: from the DELETE on', () => {
    it('a completed buyer opens the hidden piece on all three routes; everyone else gets 404', async () => {
      const w = await world();
      await opensAll(w.sold.id, w.buyer); // before: as ever
      const res = await h.del(h.accounts, w.creator);
      expect(res.ok).toBe(true);
      expect((await h.row(w.creator))?.status).toBe('scheduled');
      expect(await h.pieceState(w.sold.id)).toBe('removed');

      await opensAll(w.sold.id, w.buyer); // limbo: the buyer keeps it
      const full = await content.findOne(w.sold.id, w.buyer);
      expect(full.fullAssetUrl).toBeTruthy(); // the whole file, not the locked view
      await closedAll(w.sold.id, w.outsider);
      await closedAll(w.sold.id, w.pendingBuyer);
      await closedAll(w.sold.id, undefined); // signed out
      await closedAll(w.sold.id, w.creator); // removed is gone for the owner too
    });

    it('a failed or tip purchase does not open it; a deleted piece nobody bought stays gone', async () => {
      const w = await world();
      const failedBuyer = randomUUID();
      const tipper = randomUUID();
      await w.buy(w.sold.id, 'failed', failedBuyer);
      await w.buy(w.sold.id, 'completed', tipper, 'tip');
      await h.del(h.accounts, w.creator);
      await closedAll(w.sold.id, failedBuyer);
      await closedAll(w.sold.id, tipper);
    });

    it('a cancel puts everything back: the piece is live, the marker is gone, the outsider sees a locked live piece', async () => {
      const w = await world();
      await h.del(h.accounts, w.creator);
      const c = await h.can(h.accounts, w.creator);
      expect(c.ok).toBe(true);
      expect(await h.pieceState(w.sold.id)).toBe('live');
      expect(await prisma.accountDeletionContent.count({ where: { wawuUserId: w.creator } })).toBe(0);
      await opensAll(w.sold.id, w.buyer);
      const seen = await content.findOne(w.sold.id, w.outsider);
      expect(seen.fullAssetUrl).toBeNull(); // paid, so locked, as before the DELETE
      expect((await content.findOne(w.sold.id, undefined)).fullAssetUrl).toBeNull();
    });

    it('a piece the creator had removed before the DELETE is not opened by a buyer in the 30 days', async () => {
      const w = await world();
      const old = await w.mk('old', { status: 'removed' });
      await w.buy(old.id, 'completed', w.buyer);
      await h.del(h.accounts, w.creator);
      expect(await prisma.accountDeletionContent.count({ where: { contentPieceId: old.id } })).toBe(0);
      await closedAll(old.id, w.buyer);
      await opensAll(w.sold.id, w.buyer);
    });

    it('after the purge the buyer still opens it, and the others still get 404', async () => {
      const w = await world();
      await h.del(h.accounts, w.creator);
      const out = await purge.purge(w.creator);
      expect(out.failed).toEqual([]);
      expect(out.keptForBuyers).toBe(1);
      const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.sold.id } });
      expect(left.creatorWawuId).toBe(DELETED_CREATOR_ID);
      expect(await prisma.accountDeletionContent.count({ where: { wawuUserId: w.creator } })).toBe(0);
      await opensAll(w.sold.id, w.buyer);
      await closedAll(w.sold.id, w.outsider);
      await closedAll(w.sold.id, w.pendingBuyer);
      await closedAll(w.sold.id, undefined);
    });

    it('a purge that stops after clearing its lists but before re-keying the piece leaves no gap for the buyer', async () => {
      const w = await world();
      await h.del(h.accounts, w.creator);
      // the marker is still there while the piece belongs to the person
      // the step that re-keys the sold pieces is the first batch transaction of the purge
      const real = prisma.$transaction.bind(prisma);
      let failed = false;
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((arg: unknown, ...rest: unknown[]) => {
        if (!failed && Array.isArray(arg)) {
          failed = true;
          return Promise.reject(new Error('db hiccup'));
        }
        return (real as any)(arg, ...rest);
      }) as any);
      const first = await purge.purge(w.creator);
      spy.mockRestore();
      expect(failed).toBe(true);
      expect(first.failed).toContain('ContentPiece.creatorWawuId');
      const mid = await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.sold.id } });
      expect(mid.creatorWawuId).toBe(w.creator);
      // the run that failed did not strip what the buyer paid for either
      expect(mid.title).toBe('sold course');
      expect(mid.fullAssetUrl).toBeTruthy();
      await opensAll(w.sold.id, w.buyer);
      await closedAll(w.sold.id, w.outsider);
      const second = await purge.purge(w.creator);
      expect(second.failed).toEqual([]);
      await opensAll(w.sold.id, w.buyer);
    });
  });

  describe('R7-2: contact details leave the kept title and description', () => {
    it('the purge scrubs emails and phone numbers and keeps the rest as bought', async () => {
      const w = await world();
      const p = await w.mk('words', {
        title: 'Glam class 08012345678',
        description:
          'Learn contouring with Ada Okafor. Book on +234 801 234 5678 or 0801-234-5679, mail ada.okafor+class@gmail.com. 12 lessons for ₦5,000 since 2024.',
      });
      await w.buy(p.id, 'completed', w.buyer);
      await purge.purge(w.creator);
      const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: p.id } });
      expect(left.status).toBe('removed');
      expect(left.title).not.toMatch(/\d{7,}/);
      expect(left.description).not.toContain('@');
      expect(left.description).not.toMatch(/\d{3}[\s-]?\d{3}[\s-]?\d{4}/);
      expect(left.description).toContain('Learn contouring with Ada Okafor.');
      expect(left.description).toContain('12 lessons for ₦5,000 since 2024.');
      expect(left.title.startsWith('Glam class')).toBe(true);
      expect(`${left.title}${left.description}`).not.toContain('—');
      // a piece with nothing to scrub is left exactly as it was
      expect((await prisma.contentPiece.findUniqueOrThrow({ where: { id: w.sold.id } })).description).toBe('A full course.');
      // a second purge changes nothing
      await purge.purge(w.creator);
      const again = await prisma.contentPiece.findUniqueOrThrow({ where: { id: p.id } });
      expect([again.title, again.description]).toEqual([left.title, left.description]);
    });

    it('the scrub: each form of an email and a phone number goes, prices, dates and counts stay', () => {
      const goes = [
        'ada@example.com',
        'Ada.Okafor+x@mail.example.co.uk',
        '+2348012345678',
        '+234 801 234 5678',
        '+234 (0) 801 234 5678',
        '08012345678',
        '0801 234 5678',
        '0801-234-5678',
        '(0801) 234 5678',
        '0801.234.5678',
        '234 801 234 5678',
        '+1 415 555 2671',
      ];
      for (const g of goes) {
        const out = scrubContactDetails(`Reach me on ${g} today`);
        expect(out).not.toMatch(/\d{3}/);
        expect(out).not.toContain('@');
        expect(out.startsWith('Reach me on ')).toBe(true);
        expect(out.endsWith(' today')).toBe(true);
        expect(out).not.toContain('—');
      }
      const stays = [
        '12 lessons for ₦5,000',
        'Since 2024, 3 hours 45 minutes',
        'Module 1. 12 videos',
        '2024-10-05',
        '10 000 students',
        'Only ₦1,500,000',
        'Call me, ask for Ada',
        '',
      ];
      for (const s of stays) expect(scrubContactDetails(s)).toBe(s);
      const once = scrubContactDetails('a@b.com and 08012345678');
      expect(scrubContactDetails(once)).toBe(once);
    });
  });

  describe('R7-3: a stripped piece carries no creator id', () => {
    it('pending, failed and tip pieces are re-keyed and stay unopenable', async () => {
      const w = await world();
      const pend = await w.mk('pend');
      const fail = await w.mk('fail');
      const tipped = await w.mk('tipped', { accessType: 'free', price: 0 });
      const tipper = randomUUID();
      await w.buy(pend.id, 'pending', w.pendingBuyer);
      await w.buy(fail.id, 'failed', w.pendingBuyer);
      await w.buy(tipped.id, 'completed', tipper, 'tip');
      const out = await purge.purge(w.creator);
      expect(out.failed).toEqual([]);
      for (const p of [pend, fail, tipped]) {
        const left = await prisma.contentPiece.findUniqueOrThrow({ where: { id: p.id } });
        expect(left.status).toBe('removed');
        expect(left.title).toBe('Removed content');
        expect(left.creatorWawuId).toBe(DELETED_CREATOR_ID);
        await closedAll(p.id, w.pendingBuyer);
        await closedAll(p.id, tipper);
      }
      // no piece is left under the person, and the sold one is still the buyer's
      expect(await prisma.contentPiece.count({ where: { creatorWawuId: w.creator } })).toBe(0);
      await opensAll(w.sold.id, w.buyer);
    });
  });

  describe('R7-4: comments and saves on a piece a deletion hid', () => {
    it('a non-buyer gets 404 to read or post comments, like one, or save, in the 30 days and after', async () => {
      const w = await world();
      // a comment on the live piece, by the buyer
      await comments.create(w.sold.id, w.buyer, { text: 'Great course' } as any);
      const before = await comments.list(w.sold.id, w.outsider, 1, 20);
      expect(before.total).toBe(1);
      const cid = before.items[0].id;
      await h.del(h.accounts, w.creator);

      let mineCount = 1;
      const check = async () => {
        await gone(comments.list(w.sold.id, w.outsider, 1, 20));
        await gone(comments.create(w.sold.id, w.outsider, { text: 'hello' } as any));
        await gone(comments.setLiked(w.sold.id, cid, w.outsider, true));
        await gone(content.save(w.sold.id, w.outsider));
        await gone(comments.list(w.sold.id, w.pendingBuyer, 1, 20));
        await gone(content.save(w.sold.id, w.pendingBuyer));
        expect(await prisma.savedItem.count({ where: { contentId: w.sold.id, userWawuId: { in: [w.outsider, w.pendingBuyer] } } })).toBe(0);
        // the buyer keeps what they had
        const mine = await comments.list(w.sold.id, w.buyer, 1, 20);
        expect(mine.total).toBe(mineCount);
        const posted = await comments.create(w.sold.id, w.buyer, { text: 'Still love it' } as any);
        mineCount += 1;
        expect(posted.contentId).toBe(w.sold.id);
        expect((await content.save(w.sold.id, w.buyer)).contentId).toBe(w.sold.id);
        expect((await comments.setLiked(w.sold.id, cid, w.buyer, true)).likedByMe).toBe(true);
      };
      await check(); // limbo
      await purge.purge(w.creator);
      await check(); // after the purge
    });

    it('a cancel gives the outsider the live piece back, with its comments', async () => {
      const w = await world();
      await h.del(h.accounts, w.creator);
      await gone(comments.list(w.sold.id, w.outsider, 1, 20));
      await h.can(h.accounts, w.creator);
      expect((await comments.list(w.sold.id, w.outsider, 1, 20)).total).toBe(0);
      expect((await content.save(w.sold.id, w.outsider)).contentId).toBe(w.sold.id);
    });

    it('any other removed piece is as before: the web\'s routes are unchanged', async () => {
      const { id: creator } = await h.person(0);
      made.people.push(creator);
      const outsider = randomUUID();
      const id = randomUUID();
      made.pieces.push(id);
      await prisma.contentPiece.create({
        data: {
          id, slug: `s06r8-${id.slice(0, 8)}`, creatorWawuId: creator, contentType: 'video', title: 'Taken down',
          description: 'x', category: 'beauty', tags: [], specializations: [], accessType: 'free', price: 0,
          previewAssetUrl: 'content/s06r8-p.jpg', status: 'removed',
        },
      });
      // no deletion anywhere: the same answers a removed piece always gave
      expect((await comments.list(id, outsider, 1, 20)).total).toBe(0);
      expect((await comments.create(id, outsider, { text: 'hi' } as any)).contentId).toBe(id);
      expect((await content.save(id, outsider)).contentId).toBe(id);
      await gone(content.findOne(id, outsider));
    });
  });

  describe('R7-5: the rollbacks refuse while a cancelled deletion owes an unfreeze', () => {
    const dir = join(__dirname, '../../../prisma/migrations');
    const guard = (folder: string) => {
      const sql = readFileSync(join(dir, folder, 'rollback.sql'), 'utf8');
      const m = sql.match(/DO \$\$[\s\S]*?END \$\$;/);
      if (!m) throw new Error('no guard in ' + folder);
      return m[0];
    };
    const run = async (sql: string, setup: string | null) => {
      // everything inside one transaction that is always rolled back
      class Done extends Error {}
      let refused: string | null = null;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DELETE FROM "AccountDeletion" WHERE "wawuUserId" LIKE 's06r8-%'`);
          // earlier tests leave rows; make the table look empty to the guard
          await tx.$executeRawUnsafe(`UPDATE "AccountDeletion" SET "status" = 'purged', "walletSyncedAt" = now() WHERE "status" <> 'purged'`);
          if (setup) await tx.$executeRawUnsafe(setup);
          try {
            await tx.$executeRawUnsafe(sql);
          } catch (e) {
            refused = (e as Error).message;
          }
          throw new Done();
        });
      } catch (e) {
        if (!(e instanceof Done)) throw e;
      }
      return refused as string | null;
    };
    const cancelledOwing = (id: string) =>
      `INSERT INTO "AccountDeletion" ("wawuUserId", "status", "scheduledAt", "purgeAfter", "walletId", "walletProvider", "cancelledAt", "walletSyncedAt", "updatedAt")
       VALUES ('${id}', 'cancelled', now() - interval '1 hour', now() + interval '29 days', 'w-x', 'fintava', now(), NULL, now())`;
    const cancelledSettled = (id: string) => cancelledOwing(id).replace('NULL, now())', 'now(), now())');

    it('the 20261024040000 rollback (which drops the column) refuses on a cancelled row with no confirmation, and passes without one', async () => {
      const sql = guard('20261024040000_account_deletion_states');
      const id = `s06r8-${randomUUID()}`;
      expect(await run(sql, cancelledOwing(id))).toMatch(/cancelled|unfreeze|wallet/i);
      expect(await run(sql, cancelledSettled(`s06r8-${randomUUID()}`))).toBeNull();
      expect(await run(sql, null)).toBeNull();
    });

    it('the 20261024030000 rollback refuses on a scheduled row, and on a cancelled row with no confirmation while the column exists', async () => {
      const sql = guard('20261024030000_account_deletion');
      expect(await run(sql, cancelledOwing(`s06r8-${randomUUID()}`))).toMatch(/cancelled|unfreeze|wallet/i);
      expect(await run(sql, cancelledSettled(`s06r8-${randomUUID()}`))).toBeNull();
      const scheduled = `INSERT INTO "AccountDeletion" ("wawuUserId", "status", "scheduledAt", "purgeAfter", "updatedAt")
        VALUES ('s06r8-${randomUUID()}', 'scheduled', now() - interval '1 hour', now() + interval '29 days', now())`;
      expect(await run(sql, scheduled)).toMatch(/scheduled/i);
    });
  });
});

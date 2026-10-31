/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
// USER-SUSPEND round 2 (R-121): M1 a buyer no longer opens or lists a suspended creator's piece; M2 a suspended host's room
// leaves its members' own list; L1 a person with no UserProfile row can be suspended, and a dismissed report and a
// comment or message a report took down are in the audit trail; H1 the legacy /wallet/withdraw goes only to an account in
// the suspended person's own name. The whole Hub (AppModule), real database, mock WAWU ID, Flutterwave mock.

import { randomUUID } from 'node:crypto';
import { WalletModule } from '../../wallet/wallet.module';
import {
  FLUTTERWAVE_WALLET_GATEWAY,
  type FlutterwaveWalletGateway,
} from '../../wallet/flutterwave-wallet.gateway';
import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';

jest.setTimeout(180_000);

describe('USER-SUSPEND round 2', () => {
  let h: Harness;
  let zed: Who; // the suspended creator
  let buyer: Who; // bought zed's piece and saved it
  let ana: Who; // member of zed's room
  let ghost: Who; // signed up, never made a Hub profile
  let ada: Who; // "Ada Okeke": the Flutterwave mock names every account ADA OKEKE
  let sam: Who; // "Sam Stranger": the same account is not theirs
  let pieceId: string;
  let purchaseId: string;
  let zedRoom: string;
  let anaRoom: string;
  let ghostComment: string;
  const TAG = `us2${Date.now().toString().slice(-8)}`;
  const created = { wallets: [] as string[] };

  const as = (w: Who | null) =>
    w ? { Authorization: `Bearer ${w.token}` } : {};
  const get = (w: Who | null, url: string) =>
    h.http().get(`/api/hub${url}`).set(as(w));
  const admin = (role: 'superadmin' | 'reviewer' | 'support') => ({
    Authorization: `Bearer ${h.admin(role)}`,
  });
  const suspend = (id: string, note = 'round 2 spec') =>
    h
      .http()
      .post(`/api/hub/admin/users/${id}/suspend`)
      .set(admin('reviewer'))
      .send({ reason: 'spam', note });
  const lift = (id: string) =>
    h
      .http()
      .post(`/api/hub/admin/users/${id}/lift`)
      .set(admin('support'))
      .send({ note: 'round 2 spec lift' });
  const mentions = async (w: Who | null, url: string, id: string) =>
    JSON.stringify((await get(w, url)).body).includes(id);

  beforeAll(async () => {
    h = await boot('us2');
    zed = await h.person('zed', 'creator');
    buyer = await h.person('buyer');
    ana = await h.person('ana');
    ghost = await h.person('ghost', 'user', undefined, false);
    ada = await h.person('ada', 'creator', 'Ada Okeke');
    sam = await h.person('sam', 'creator', 'Sam Stranger');
    pieceId = (
      await h.prisma.contentPiece.create({
        data: {
          slug: `${TAG}-piece`,
          creatorWawuId: zed.sub,
          contentType: 'video',
          title: `${TAG} piece`,
          description: 'fixture',
          category: 'fixture',
          accessType: 'paid',
          price: 100,
          previewAssetUrl: 'https://example.invalid/p.jpg',
          status: 'live',
        },
        select: { id: true },
      })
    ).id;
    purchaseId = (
      await h.prisma.purchase.create({
        data: {
          type: 'content',
          buyerWawuId: buyer.sub,
          contentId: pieceId,
          creatorWawuId: zed.sub,
          amount: 100,
          commissionRate: 0.15,
          status: 'completed',
          flutterwaveTxRef: `${TAG}-buy`,
        } as never,
        select: { id: true },
      })
    ).id;
    await h.prisma.savedItem.create({
      data: { userWawuId: buyer.sub, contentId: pieceId },
    });
    zedRoom = (
      await h.prisma.community.create({
        data: {
          name: `${TAG} zed room`,
          description: 'x',
          hostWawuId: zed.sub,
          kind: 'open',
        },
        select: { id: true },
      })
    ).id;
    anaRoom = (
      await h.prisma.community.create({
        data: {
          name: `${TAG} ana room`,
          description: 'x',
          hostWawuId: ana.sub,
          kind: 'open',
        },
        select: { id: true },
      })
    ).id;
    await h.prisma.communityMembership.createMany({
      data: [
        { userWawuId: ana.sub, communityId: zedRoom, status: 'joined' },
        { userWawuId: zed.sub, communityId: anaRoom, status: 'joined' },
      ],
    });
    // The ghost has said something in the Hub, and has no profile row.
    ghostComment = (
      await h.prisma.comment.create({
        data: {
          contentId: pieceId,
          authorWawuId: ghost.sub,
          text: `ghost says ${TAG}`,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (h) {
      const people = [zed, buyer, ana, ghost, ada, sam]
        .filter(Boolean)
        .map((p) => p.sub);
      await h.prisma.walletWithdrawal.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await h.prisma.walletLedgerEntry.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await h.prisma.creatorWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await h.prisma.purchase.deleteMany({
        where: { buyerWawuId: { in: people } },
      });
      await h.prisma.savedItem.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await h.prisma.communityMembership.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await h.prisma.community.deleteMany({
        where: { name: { startsWith: TAG } },
      });
      await h.prisma.communityMessage.deleteMany({
        where: { senderWawuId: { in: people } },
      });
      await h.prisma.comment.deleteMany({
        where: { authorWawuId: { in: people } },
      });
      await h.prisma.contentPiece.deleteMany({
        where: { slug: { startsWith: TAG } },
      });
      await h.cleanup();
      await h.stop();
    }
  });

  describe('M1: a buyer of a suspended creator’s piece', () => {
    const view = async () => ({
      detail: (await get(buyer, `/content/${pieceId}/detail`)).status,
      piece: (await get(buyer, `/content/${pieceId}`)).status,
      legacyPurchases: await mentions(buyer, '/content/purchases', purchaseId),
      mePurchases: await mentions(buyer, '/me/purchases', pieceId),
      meCount: (await get(buyer, '/me/counts')).body.data.purchases as number,
      legacySaved: await mentions(buyer, '/users/me/saved', pieceId),
      meSaved: await mentions(buyer, '/me/saved?type=content', pieceId),
    });
    let before: Awaited<ReturnType<typeof view>>;

    it('before: opens the piece, sees it in My purchases and Saved', async () => {
      before = await view();
      expect(before).toEqual({
        detail: 200,
        piece: 200,
        legacyPurchases: true,
        mePurchases: true,
        meCount: 1,
        legacySaved: true,
        meSaved: true,
      });
    });

    it('while suspended: the detail and the piece are 404 for the buyer, and the piece is off both purchase lists, the count and both Saved lists', async () => {
      await suspend(zed.sub).expect(200);
      expect(await view()).toEqual({
        detail: 404,
        piece: 404,
        legacyPurchases: false,
        mePurchases: false,
        meCount: 0,
        legacySaved: false,
        meSaved: false,
      });
      // The same words as an id that never existed.
      const missing = await get(buyer, `/content/${randomUUID()}/detail`);
      const hidden = await get(buyer, `/content/${pieceId}/detail`);
      expect(hidden.body.message).toBe(missing.body.message);
    });

    it('the purchase row is kept, and the creator still sees their own piece', async () => {
      expect(await h.prisma.purchase.count({ where: { id: purchaseId } })).toBe(
        1,
      );
      expect((await get(zed, `/content/${pieceId}/detail`)).status).toBe(200);
    });

    it('after the lift everything is exactly as it was', async () => {
      await lift(zed.sub).expect(200);
      expect(await view()).toEqual(before);
    });
  });

  describe('M2: GET /communities/mine', () => {
    const mine = async (w: Who) => ({
      zedRoom: await mentions(w, '/communities/mine?perPage=50', zedRoom),
      anaRoom: await mentions(w, '/communities/mine?perPage=50', anaRoom),
      total: (await get(w, '/communities/mine?perPage=50')).body.meta?.total,
    });

    it("a member's list leaves the suspended host's room, the host keeps their own list, and the lift brings it back", async () => {
      const beforeAna = await mine(ana);
      const beforeZed = await mine(zed);
      expect(beforeAna.zedRoom).toBe(true);
      expect(beforeZed.zedRoom).toBe(true);

      await suspend(zed.sub).expect(200);
      const during = await mine(ana);
      expect(during.zedRoom).toBe(false);
      expect(during.anaRoom).toBe(true); // her own room is untouched
      // The suspended host still sees their own room, and the room they were let into.
      const own = await mine(zed);
      expect(own.zedRoom).toBe(true);
      expect(own.anaRoom).toBe(true);
      // The room's other routes already answered 404 for the member (assertRoomVisible).
      expect((await get(ana, `/communities/${zedRoom}`)).status).toBe(404);

      await lift(zed.sub).expect(200);
      expect(await mine(ana)).toEqual(beforeAna);
    });
  });

  describe('L1: a person with no UserProfile row', () => {
    it('the ghost has no profile row, and is suspended all the same', async () => {
      expect(
        await h.prisma.userProfile.count({ where: { wawuUserId: ghost.sub } }),
      ).toBe(0);
      const res = await suspend(ghost.sub, 'ghost spec').expect(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          wawuId: ghost.sub,
          suspended: true,
          handle: null,
        }),
      );
      const mine = await get(ghost, '/me/suspension');
      expect(mine.body.data.suspended).toBe(true);
      const refused = await h
        .http()
        .post(`/api/hub/content/${pieceId}/comments`)
        .set(as(ghost))
        .send({ text: 'still here' });
      expect(refused.status).toBe(403);
      expect(refused.body.reason?.code).toBe('account_suspended');
      // Their comment is hidden from others while it lasts.
      expect(
        await mentions(
          buyer,
          `/content/${pieceId}/comments?perPage=100`,
          ghostComment,
        ),
      ).toBe(false);
    });

    it('lifting works, repeats are safe, and somebody the Hub has never heard of is still a 404', async () => {
      await lift(ghost.sub).expect(200);
      expect((await get(ghost, '/me/suspension')).body.data.suspended).toBe(
        false,
      );
      expect(
        await mentions(
          buyer,
          `/content/${pieceId}/comments?perPage=100`,
          ghostComment,
        ),
      ).toBe(true);
      await suspend(randomUUID()).expect(404);
      await h
        .http()
        .get(`/api/hub/admin/users/${randomUUID()}/suspension`)
        .set(admin('support'))
        .expect(404);
    });
  });

  describe('L1: the audit trail holds a dismissed report and a comment or message a report took down', () => {
    const resolve = (id: string, body: object) =>
      h
        .http()
        .post(`/api/hub/admin/reports/${id}/resolve`)
        .set(admin('superadmin'))
        .send(body);
    const report = async (kind: string, targetId: string, subject: Who) =>
      (
        await h.prisma.ugcReport.create({
          data: {
            kind,
            targetId,
            subjectWawuId: subject.sub,
            reporterWawuId: ana.sub,
            reason: 'spam',
          },
          select: { id: true },
        })
      ).id;
    const auditOf = (resourceId: string) =>
      h.prisma.adminOpsAudit.findMany({
        where: { resource: 'ugc_report', resourceId },
      });

    it('a dismissed report writes ugc_report_dismissed with who and the note', async () => {
      const id = await report('comment', ghostComment, ghost);
      const res = await resolve(id, { action: 'dismiss', note: 'fine' }).expect(
        200,
      );
      expect(res.body.data.status).toBe('dismissed');
      const rows = await auditOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          action: 'ugc_report_dismissed',
          subjectWawuId: ghost.sub,
          actedByAdminRole: 'superadmin',
        }),
      );
      expect(rows[0].detail).toEqual(
        expect.objectContaining({ kind: 'comment', note: 'fine' }),
      );
      // Settling it again changes nothing and writes no second row.
      await resolve(id, { action: 'dismiss' }).expect(200);
      expect(await auditOf(id)).toHaveLength(1);
    });

    it('taking a comment down writes ugc_item_removed, once', async () => {
      const comment = (
        await h.prisma.comment.create({
          data: {
            contentId: pieceId,
            authorWawuId: ghost.sub,
            text: `to go ${TAG}`,
          },
          select: { id: true },
        })
      ).id;
      const id = await report('comment', comment, ghost);
      await resolve(id, { action: 'take_down', note: 'abuse' }).expect(200);
      expect(await h.prisma.comment.count({ where: { id: comment } })).toBe(0);
      const rows = await auditOf(comment);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          action: 'ugc_item_removed',
          subjectWawuId: ghost.sub,
        }),
      );
      expect(rows[0].detail).toEqual(
        expect.objectContaining({
          kind: 'comment',
          reportId: id,
          note: 'abuse',
        }),
      );
    });

    it('taking a community message down writes ugc_item_removed too', async () => {
      const msg = (
        await h.prisma.communityMessage.create({
          data: {
            communityId: anaRoom,
            senderWawuId: zed.sub,
            text: `message ${TAG}`,
          },
          select: { id: true },
        })
      ).id;
      const id = await report('community_message', msg, zed);
      await resolve(id, { action: 'take_down', note: 'abuse' }).expect(200);
      expect(
        await h.prisma.communityMessage.count({ where: { id: msg } }),
      ).toBe(0);
      const rows = await auditOf(msg);
      expect(rows.map((r) => r.action)).toEqual(['ugc_item_removed']);
    });

    it('the report queue offers Suspend for a person with no profile row', async () => {
      const target = await h.prisma.comment.create({
        data: { contentId: pieceId, authorWawuId: ghost.sub, text: `q ${TAG}` },
        select: { id: true },
      });
      await report('comment', target.id, ghost);
      const list = await h
        .http()
        .get('/api/hub/admin/reports?perPage=100')
        .set(admin('support'))
        .expect(200);
      const row = (
        list.body.data as Array<{ targetId: string; canSuspend: boolean }>
      ).find((r) => r.targetId === target.id);
      expect(row?.canSuspend).toBe(true);
    });
  });

  describe('H1: the legacy POST /wallet/withdraw while suspended', () => {
    /** A Flutterwave wallet with money in it, for a person with an approved identity check. */
    async function fundedWallet(w: Who): Promise<string> {
      const gw = h.app
        .select(WalletModule)
        .get<FlutterwaveWalletGateway>(FLUTTERWAVE_WALLET_GATEWAY);
      const psa = await gw.createWallet({
        accountName: 'Wallet Holder',
        email: `wd-${w.sub}@test.wawu.dev`,
        country: 'NG',
      });
      await h.prisma.creatorWallet.create({
        data: {
          wawuUserId: w.sub,
          accountReference: psa.accountReference,
          barterId: psa.barterId,
          nuban: psa.nuban,
          bankName: psa.bankName,
          bankCode: psa.bankCode,
        },
      });
      await gw.fundWallet({
        barterId: psa.barterId,
        amount: 50_000,
        reference: `${TAG}-fund-${w.sub}`,
        narration: 'round 2 spec',
      });
      await h.prisma.creatorState.upsert({
        where: { wawuUserId: w.sub },
        create: { wawuUserId: w.sub, kycStatus: 'approved' },
        update: { kycStatus: 'approved' },
      });
      created.wallets.push(w.sub);
      return psa.accountReference;
    }
    const withdraw = (w: Who) =>
      h
        .http()
        .post('/api/hub/wallet/withdraw')
        .set(as(w))
        .send({ amount: 1000, bankCode: '044', accountNumber: '0690000040' });
    const entries = (w: Who) =>
      h.prisma.walletLedgerEntry.count({
        where: { wawuUserId: w.sub, kind: 'withdrawal' },
      });

    it("a stranger's account is 403 account_suspended, with no ledger row; the same call before the suspension goes through (nothing changed for them)", async () => {
      await fundedWallet(sam);
      await fundedWallet(ada);
      const first = await withdraw(sam);
      expect(first.status).toBe(201); // not suspended: the mock names the account ADA OKEKE, and nobody asks whose it is
      expect(await entries(sam)).toBe(1);

      await suspend(sam.sub).expect(200);
      const res = await withdraw(sam);
      expect(res.status).toBe(403);
      expect(res.body.reason).toEqual(
        expect.objectContaining({
          code: 'account_suspended',
          supportEmail: 'support@wawuafrica.com',
        }),
      );
      expect(await entries(sam)).toBe(1); // nothing new
    });

    it('their own account (the bank names them) is paid out', async () => {
      await suspend(ada.sub).expect(200);
      const res = await withdraw(ada);
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          status: 'pending',
          accountName: 'ADA OKEKE',
        }),
      );
      expect(await entries(ada)).toBe(1);
    });

    it('after the lift the stranger account works again', async () => {
      await lift(sam.sub).expect(200);
      expect((await withdraw(sam)).status).toBe(201);
    });
  });
});

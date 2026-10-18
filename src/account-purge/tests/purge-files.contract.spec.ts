// FIX-65: when an account is purged, the person's files leave the bucket.
// Found by SWEEP-MONEY L10 (SETTINGS-06 round 7): the purge deleted the
// StorageObject rows and left the objects. This spec runs the real purge on the
// real database against a small bucket on this machine's loopback (a stand-in
// that answers DELETE like S3 does: 204, 404 for a missing key, or 500 on
// demand). No real storage is called.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountPurgeModule } from '../account-purge.module';
import { AccountPurgeService } from '../account-purge.service';
import { DELETED_CREATOR_ID } from '../../content-piece/deleted-creator';

const BUCKET = 'fix65-bucket';
const ENV: Record<string, string> = {
  STORAGE_ACCESS_KEY_ID: 'fix65-key',
  STORAGE_SECRET_ACCESS_KEY: 'fix65-secret',
  STORAGE_BUCKET: BUCKET,
  STORAGE_REGION: 'auto',
  STORAGE_FORCE_PATH_STYLE: 'true',
  STORAGE_REQUEST_TIMEOUT_MS: '2000',
};

describe('FIX-65: a purged account leaves no file of its own in the bucket', () => {
  jest.setTimeout(120_000);
  let prisma: PrismaService;
  let purge: AccountPurgeService;
  let host: Server;
  const snapshot: Record<string, string | undefined> = {};

  /** What the bucket holds, which keys it refuses, and every DELETE it was sent. */
  const stored = new Set<string>();
  const refuse = new Set<string>();
  const deletes: string[] = [];
  let onDelete: ((key: string) => Promise<void>) | null = null;

  const made = {
    people: [] as string[],
    pieces: [] as string[],
    events: [] as string[],
    keys: [] as string[],
  };

  const keyOf = (url: string | undefined) =>
    decodeURIComponent((url ?? '').split('?')[0]).replace(`/${BUCKET}/`, '');

  async function listen(): Promise<number> {
    host = createServer((req, res) => {
      const key = keyOf(req.url);
      if (req.method !== 'DELETE') {
        res.statusCode = 405;
        res.end();
        return;
      }
      void (async () => {
        deletes.push(key);
        if (onDelete) await onDelete(key);
        if (refuse.has(key)) {
          res.statusCode = 500;
        } else if (stored.delete(key)) {
          res.statusCode = 204;
        } else {
          res.statusCode = 404;
        }
        res.end();
      })();
    });
    for (let port = 7881; port <= 7887; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        host.once('error', () => resolve(false));
        host.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) return (host.address() as AddressInfo).port;
    }
    throw new Error('no free port in 7881-7887');
  }

  beforeAll(async () => {
    const port = await listen();
    Object.assign(ENV, { STORAGE_ENDPOINT: `http://127.0.0.1:${port}` });
    for (const [k, v] of Object.entries(ENV)) {
      snapshot[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AccountPurgeModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    purge = moduleRef.get(AccountPurgeService);
  });

  afterAll(async () => {
    await prisma.purchase.deleteMany({
      where: { contentId: { in: made.pieces } },
    });
    await prisma.accountDeletionContent.deleteMany({
      where: { contentPieceId: { in: made.pieces } },
    });
    await prisma.contentPiece.deleteMany({
      where: { id: { in: made.pieces } },
    });
    await prisma.event.deleteMany({ where: { id: { in: made.events } } });
    await prisma.verificationSubmission.deleteMany({
      where: { wawuUserId: { in: made.people } },
    });
    await prisma.accountDeletion.deleteMany({
      where: { wawuUserId: { in: made.people } },
    });
    await prisma.storageObject.deleteMany({
      where: { key: { in: made.keys } },
    });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A file the person uploaded: an object in the bucket and its row. */
  async function upload(
    owner: string,
    folder: string,
    ext = 'jpg',
    contentType = 'image/jpeg',
  ): Promise<string> {
    const key = `${folder}/${owner}/${randomUUID()}.${ext}`;
    stored.add(key);
    made.keys.push(key);
    await prisma.storageObject.create({
      data: {
        wawuUserId: owner,
        key,
        bytes: 100,
        contentType,
        folder,
        status: 'confirmed',
        confirmedAt: new Date(),
      },
    });
    return key;
  }

  async function piece(creator: string, preview: string, full: string) {
    const id = randomUUID();
    made.pieces.push(id);
    return prisma.contentPiece.create({
      data: {
        id,
        slug: `fix65-${id}`,
        creatorWawuId: creator,
        contentType: 'pdf',
        title: 'A guide',
        description: 'A guide.',
        category: 'beauty',
        tags: [],
        specializations: [],
        accessType: 'paid',
        price: 500000,
        previewAssetUrl: preview,
        fullAssetUrl: full,
        status: 'live',
      },
    });
  }

  /** A deletion that has run its 30 days and been confirmed by WAWU ID, as the sweep leaves it when it calls the purge. */
  const dueDeletion = (wawuUserId: string) =>
    prisma.accountDeletion.create({
      data: {
        wawuUserId,
        status: 'purging',
        scheduledAt: new Date(Date.now() - 31 * 86_400_000),
        purgeAfter: new Date(Date.now() - 60_000),
        identityMarkedAt: new Date(),
      },
    });

  /** Every kind of file one person can upload, with the decision FIX-65 makes for it. */
  async function world() {
    const p = randomUUID();
    const other = randomUUID();
    const buyer = randomUUID();
    made.people.push(p, other, buyer);
    const t = {
      avatar: await upload(p, 'avatars'),
      cover: await upload(p, 'profile/cover'),
      work: await upload(p, 'profile/work', 'mp4', 'video/mp4'),
      unsoldPreview: await upload(p, 'content/preview'),
      unsoldFull: await upload(p, 'content/full', 'pdf', 'application/pdf'),
      stray: await upload(p, 'content/full'),
      communityCover: await upload(p, 'community/image'),
      communityPhoto: await upload(p, 'community/message'),
      speaker: await upload(p, 'event/speaker'),
      banner: await upload(p, 'event/banner'),
      chatPhoto: await upload(p, 'chat/media'),
      chatPdf: await upload(p, 'chat/file', 'pdf', 'application/pdf'),
      legal: await upload(p, 'legal/document', 'pdf', 'application/pdf'),
      voice: await upload(p, 'ai/voiceover', 'mp3', 'audio/mpeg'),
      // kept for buyers
      soldPreview: await upload(p, 'content/preview'),
      soldFull: await upload(p, 'content/full', 'pdf', 'application/pdf'),
      // kept for the owner
      kyc: await upload(p, 'kyc/id-document'),
      application: await upload(
        p,
        'service-application/document',
        'pdf',
        'application/pdf',
      ),
      licence: await upload(
        p,
        'professional/document',
        'pdf',
        'application/pdf',
      ),
      // a verification document the client uploaded to a folder meant for something else
      verificationDoc: await upload(p, 'avatars'),
      // an event that still stands shows this banner
      standingBanner: await upload(p, 'event/banner'),
      // another person's, which must not move
      otherAvatar: await upload(other, 'avatars'),
      otherChat: await upload(other, 'chat/media'),
      otherKyc: await upload(other, 'kyc/id-document'),
    };
    const unsold = await piece(p, t.unsoldPreview, t.unsoldFull);
    const sold = await piece(p, t.soldPreview, t.soldFull);
    await prisma.purchase.create({
      data: {
        contentId: sold.id,
        type: 'content',
        buyerWawuId: buyer,
        creatorWawuId: p,
        amount: 500000,
        commissionRate: '0.15',
        flutterwaveTxRef: `fix65-${randomUUID()}`,
        status: 'completed',
      },
    });
    await prisma.verificationSubmission.create({
      data: {
        wawuUserId: p,
        tier: 'verified_user',
        documents: [t.verificationDoc],
      },
    });
    const event = await prisma.event.create({
      data: {
        hostWawuId: 'erased-host',
        name: 'A kept event',
        description: 'Its host left; buyers still hold tickets.',
        hostOrg: 'Org',
        format: 'in_person',
        type: 'workshop',
        startsAt: new Date(Date.now() - 86_400_000),
        location: 'Lagos',
        status: 'removed',
        bannerUrl: `https://bucket.example/${BUCKET}/${t.standingBanner}?X-Amz-Signature=x`,
      },
    });
    made.events.push(event.id);
    return { p, other, buyer, t, unsold, sold };
  }

  const rowsOf = (wawuUserId: string) =>
    prisma.storageObject.findMany({
      where: { wawuUserId },
      select: { key: true },
    });
  const holds = (...keys: string[]) => keys.every((k) => stored.has(k));
  const goneFrom = (...keys: string[]) => keys.every((k) => !stored.has(k));

  it('does nothing to a file until the deletion is due and confirmed by WAWU ID', async () => {
    const w = await world();
    // scheduled, with 30 days still to run
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: w.p,
        status: 'scheduled',
        purgeAfter: new Date(Date.now() + 5 * 86_400_000),
        identityMarkedAt: new Date(),
      },
    });
    deletes.length = 0;
    const early = await purge.purge(w.p);
    expect(early.failed).toContain('StorageObject.wawuUserId');
    expect(deletes).toEqual([]);
    expect(holds(w.t.avatar, w.t.chatPhoto, w.t.unsoldFull, w.t.kyc)).toBe(
      true,
    );
    expect((await rowsOf(w.p)).length).toBeGreaterThan(0);

    // 30 days over, but WAWU ID has not confirmed the deletion started
    await prisma.accountDeletion.update({
      where: { wawuUserId: w.p },
      data: {
        status: 'purging',
        scheduledAt: new Date(Date.now() - 31 * 86_400_000),
        purgeAfter: new Date(Date.now() - 60_000),
        identityMarkedAt: null,
      },
    });
    const unconfirmed = await purge.purge(w.p);
    expect(unconfirmed.failed).toContain('StorageObject.wawuUserId');
    expect(deletes).toEqual([]);
    expect(holds(w.t.avatar, w.t.chatPhoto, w.t.unsoldFull, w.t.kyc)).toBe(
      true,
    );

    // the same rule, with no deletion row at all
    await prisma.accountDeletion.delete({ where: { wawuUserId: w.p } });
    const none = await purge.purge(w.p);
    expect(none.failed).toContain('StorageObject.wawuUserId');
    expect(deletes).toEqual([]);
  });

  it('deletes what nobody else has a right to, keeps what buyers and the owner hold, touches no one else', async () => {
    const w = await world();
    await dueDeletion(w.p);
    deletes.length = 0;
    // the first object is removed only after the database rows that point at it are gone
    let piecesLeftAtFirstDelete = -1;
    onDelete = async () => {
      if (piecesLeftAtFirstDelete === -1) {
        piecesLeftAtFirstDelete = await prisma.contentPiece.count({
          where: { creatorWawuId: w.p },
        });
      }
    };
    const out = await purge.purge(w.p);
    onDelete = null;
    expect(out.failed).toEqual([]);
    expect(piecesLeftAtFirstDelete).toBe(0);

    // DELETE kinds: gone from the bucket
    expect(
      goneFrom(
        w.t.avatar,
        w.t.cover,
        w.t.work,
        w.t.unsoldPreview,
        w.t.unsoldFull,
        w.t.stray,
        w.t.communityCover,
        w.t.communityPhoto,
        w.t.speaker,
        w.t.banner,
        w.t.chatPhoto,
        w.t.chatPdf,
        w.t.legal,
        w.t.voice,
      ),
    ).toBe(true);
    expect(out.files.objectsRemoved).toBe(14);

    // KEEP for buyers: the sold piece's preview and full file
    expect(holds(w.t.soldPreview, w.t.soldFull)).toBe(true);
    expect(
      await prisma.storageObject.count({
        where: {
          wawuUserId: DELETED_CREATOR_ID,
          key: { in: [w.t.soldPreview, w.t.soldFull] },
        },
      }),
    ).toBe(2);

    // OWNER: identity and verification files stay, whatever folder the client chose
    expect(
      holds(w.t.kyc, w.t.application, w.t.licence, w.t.verificationDoc),
    ).toBe(true);
    expect(
      await prisma.storageObject.count({
        where: {
          wawuUserId: DELETED_CREATOR_ID,
          key: {
            in: [w.t.kyc, w.t.application, w.t.licence, w.t.verificationDoc],
          },
        },
      }),
    ).toBe(4);
    expect(out.files.ownerKept).toBe(4);

    // an event that still stands keeps its banner
    expect(holds(w.t.standingBanner)).toBe(true);
    expect(out.files.eventKept).toBe(1);

    // nothing is left under the person, and nothing was sent for a file that stays
    expect(await rowsOf(w.p)).toEqual([]);
    for (const kept of [
      w.t.soldPreview,
      w.t.soldFull,
      w.t.kyc,
      w.t.application,
      w.t.licence,
      w.t.verificationDoc,
      w.t.standingBanner,
    ]) {
      expect(deletes).not.toContain(kept);
    }

    // another person's files and rows are untouched
    expect(holds(w.t.otherAvatar, w.t.otherChat, w.t.otherKyc)).toBe(true);
    expect((await rowsOf(w.other)).map((r) => r.key).sort()).toEqual(
      [w.t.otherAvatar, w.t.otherChat, w.t.otherKyc].sort(),
    );
    expect(deletes).not.toContain(w.t.otherAvatar);
  });

  it('a second run finds nothing to do', async () => {
    const w = await world();
    await dueDeletion(w.p);
    await purge.purge(w.p);
    deletes.length = 0;
    const again = await purge.purge(w.p);
    expect(again.failed).toEqual([]);
    expect(again.files).toEqual({
      objectsRemoved: 0,
      ownerKept: 0,
      eventKept: 0,
    });
    expect(deletes).toEqual([]);
    expect(holds(w.t.kyc, w.t.soldFull)).toBe(true);
  });

  it('a file the bucket refuses keeps its row and is retried; a missing object is not an error', async () => {
    const w = await world();
    await dueDeletion(w.p);
    refuse.add(w.t.chatPdf);
    stored.delete(w.t.cover); // never reached the bucket: the bucket answers 404
    const first = await purge.purge(w.p);
    expect(first.failed).toContain('StorageObject.wawuUserId');
    expect(holds(w.t.chatPdf)).toBe(true);
    expect((await rowsOf(w.p)).map((r) => r.key)).toEqual([w.t.chatPdf]);
    expect(goneFrom(w.t.avatar, w.t.chatPhoto, w.t.legal, w.t.cover)).toBe(
      true,
    );

    refuse.delete(w.t.chatPdf);
    const second = await purge.purge(w.p);
    expect(second.failed).toEqual([]);
    expect(goneFrom(w.t.chatPdf)).toBe(true);
    expect(await rowsOf(w.p)).toEqual([]);
  });

  it("never deletes an object whose key is not in the person's own folder", async () => {
    const w = await world();
    await dueDeletion(w.p);
    // a row of the person that names somebody else's object (should never happen)
    const foreign = `avatars/${w.other}/${randomUUID()}.jpg`;
    stored.add(foreign);
    made.keys.push(foreign);
    await prisma.storageObject.create({
      data: {
        wawuUserId: w.p,
        key: foreign,
        bytes: 1,
        contentType: 'image/jpeg',
        folder: 'avatars',
        status: 'confirmed',
      },
    });
    deletes.length = 0;
    const out = await purge.purge(w.p);
    expect(out.failed).toEqual([]);
    expect(holds(foreign)).toBe(true);
    expect(deletes).not.toContain(foreign);
    expect(await rowsOf(w.p)).toEqual([]);
  });

  describe('round 2: a pass that stops halfway never lets a later pass delete an identity file', () => {
    /** A person whose verification document sits in an ordinary folder (avatars), as an off-standard client files it. */
    async function filedElsewhere() {
      const p = randomUUID();
      made.people.push(p);
      await dueDeletion(p);
      const t = {
        document: await upload(p, 'avatars'),
        licence: await upload(
          p,
          'professional/document',
          'pdf',
          'application/pdf',
        ),
        avatar: await upload(p, 'avatars'),
        chat: await upload(p, 'chat/media'),
      };
      await prisma.verificationSubmission.create({
        data: { wawuUserId: p, tier: 'verified_user', documents: [t.document] },
      });
      return { p, t };
    }

    it('keeps it and refiles it when the first pass fails on one table and the second finishes', async () => {
      const w = await filedElsewhere();
      deletes.length = 0;
      const fail = jest
        .spyOn(prisma.profileWork, 'deleteMany')
        .mockRejectedValueOnce(new Error('injected: one table fails'));
      const first = await purge.purge(w.p);
      fail.mockRestore();
      expect(first.failed).toEqual(['ProfileWork.wawuUserId']);
      // the first pass touched no file, but the rows that named the document are gone
      expect(deletes).toEqual([]);
      expect(
        await prisma.verificationSubmission.count({
          where: { wawuUserId: w.p },
        }),
      ).toBe(0);
      // and the document is already no longer the person's
      expect(
        (
          await prisma.storageObject.findMany({ where: { key: w.t.document } })
        ).map((r) => r.wawuUserId),
      ).toEqual([DELETED_CREATOR_ID]);

      const second = await purge.purge(w.p);
      expect(second.failed).toEqual([]);
      expect(deletes).not.toContain(w.t.document);
      expect(deletes).not.toContain(w.t.licence);
      expect(holds(w.t.document, w.t.licence)).toBe(true);
      expect(goneFrom(w.t.avatar, w.t.chat)).toBe(true);
      expect(
        (
          await prisma.storageObject.findMany({
            where: { key: { in: [w.t.document, w.t.licence] } },
          })
        ).map((r) => r.wawuUserId),
      ).toEqual([DELETED_CREATOR_ID, DELETED_CREATOR_ID]);
      expect(await rowsOf(w.p)).toEqual([]);
    });

    it('leaves the identity rows alone when the purge cannot tell which files they name', async () => {
      const w = await filedElsewhere();
      deletes.length = 0;
      const fail = jest
        .spyOn(prisma.verificationSubmission, 'findMany')
        .mockRejectedValueOnce(new Error('injected: the look-up fails'));
      const first = await purge.purge(w.p);
      fail.mockRestore();
      expect(first.failed).toContain('VerificationSubmission.wawuUserId');
      expect(first.failed).toContain('StorageObject.wawuUserId');
      expect(deletes).toEqual([]);
      expect(
        await prisma.verificationSubmission.count({
          where: { wawuUserId: w.p },
        }),
      ).toBe(1);

      const second = await purge.purge(w.p);
      expect(second.failed).toEqual([]);
      expect(holds(w.t.document, w.t.licence)).toBe(true);
      expect(deletes).not.toContain(w.t.document);
      expect(goneFrom(w.t.avatar, w.t.chat)).toBe(true);
      expect(await rowsOf(w.p)).toEqual([]);
    });
  });
});

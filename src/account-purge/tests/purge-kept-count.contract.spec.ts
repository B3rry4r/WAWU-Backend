// SWEEP-LATE V1 (FIX-65): the purge note says how many identity files and event
// images were kept. A file of a bought piece that a client filed outside the
// two content folders (the client names the folder at presign) is kept for the
// buyers, so it is not one of those. Database only: no bucket, no provider.
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DELETED_CREATOR_ID } from '../../content-piece/deleted-creator';
import { countKeptFiles } from '../purge-files';

describe('SWEEP-LATE V1: the kept-file count leaves out the files kept for buyers', () => {
  jest.setTimeout(60_000);
  let prisma: PrismaService;
  const keys: string[] = [];
  const pieces: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.contentPiece.deleteMany({ where: { id: { in: pieces } } });
    await prisma.storageObject.deleteMany({ where: { key: { in: keys } } });
    await prisma.$disconnect();
  });

  /** A file row already refiled under the deleted account, as an earlier pass leaves it. */
  async function refiled(folder: string, person: string): Promise<string> {
    const key = `${folder}/${person}/${randomUUID()}.jpg`;
    keys.push(key);
    await prisma.storageObject.create({
      data: {
        wawuUserId: DELETED_CREATOR_ID,
        key,
        bytes: 10,
        contentType: 'image/jpeg',
        folder,
        status: 'confirmed',
        confirmedAt: new Date(),
      },
    });
    return key;
  }

  /** A bought piece, kept hidden by the deleted account, that names these files. */
  async function keptPiece(
    preview: string,
    full: string,
    frames: string[],
  ): Promise<void> {
    const id = randomUUID();
    pieces.push(id);
    await prisma.contentPiece.create({
      data: {
        id,
        slug: `removed-${id}`,
        creatorWawuId: DELETED_CREATOR_ID,
        contentType: 'image',
        title: 'A set',
        description: 'A set.',
        category: 'beauty',
        tags: [],
        specializations: [],
        accessType: 'paid',
        price: 500000,
        previewAssetUrl: preview,
        fullAssetUrl: full,
        status: 'removed',
        frames: {
          create: frames.map((url, position) => ({ url, position })),
        },
      },
    });
  }

  it('counts the identity files and the event image, and not the files of a bought piece the client filed anywhere', async () => {
    const p = randomUUID();
    const other = randomUUID();

    // What the note is about.
    await refiled('kyc/id-document', p);
    await refiled('professional/document', p);
    await refiled('event/banner', p);

    // A bought piece: its files are in the two content folders (already left
    // out by folder), and three more the client filed elsewhere.
    const preview = await refiled('content/preview', p);
    const strayFull = await refiled('avatars', p);
    const strayFrame = await refiled('profile/work', p);
    const strayAsLink = await refiled('community/image', p);
    await keptPiece(preview, `https://files.example.test/${strayFull}`, [
      strayFrame,
      `https://files.example.test/${strayAsLink}`,
    ]);

    // Another person's kept files are never counted for this one.
    await refiled('kyc/id-document', other);
    const otherStray = await refiled('avatars', other);
    await keptPiece(otherStray, otherStray, []);

    expect(await countKeptFiles(prisma, p)).toEqual({
      ownerKept: 2,
      eventKept: 1,
    });
    expect(await countKeptFiles(prisma, other)).toEqual({
      ownerKept: 1,
      eventKept: 0,
    });
  });

  it('counts a file that no kept piece names, even in a folder a piece could use', async () => {
    const p = randomUUID();
    await refiled('avatars', p);
    await refiled('kyc/id-document', p);
    expect(await countKeptFiles(prisma, p)).toEqual({
      ownerKept: 2,
      eventKept: 0,
    });
  });
});

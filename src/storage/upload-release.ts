import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  type Logger,
} from '@nestjs/common';
import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PrismaService } from '../common/prisma/prisma.service';

/**
 * ME-04 round 2: a person who takes a file out of an unfinished draft gives
 * its space back. A presigned upload is counted the moment it is reserved, and
 * until now nothing but the reconcile job ever uncounted one, so a wrong pick
 * burned storage for good.
 *
 * `POST /uploads/release` is for an upload that is the caller's own and that no
 * listing has claimed yet. It deletes the object from the bucket and marks the
 * row `abandoned`, which is the state the usage sum already leaves out. The row
 * is kept (not deleted) so a repeated call finds it and answers the same way.
 *
 * What it answers when it cannot help says nothing about whether the key
 * exists: another person's key, a key that was never reserved and a key in a
 * folder this route does not handle all get the same 404.
 */
export const UPLOAD_NOT_FOUND = 'That upload was not found.';

export interface ReleaseDeps {
  client: S3Client | null;
  bucket: string;
  /** The folders whose files count against the allowance (the only ones this releases). */
  folders: readonly string[];
  prisma: PrismaService;
  logger: Logger;
}

/**
 * Whether a listing already points at the object. A content piece stores the
 * `fileUrl` the presign answered with (or the key itself), a photo set stores
 * one per frame, and the key is a random id inside either, so a text match on
 * the key finds both forms. Every piece counts, whoever made it and whatever
 * its status: a removed piece still holds its row.
 */
async function isClaimed(prisma: PrismaService, key: string): Promise<boolean> {
  const [piece, frame] = await Promise.all([
    prisma.contentPiece.findFirst({
      where: {
        OR: [
          { previewAssetUrl: { contains: key } },
          { fullAssetUrl: { contains: key } },
        ],
      },
      select: { id: true },
    }),
    prisma.contentFrame.findFirst({
      where: { url: { contains: key } },
      select: { id: true },
    }),
  ]);
  return Boolean(piece ?? frame);
}

export async function releaseOwnUpload(
  deps: ReleaseDeps,
  wawuId: string,
  key: string,
): Promise<{ released: true }> {
  const { client, bucket, folders, prisma, logger } = deps;
  if (!client) {
    throw new ServiceUnavailableException(
      'File uploads are not available on this environment yet.',
    );
  }

  const row = await prisma.storageObject.findUnique({ where: { key } });
  if (!row || row.wawuUserId !== wawuId || !folders.includes(row.folder)) {
    throw new NotFoundException(UPLOAD_NOT_FOUND);
  }
  if (await isClaimed(prisma, key)) {
    throw new ConflictException({
      message: 'That file is already part of a listing.',
      reason: { code: 'upload_claimed' },
    });
  }

  // The object first, the row second: if the bucket cannot be reached the
  // space stays counted and the same call can be made again. Deleting a key
  // that is already gone is a success in S3, which is what makes a repeat safe.
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status !== 404) {
      logger.warn(`Could not delete storage object ${key}: ${String(err)}`);
      throw new ServiceUnavailableException(
        'Could not remove that file right now. Try again in a moment.',
      );
    }
  }
  await prisma.storageObject.updateMany({
    where: { id: row.id, status: { in: ['pending', 'confirmed'] } },
    data: { status: 'abandoned' },
  });
  return { released: true };
}

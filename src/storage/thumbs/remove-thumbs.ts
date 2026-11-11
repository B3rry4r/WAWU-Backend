import type { Logger } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { deleteFromBucket } from '../bucket-delete';
import { thumbKeysOf } from './thumb-keys';

/**
 * HUB-THUMBS: when an original picture is deleted from the bucket (a release of a cover or preview, the late-file
 * sweep), its small copies go with it: the objects first, then their rows once the objects are gone. A copy that
 * cannot be deleted keeps its row (the account purge removes it with the rest of the person's files). Never
 * throws. Deleting is not a write, so this file may sit outside StorageService.
 *
 * R-130: a piece taken down stays with its buyers, so nothing here runs on a take-down. A take-down changes the
 * piece, not the files; the original (and so its copies) stays for the buyers' My purchases. The copies go only
 * when the original is really deleted, and then the buyer has lost the original too.
 */
export async function removeThumbs(
  deps: {
    client: S3Client;
    bucket: string;
    prisma: Pick<PrismaService, 'storageObject'>;
    logger: Pick<Logger, 'warn'>;
  },
  originalKey: string,
): Promise<void> {
  for (const key of thumbKeysOf(originalKey)) {
    try {
      const out = await deleteFromBucket(deps.client, deps.bucket, key);
      if (out.result === 'gone')
        await deps.prisma.storageObject.deleteMany({ where: { key } });
      else deps.logger.warn(`Could not remove thumbnail ${key}: ${out.result}`);
    } catch (e) {
      deps.logger.warn(`Could not remove thumbnail ${key}: ${String(e)}`);
    }
  }
}

import { randomUUID } from 'crypto';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { StorageService } from '../../storage/storage.service';

/**
 * A photo the way a sender really has one (FIX-77): the `fileUrl` that
 * `POST /uploads/presign` hands back for the `community/message` folder, with
 * the sender's own `StorageObject` row behind it. A message photo must be
 * exactly that, so every spec that sends a photo into a room builds it here
 * instead of writing a link by hand.
 *
 * Nothing here reaches a bucket: a read link is signed locally for a bucket
 * that exists only in this process, and the rows are the spec's own.
 */

/** A bucket that exists only in this process (links are signed, nothing is sent). */
const TEST_BUCKET_ENV: Record<string, string | undefined> = {
  STORAGE_ENDPOINT: 'https://storage.test.invalid',
  STORAGE_BUCKET: 'wawu-photo-test',
  STORAGE_ACCESS_KEY_ID: 'test-key',
  STORAGE_SECRET_ACCESS_KEY: 'test-secret',
  STORAGE_REGION: 'auto',
  // Virtual-hosted style, as the real bucket is.
  STORAGE_FORCE_PATH_STYLE: undefined,
};

/**
 * Points the storage settings at the in-process bucket. Call it before the
 * Nest application is built (the settings are read when it boots). Returns a
 * function that puts the earlier values back; call it in `afterAll`.
 */
export function useTestBucket(): () => void {
  const before = Object.fromEntries(
    Object.keys(TEST_BUCKET_ENV).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(TEST_BUCKET_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** The photos a spec has made, so `afterAll` can remove their rows. */
export class PhotoUploads {
  private readonly keys: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * One photo for `wawuId`: the row presign writes (`pending`, as the web
   * leaves it) or the one confirm makes (`confirmed`, as the app leaves it),
   * and the signed read link that stands for it.
   */
  async link(
    wawuId: string,
    status: 'pending' | 'confirmed' = 'pending',
  ): Promise<string> {
    const key = `community/message/${wawuId}/${randomUUID()}.png`;
    await this.prisma.storageObject.create({
      data: {
        wawuUserId: wawuId,
        key,
        bytes: 1000,
        contentType: 'image/png',
        folder: 'community/message',
        status,
        confirmedAt: status === 'confirmed' ? new Date() : null,
      },
    });
    this.keys.push(key);
    return this.storage.readUrlFor(key);
  }

  /** Removes every row this made. */
  async clean(): Promise<void> {
    if (this.keys.length === 0) return;
    await this.prisma.storageObject.deleteMany({
      where: { key: { in: this.keys } },
    });
    this.keys.length = 0;
  }
}

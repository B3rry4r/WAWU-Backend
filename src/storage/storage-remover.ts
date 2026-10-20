import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import { deleteFromBucket } from './bucket-delete';
import { createStorageClient } from './storage-client';

/** What a removal of many objects came to. */
export interface RemoveManyResult {
  /** Keys that are not in the bucket any more (deleted now, or never there). */
  gone: string[];
  /**
   * Keys that are still there as far as the Hub knows: the bucket refused, did
   * not answer, or the time ran out before the key was tried.
   */
  left: string[];
  /** True when it stopped before trying every key (time ran out, or a whole group got no answer). */
  stopped: boolean;
}

/** Deletes in flight at once: enough to be quick, few enough not to flood the bucket. */
const AT_ONCE = 8;

/**
 * Removes objects from the Hub's bucket for the account purge (FIX-65). It is
 * the same bucket, credentials and timeouts as StorageService (both build the
 * client with `createStorageClient`) and the same delete (`deleteFromBucket`);
 * it exists apart from StorageService so the purge does not pull in the
 * upload routes and the publishing gate to reach one DELETE.
 *
 * Every call is a network call: the caller holds no transaction and no lock.
 * Idempotent: deleting a key that is not there is `gone`, never an error.
 */
@Injectable()
export class StorageRemover {
  private readonly logger = new Logger(StorageRemover.name);
  private readonly made: { client: S3Client; bucket: string } | null;

  constructor(config: ConfigService) {
    this.made = createStorageClient(config);
  }

  /** False when the Hub has no bucket (STORAGE_* unset): there is nothing it could remove. */
  get isConfigured(): boolean {
    return this.made !== null;
  }

  /**
   * Deletes each key, `AT_ONCE` at a time, and stops starting new ones once
   * `deadline` (epoch ms) has passed or a whole group got no answer (a bucket
   * that is down costs one group of timeouts, not one per key). Keys it did
   * not reach are in `left`.
   */
  async removeMany(
    keys: readonly string[],
    deadline: number,
  ): Promise<RemoveManyResult> {
    const out: RemoveManyResult = { gone: [], left: [], stopped: false };
    if (!this.made) {
      out.left.push(...keys);
      out.stopped = true;
      return out;
    }
    const { client, bucket } = this.made;
    for (let i = 0; i < keys.length; i += AT_ONCE) {
      if (Date.now() > deadline) {
        out.left.push(...keys.slice(i));
        out.stopped = true;
        return out;
      }
      const group = keys.slice(i, i + AT_ONCE);
      const outcomes = await Promise.all(
        group.map((key) => deleteFromBucket(client, bucket, key)),
      );
      let any = false;
      outcomes.forEach((o, n) => {
        if (o.result === 'gone') {
          any = true;
          out.gone.push(group[n]);
        } else {
          out.left.push(group[n]);
          this.logger.warn(`Could not remove ${group[n]}: ${o.result}`);
        }
      });
      if (!any) {
        out.left.push(...keys.slice(i + AT_ONCE));
        out.stopped = true;
        return out;
      }
    }
    return out;
  }
}

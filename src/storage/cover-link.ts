import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import { createStorageClient } from './storage-client';
import { signReadLink } from './read-link';

/**
 * CONTENT-COVER (R-114): signs a read link for a piece's cover from its stored key, for the views that live in a module
 * that does not import StorageModule (the money module's earnings rows). Same bucket, credentials and read rules as
 * `StorageService.readUrlFor` (the type and the disposition are forced from the key, so the uploader decides neither).
 * Nothing is sent to the bucket: a link is signed locally. Null when storage is not configured or signing fails, never
 * an error, so a row without its picture is still a row.
 */
@Injectable()
export class CoverLinkService {
  private readonly logger = new Logger(CoverLinkService.name);
  private readonly made: { client: S3Client; bucket: string } | null;

  constructor(config: ConfigService) {
    this.made = createStorageClient(config);
  }

  async linkFor(key: string | null | undefined): Promise<string | null> {
    if (!key || !this.made) return null;
    try {
      return await signReadLink(this.made.client, {
        bucket: this.made.bucket,
        key,
      });
    } catch (err) {
      this.logger.warn(`Could not sign the cover ${key}: ${String(err)}`);
      return null;
    }
  }
}

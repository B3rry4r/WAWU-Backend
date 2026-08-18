import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FOLDER_CONTENT_TYPES, type UploadFolder } from './dto/presign-upload.dto';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3-compatible object storage (Railway bucket / R2 / S3).
 *
 * Why this module exists: nothing in this API could accept a file. Every
 * upload surface in the web client — content publishing, KYC ID documents,
 * CAC/NEPC supporting documents — sent an empty string where a URL was
 * required, so `POST /content` (previewAsset is `@IsUrl()`) always 400'd and
 * creators could not publish at all.
 *
 * The client never receives bucket credentials. It asks for a short-lived
 * presigned PUT URL, uploads the bytes straight to storage, and then sends
 * the returned object URL back on the normal create/submit call.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('STORAGE_ENDPOINT');
    const accessKeyId = this.config.get<string>('STORAGE_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('STORAGE_SECRET_ACCESS_KEY');
    this.bucket = this.config.get<string>('STORAGE_BUCKET') ?? '';

    // Storage is optional at boot so the rest of the API still runs in
    // environments where it isn't configured yet — but every upload request
    // then fails loudly (503) instead of handing back a broken URL.
    if (!endpoint || !accessKeyId || !secretAccessKey || !this.bucket) {
      this.logger.warn(
        'Object storage is not configured (STORAGE_ENDPOINT / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY / STORAGE_BUCKET). Uploads will be rejected.',
      );
      this.client = null;
      return;
    }

    this.client = new S3Client({
      region: this.config.get<string>('STORAGE_REGION') ?? 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // Railway Buckets use virtual-hosted-style URLs (bucket as subdomain),
      // which is the S3 default. Buckets created before that change need
      // path-style — set STORAGE_FORCE_PATH_STYLE=true for those.
      forcePathStyle: this.config.get<string>('STORAGE_FORCE_PATH_STYLE') === 'true',
    });
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Issues a short-lived PUT URL plus the URL the object will be readable at.
   *
   * `folder` is constrained by the DTO and the key is always namespaced by
   * the caller's own wawuId, so one account can never overwrite another's
   * object.
   */
  async presignUpload(
    wawuId: string,
    folder: UploadFolder,
    contentType: string,
    extension: string,
    contentLength: number,
  ): Promise<{ uploadUrl: string; key: string; fileUrl: string }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File uploads are not available on this environment yet.',
      );
    }

    // Per-destination allowlist. Without it any signed-in user could store
    // text/html or image/svg+xml and get a URL that serves it executable
    // from the storage origin.
    const allowed = FOLDER_CONTENT_TYPES[folder] ?? [];
    if (!allowed.includes(contentType)) {
      throw new BadRequestException(
        `${contentType} is not allowed in ${folder}. Allowed: ${allowed.join(', ')}.`,
      );
    }

    const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'bin';
    const key = `${folder}/${wawuId}/${randomUUID()}.${safeExt}`;

    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        // Signing for an exact length makes storage itself enforce the cap:
        // an upload of any other size is rejected.
        ContentLength: contentLength,
        // Never render an uploaded object inline in the browser, even if a
        // future allowlist entry turns out to be scriptable.
        ContentDisposition: 'attachment',
      }),
      { expiresIn: 300 },
    );

    return { uploadUrl, key, fileUrl: await this.readUrlFor(key) };
  }

  /**
   * Signs a SHORT-LIVED read URL for a stored object key. Used for sensitive
   * documents (KYC IDs) which must never be persisted as long-lived bearer
   * URLs: anyone holding such a string — from a log, a DB dump, a proxy or
   * browser history — could read a government ID with no authentication.
   */
  async signedReadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (key.startsWith('http://') || key.startsWith('https://')) return key;
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File uploads are not available on this environment yet.',
      );
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  /**
   * A long-lived presigned GET URL. Buckets here are private, so a bare
   * object URL would not resolve — this is what gets stored as
   * `previewAsset` / `idDocumentUrl` and rendered by the client.
   */
  async readUrlFor(key: string): Promise<string> {
    if (key.startsWith('http://') || key.startsWith('https://')) return key;
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File uploads are not available on this environment yet.',
      );
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 604800 },
    );
  }
}

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FOLDER_CONTENT_TYPES,
  EXTENSION_FOR_CONTENT_TYPE,
  serveAs,
  type UploadFolder,
} from './dto/presign-upload.dto';
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
      // MUST stay 'WHEN_REQUIRED'. Since v3.729 the SDK defaults to
      // 'WHEN_SUPPORTED', which adds an integrity checksum to every
      // PutObject. Presigning has no body to checksum, so it hashed NOTHING
      // and baked `x-amz-checksum-crc32=AAAAAA==` — CRC32 of zero bytes —
      // into the signed URL. The browser then PUT the real file, whose
      // checksum is obviously not that, and storage rejected every single
      // upload with 400 Bad Request. KYC documents, content assets, CAC and
      // NEPC paperwork: none of it could be uploaded at all.
      requestChecksumCalculation: 'WHEN_REQUIRED',
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

    // The extension comes from the type we just VALIDATED, not from the
    // client's `extension` field — see EXTENSION_FOR_CONTENT_TYPE. The key is
    // what read URLs use to decide how to serve the bytes, so letting the
    // caller name it would hand back the control the allowlist just took.
    const safeExt = EXTENSION_FOR_CONTENT_TYPE[contentType];
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
        // ContentDisposition is deliberately NOT set here.
        //
        // Signing it put `content-disposition` in X-Amz-SignedHeaders, which
        // obliges the browser to send that exact header on the PUT. Our
        // uploader sends only Content-Type, so once the checksum bug above
        // was fixed this would have been the next failure — a signature
        // mismatch instead of a checksum one. Asking the client to send it
        // would also mean it is only enforced while the client cooperates.
        //
        // The protection it existed for now happens at READ time, where it
        // cannot be bypassed: see signedReadUrl below.
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
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Sensitive documents are never rendered in place.
        ResponseContentType: serveAs(key).contentType,
        ResponseContentDisposition: 'attachment',
      }),
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
    // Force both the type and the disposition on the way out. The uploader
    // cannot influence either, so bytes that were smuggled in under a false
    // Content-Type are still served as the kind of file the key says.
    const { contentType, inline } = serveAs(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: inline ? 'inline' : 'attachment',
      }),
      { expiresIn: 604800 },
    );
  }
}

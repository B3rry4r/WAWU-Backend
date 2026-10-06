import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FOLDER_CONTENT_TYPES,
  FOLDER_MAX_BYTES,
  EXTENSION_FOR_CONTENT_TYPE,
  UPLOAD_FOLDERS,
  serveAs,
  type UploadFolder,
} from './dto/presign-upload.dto';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FREE_STORAGE_BYTES,
  FREE_UPLOADS,
  TICK_COLUMNS,
  TICK_STORAGE_BYTES,
  TICK_UPLOADS,
  holdsTick,
  storageAllowanceFor,
  uploadAllowanceFor,
} from '../common/creator-allowance';
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

/**
 * How long after presign a `pending` row is settled against the bucket. See
 * reconcileStale for why this is much longer than the 300s URL expiry.
 */
const RECONCILE_GRACE_MS = 15 * 60 * 1000;

/**
 * The folders that hold creator content, the only ones R-7's storage
 * allowance counts and limits. Every other folder (KYC and other documents,
 * avatars, covers, community and chat images, speaker photos) is exempt.
 */
export const CONTENT_FOLDERS: readonly string[] = [
  'content/preview',
  'content/full',
];

/**
 * Creator-content storage only: `usedBytes` sums `content/preview` and
 * `content/full` files (CONTENT_FOLDERS), so identity documents, avatars and
 * the other folders are not in it and not limited by it.
 */
export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
}

/** One level of allowance: how many pieces, and how many bytes. */
export interface AllowanceLevelView {
  uploads: number;
  storageBytes: number;
}

/**
 * GET /uploads/allowance: what this account may upload and store, what it
 * has used (creator content only: `content/preview` and `content/full`; KYC
 * documents, avatars and the other folders are not counted), and both levels R-7 sets, so a screen can say "Free accounts get
 * 5" and "Up to 25 uploads" without a number of its own.
 */
export interface UploadAllowanceView {
  /** True when the account holds either tick now. */
  tickHeld: boolean;
  uploads: {
    /** Pieces counted against the cap (CreatorState.slotsUsed; 0 with no row). */
    used: number;
    /** The cap that applies now: `free.uploads` or `withTick.uploads`. */
    allowed: number;
    /** `allowed - used`, never below 0. */
    remaining: number;
  };
  storage: StorageUsage;
  /** R-7's allowance without a tick. */
  free: AllowanceLevelView;
  /** R-7's allowance with a tick. */
  withTick: AllowanceLevelView;
}

/**
 * Recovers the object key from whatever is stored on a row.
 *
 * `presignUpload().fileUrl` is `readUrlFor(key)` — an absolute,
 * already-signed, SEVEN-DAY read URL. Persisting that (rather than the bare
 * key) is what several resources do at create time, which means the stored
 * value goes dead exactly a week after upload even though the object it
 * points at is still sitting in the bucket untouched. Re-signing on the way
 * out needs the key back, and this is how: the grammar is closed and
 * server-generated — `<folder>/<wawuId>/<uuid>.<ext>` with `folder` drawn
 * from UPLOAD_FOLDERS (presignUpload) — so this is a match against a known
 * shape, not a guess at bucket layout. Anything that does not match is
 * passed through unchanged; nothing stored is ever rewritten.
 */
export function objectKeyFrom(stored: string): string {
  if (!stored.startsWith('http://') && !stored.startsWith('https://'))
    return stored;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(stored).pathname);
  } catch {
    return stored;
  }

  for (const folder of UPLOAD_FOLDERS) {
    const marker = `/${folder}/`;
    const at = pathname.indexOf(marker);
    if (at !== -1) return pathname.slice(at + 1);
  }
  return stored;
}

/** Sizes in refusal messages are for a person to read, not a machine. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    const gb = bytes / 1024 ** 3;
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10}GB`;
  }
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes} bytes`;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const endpoint = this.config.get<string>('STORAGE_ENDPOINT');
    const accessKeyId = this.config.get<string>('STORAGE_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>(
      'STORAGE_SECRET_ACCESS_KEY',
    );
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
      forcePathStyle:
        this.config.get<string>('STORAGE_FORCE_PATH_STYLE') === 'true',
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

    const folderCap = FOLDER_MAX_BYTES[folder];
    if (folderCap !== undefined && contentLength > folderCap) {
      throw new PayloadTooLargeException(
        `A file in ${folder} can be at most ${formatBytes(folderCap)}.`,
      );
    }

    // The extension comes from the type we just VALIDATED, not from the
    // client's `extension` field — see EXTENSION_FOR_CONTENT_TYPE. The key is
    // what read URLs use to decide how to serve the bytes, so letting the
    // caller name it would hand back the control the allowlist just took.
    const safeExt = EXTENSION_FOR_CONTENT_TYPE[contentType];
    const key = `${folder}/${wawuId}/${randomUUID()}.${safeExt}`;

    // The quota is checked BEFORE the URL is signed, and the reservation is
    // written before it is handed out. Signing first and recording after
    // would leave a signed URL for space the account does not have every time
    // the write failed.
    //
    // Only this NEW file is refused. Files already stored stay, even when the
    // account is above its allowance (R-7 lowered free accounts from 2 GB to
    // 1 GB, and a tick can lapse).
    //
    // The allowance is for creator content (CONTENT_FOLDERS). Identity
    // documents, avatars, covers, chat media and the other folders are
    // neither counted against it nor refused by it: R-7 sets the limit on
    // uploads, and a person over it must still be able to prove who they are.
    // Those folders keep their own per-file limit and type allowlist.
    const { usage, tickHeld } = await this.usageAndTick(wawuId);
    if (
      CONTENT_FOLDERS.includes(folder) &&
      usage.usedBytes + contentLength > usage.limitBytes
    ) {
      // Says only what is true: deleting a piece frees its upload slot, never
      // storage, so no line here promises that deleting makes room.
      throw new PayloadTooLargeException({
        message: `This file needs ${formatBytes(contentLength)}, but only ${formatBytes(
          Math.max(0, usage.remainingBytes),
        )} of your ${formatBytes(usage.limitBytes)} storage is free.${
          tickHeld
            ? ''
            : ` A verification tick raises the limit to ${formatBytes(TICK_STORAGE_BYTES)}.`
        }`,
        reason: {
          code: 'storage_limit_reached',
          neededBytes: contentLength,
          usedBytes: usage.usedBytes,
          limitBytes: usage.limitBytes,
          tickHeld,
          storageBytesWithTick: TICK_STORAGE_BYTES,
        },
      });
    }

    await this.prisma.storageObject.create({
      data: {
        wawuUserId: wawuId,
        key,
        bytes: contentLength,
        contentType,
        folder,
      },
    });

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

  /**
   * Re-signs a value a caller stored earlier via `readUrlFor` — the fix for
   * the 7-day expiry above. Recovers the key with `objectKeyFrom` and signs
   * it fresh, so a piece served a week (or a year) after upload plays exactly
   * as it did on day one.
   *
   * Returns the ORIGINAL value, not null, on any failure (storage
   * unconfigured/unreachable, or `stored` not recognised as one of this
   * service's own URLs): a possibly-stale link is still a link, and a public
   * feed rendering nothing beats it 500ing because storage hiccuped.
   */
  async freshUrlFor(stored: string | null): Promise<string | null> {
    if (!stored) return stored;
    if (!this.client) return stored;
    const key = objectKeyFrom(stored);
    try {
      return await this.readUrlFor(key);
    } catch (e) {
      this.logger.warn(
        `Could not refresh storage URL for ${key}: ${String(e)}`,
      );
      return stored;
    }
  }

  /**
   * Whether the upload `row` describes has landed in the bucket, settling the
   * row to `confirmed` when it has. Used by anything that is about to PUBLISH
   * an object a person says they uploaded (a featured work's media): a key
   * that was signed for but never PUT must not be shown.
   *
   * A `confirmed` row is settled already. A `pending` row is asked of the
   * bucket; with no bucket configured nothing can be proven, so it is not
   * accepted. Only a definite 404 or 403 means "not there"; any other
   * failure is the bucket being unreachable and is a 503, never a guess.
   */
  async confirmUpload(row: {
    id: string;
    status: string;
    key: string;
  }): Promise<boolean> {
    if (row.status === 'confirmed') return true;
    if (row.status !== 'pending' || !this.client) return false;
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: row.key }),
      );
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return false;
      this.logger.warn(
        `Could not confirm storage object ${row.key}: ${String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Could not check that upload right now. Try again in a moment.',
      );
    }
    await this.prisma.storageObject.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    return true;
  }

  /**
   * What this account is using, and what it is allowed.
   *
   * Every figure here has a writer: `usedBytes` is a SUM over rows created at
   * presign time (the `contentLength` the upload was signed for, which the
   * bucket itself enforces), and `limitBytes` derives from whether the
   * account holds a tick (R-7). Neither is a stored counter, so neither can
   * drift away from the objects it describes.
   *
   * `pending` counts toward usage alongside `confirmed`. A pending row is
   * space that has been signed for and may land at any moment; excluding it
   * would let one account presign its whole quota many times over in the
   * seconds before the first upload finishes.
   */
  async usageFor(wawuId: string): Promise<StorageUsage> {
    return (await this.usageAndTick(wawuId)).usage;
  }

  private async usageAndTick(
    wawuId: string,
  ): Promise<{ usage: StorageUsage; tickHeld: boolean }> {
    await this.reconcileStale(wawuId);

    const [agg, profile] = await Promise.all([
      this.prisma.storageObject.aggregate({
        _sum: { bytes: true },
        where: {
          wawuUserId: wawuId,
          status: { in: ['pending', 'confirmed'] },
          folder: { in: [...CONTENT_FOLDERS] },
        },
      }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: wawuId },
        select: TICK_COLUMNS,
      }),
    ]);

    const usedBytes = agg._sum.bytes ?? 0;
    const tickHeld = holdsTick(profile);
    const limitBytes = storageAllowanceFor(tickHeld);
    return {
      usage: {
        usedBytes,
        limitBytes,
        remainingBytes: Math.max(0, limitBytes - usedBytes),
      },
      tickHeld,
    };
  }

  /**
   * Both allowances in one answer, for the screens that show them (M11, M24,
   * M27). Read from the same places the refusals read: the upload count from
   * CreatorState.slotsUsed (what POST /content claims against), the bytes
   * from usageFor, the tick from holdsTick.
   */
  async allowanceFor(wawuId: string): Promise<UploadAllowanceView> {
    const [{ usage, tickHeld }, state] = await Promise.all([
      this.usageAndTick(wawuId),
      this.prisma.creatorState.findUnique({
        where: { wawuUserId: wawuId },
        select: { slotsUsed: true },
      }),
    ]);
    const used = state?.slotsUsed ?? 0;
    const allowed = uploadAllowanceFor(tickHeld).total;
    return {
      tickHeld,
      uploads: { used, allowed, remaining: Math.max(0, allowed - used) },
      storage: usage,
      free: { uploads: FREE_UPLOADS, storageBytes: FREE_STORAGE_BYTES },
      withTick: { uploads: TICK_UPLOADS, storageBytes: TICK_STORAGE_BYTES },
    };
  }

  /**
   * Settles `pending` rows whose presign window has long closed by asking the
   * bucket whether the object is actually there.
   *
   * This is the price of the browser uploading straight to storage: the API is
   * never told whether the PUT succeeded. Without this, one abandoned upload
   * would hold its bytes against the account permanently.
   *
   * The grace period is far longer than the 300s URL expiry on purpose. The
   * signature only has to be VALID when the request starts — a large file that
   * began uploading at 299s can still be in flight minutes later, and marking
   * it abandoned would uncount bytes that are about to exist.
   */
  private async reconcileStale(wawuId: string): Promise<void> {
    if (!this.client) return;

    const cutoff = new Date(Date.now() - RECONCILE_GRACE_MS);
    const stale = await this.prisma.storageObject.findMany({
      where: {
        wawuUserId: wawuId,
        status: 'pending',
        createdAt: { lt: cutoff },
      },
      select: { id: true, key: true },
      take: 50,
    });
    if (stale.length === 0) return;

    await Promise.all(
      stale.map(async (row) => {
        let landed: boolean;
        try {
          await this.client!.send(
            new HeadObjectCommand({ Bucket: this.bucket, Key: row.key }),
          );
          landed = true;
        } catch (err) {
          const status = (err as { $metadata?: { httpStatusCode?: number } })
            .$metadata?.httpStatusCode;
          // Only a definite 404/403 means "not there". Anything else is the
          // bucket being unreachable, and guessing "abandoned" from an outage
          // would silently hand back quota for files that still exist.
          if (status !== 404 && status !== 403) {
            this.logger.warn(
              `Could not reconcile storage object ${row.key}: ${String(err)}`,
            );
            return;
          }
          landed = false;
        }

        await this.prisma.storageObject.update({
          where: { id: row.id },
          data: landed
            ? { status: 'confirmed', confirmedAt: new Date() }
            : { status: 'abandoned' },
        });
      }),
    );
  }
}

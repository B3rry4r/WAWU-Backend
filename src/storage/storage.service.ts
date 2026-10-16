import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
  type UploadFormatId,
} from './dto/presign-upload.dto';
import { formatFolderRule } from './upload-formats';
import { releaseOwnUpload } from './upload-release';
import { sweepLateFiles, type LateSweepResult } from './late-file-sweep';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Prisma } from '../../generated/prisma/client';
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

/** How long a presigned PUT URL can still start an upload. */
const UPLOAD_URL_SECONDS = 300;

/**
 * Extra time after a given-up upload's link has expired before the sweep looks
 * at its file (ME-04 round 3), unless UPLOAD_SWEEP_MARGIN_SECONDS says
 * otherwise. With the link's 300 s it makes 15 minutes, the same time
 * reconcileStale gives a slow upload before it settles one.
 */
const DEFAULT_SWEEP_MARGIN_SECONDS = 600;

/**
 * How long after presign `POST /uploads/confirm` leaves a missing file alone:
 * the URL's life plus a minute. Until then the PUT may still be coming (the
 * app can confirm before it sends, or while it sends), so the row stays
 * `pending`, counted, and the sweep settles it. Past it, a missing file is
 * given up on at once.
 */
const CONFIRM_HOLD_MS = (UPLOAD_URL_SECONDS + 60) * 1000;

const CHECK_LATER =
  'Could not check that upload right now. Try again in a moment.';

/** Stale reservations the sweep settles in one pass over the bucket. */
const RECONCILE_BATCH = 50;

/** Passes one usage read makes at most, so a read never runs unbounded. */
const RECONCILE_MAX_BATCHES = 10;

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
 * Why a link's path cannot become an object key, or null when it can. Checks
 * the path after decoding (twice, so a double-encoded `%252e%252e` or `%2500`
 * is seen for what it becomes): a NUL (Postgres refuses it, 22021), a lone
 * surrogate, malformed percent-encoding, a `.` or `..` segment, or a key over
 * the 1024 bytes S3 allows. Only http(s) links are looked at; anything else is
 * a key already and is not this function's business.
 */
export function storedKeyProblem(stored: unknown): string | null {
  if (typeof stored !== 'string') return 'must be text';
  if (!stored.startsWith('http://') && !stored.startsWith('https://'))
    return null;
  try {
    new URL(stored);
  } catch {
    return 'must be a full link';
  }
  // The path as written: `new URL` resolves `/%2e%2e/` away, which would hide it.
  const path = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(stored)?.[1] ?? '';
  let decoded = path;
  for (let pass = 0; pass < 2; pass++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return 'has invalid percent-encoding in its path';
    }
    // eslint-disable-next-line no-control-regex -- the NUL and other controls are what is refused
    if (/[\u0000-\u001f\u007f]/.test(decoded))
      return 'cannot have control characters in its path';
    if (!/^(?:[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])*$/.test(decoded))
      return 'cannot have a broken character in its path';
    if (decoded.split(/[/\\]/).some((seg) => seg === '.' || seg === '..'))
      return 'cannot have . or .. in its path';
    if (Buffer.byteLength(decoded, 'utf8') > 1024)
      return 'has a path too long to be an object key';
  }
  return null;
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
  if (typeof stored !== 'string') return '';
  if (!stored.startsWith('http://') && !stored.startsWith('https://'))
    return stored;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(stored).pathname);
  } catch {
    return stored;
  }
  // A path that decodes to something a key cannot be (a NUL, a lone
  // surrogate, a `..` segment, too long) is not one of ours: pass it through
  // unchanged, as for any link that does not match, rather than derive a key
  // from it. Reading a bad stored row must never throw.
  if (storedKeyProblem(stored) !== null) return stored;

  for (const folder of UPLOAD_FOLDERS) {
    const marker = `/${folder}/`;
    const at = pathname.indexOf(marker);
    if (at !== -1) return pathname.slice(at + 1);
  }
  return stored;
}

/**
 * The folders a delivered legal document may come from (LEGAL-03, N1). A
 * delivered file is signed for the client on every read, so a key outside
 * these folders (an identity document, an avatar, anything else in the
 * bucket) must never be accepted or signed through that route.
 *
 * `legal/document` is where the files a matter holds are uploaded today.
 * LEGAL-07 builds the admin upload for delivered documents (SHARED-CHANGES
 * "LEGAL-03 #2"); its folder is added to this list when that task names it,
 * and not before.
 */
export const DELIVERABLE_KEY_FOLDERS: readonly string[] = ['legal/document'];

/**
 * Where this bucket's objects are read from: the origin (scheme, host and
 * port) and the path before the key (`/` for a virtual-hosted bucket,
 * `/<bucket>/` for a path-style one). StorageService.bucketLocation reads it
 * from the storage client itself, never from a literal.
 */
export interface BucketLocation {
  origin: string;
  pathPrefix: string;
}

/** One key segment: what presignUpload writes, and nothing else. */
const KEY_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * The object key a delivered file names, or null when it may not be used.
 *
 * Accepted: a bare key, or a link that starts with exactly this bucket's
 * origin and path prefix (`location`); a query (a signature) after the key is
 * ignored. The key, as written (never decoded), must be one of `folders`
 * followed by exactly two plain segments (letters, digits, `.`, `_`, `~`,
 * `-`; never only dots, never empty), the shape presignUpload writes. So a
 * link on another host, a look-alike host (userinfo, a longer host, another
 * port or scheme), a backslash, an encoded slash or any other `%` escape, a
 * control or broken character, or a key in another folder gives null. Never
 * throws.
 */
export function deliverableKeyFrom(
  value: unknown,
  location: BucketLocation | null,
  folders: readonly string[] = DELIVERABLE_KEY_FOLDERS,
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > 2048) return null;
  // Printable ASCII only: a presigned link and a key are both written in it,
  // so a space, a control, a backslash or any other character is not ours.
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) return null;

  let key: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    if (!location) return null;
    const base = `${location.origin}${location.pathPrefix}`;
    if (!value.startsWith(base)) return null;
    try {
      const parsed = new URL(value);
      if (parsed.origin !== location.origin) return null;
      if (parsed.username || parsed.password) return null;
    } catch {
      return null;
    }
    // The path as written. Our keys never need percent-encoding, so a `%`
    // in it (an encoded slash, dot, NUL or broken byte) is not one of ours.
    key = value.slice(base.length).split(/[?#]/, 1)[0];
  } else {
    key = value;
  }

  if (Buffer.byteLength(key, 'utf8') > 1024) return null;
  // The shape presignUpload writes: `<folder>/<wawuId>/<uuid>.<ext>`, so
  // exactly two plain segments after the folder, none of them only dots.
  const segments = key.split('/');
  if (!segments.every((seg) => KEY_SEGMENT.test(seg) && !/^\.+$/.test(seg)))
    return null;
  const inFolder = folders.some(
    (folder) =>
      key.startsWith(`${folder}/`) &&
      segments.length === folder.split('/').length + 2,
  );
  return inFolder ? key : null;
}

/** A link's host, lower-cased and without a trailing dot, or null. */
function hostOf(link: string): string | null {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/\.+$/, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * Whether a link names this bucket's host, the storage endpoint's host, or a
 * host under either (a virtual-hosted bucket sits under the endpoint's). Any
 * link the bucket would answer is signed for one of these hosts, so a link
 * on any other host cannot read one of our objects. A link that does not
 * parse names no host. Never throws.
 */
export function linkNamesStorage(
  link: unknown,
  location: BucketLocation | null,
  endpoint: string | undefined | null,
): boolean {
  if (typeof link !== 'string') return false;
  const host = hostOf(link);
  if (host === null) return false;
  const ours = [
    location ? hostOf(location.origin) : null,
    endpoint ? hostOf(endpoint) : null,
  ].filter((h): h is string => h !== null);
  return ours.some((h) => host === h || host.endsWith(`.${h}`));
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
  /** Seconds past a link's life before the sweep removes a late file. */
  private readonly sweepMarginSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const margin = Number(
      this.config.get<string>('UPLOAD_SWEEP_MARGIN_SECONDS'),
    );
    this.sweepMarginSeconds =
      Number.isFinite(margin) && margin >= 0
        ? margin
        : DEFAULT_SWEEP_MARGIN_SECONDS;
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

  private bucketLocationRead: Promise<BucketLocation | null> | null = null;

  /**
   * This bucket's origin and key prefix, read from the storage client: a
   * read link is signed (locally, nothing is sent) for a probe key and the
   * part before the key is kept. So the host follows STORAGE_ENDPOINT,
   * STORAGE_BUCKET and STORAGE_FORCE_PATH_STYLE exactly as every real link
   * does. Null when storage is not configured.
   */
  bucketLocation(): Promise<BucketLocation | null> {
    if (!this.client) return Promise.resolve(null);
    const client = this.client;
    this.bucketLocationRead ??= (async () => {
      const probe = 'legal/document/probe/probe.pdf';
      const link = new URL(
        await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: this.bucket, Key: probe }),
          { expiresIn: 60 },
        ),
      );
      if (!link.pathname.endsWith(`/${probe}`)) return null;
      return {
        origin: link.origin,
        pathPrefix: link.pathname.slice(0, -probe.length),
      };
    })().catch((e) => {
      this.logger.warn(`Could not read the bucket location: ${String(e)}`);
      this.bucketLocationRead = null;
      return null;
    });
    return this.bucketLocationRead;
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
    format?: UploadFormatId,
  ): Promise<{ uploadUrl: string; key: string; fileUrl: string }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File uploads are not available on this environment yet.',
      );
    }

    // ME-04: a call that names a content format is checked against that
    // format's own rules (GET /uploads/formats) instead of the folder's wider
    // list and the one global cap. A call without one is untouched.
    const formatRule = format ? this.formatRuleFor(format, folder) : null;

    // Per-destination allowlist. Without it any signed-in user could store
    // text/html or image/svg+xml and get a URL that serves it executable
    // from the storage origin.
    const allowed = formatRule
      ? formatRule.contentTypes
      : (FOLDER_CONTENT_TYPES[folder] ?? []);
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
    if (format && formatRule && contentLength > formatRule.maxBytes) {
      throw new PayloadTooLargeException(
        `A ${format} file can be at most ${formatBytes(formatRule.maxBytes)}.`,
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
      throw this.storageFullRefusal(contentLength, usage, tickHeld);
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
      { expiresIn: UPLOAD_URL_SECONDS },
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
    const held = await this.bucketHolds(row.key, 'confirm');
    if (held === 'absent') return false;
    if (held === 'unknown') throw new ServiceUnavailableException(CHECK_LATER);
    await this.prisma.storageObject.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    return true;
  }

  /**
   * POST /uploads/confirm: the app has finished sending one file to the URL
   * presign gave it, and says so whether the storage host took it or turned
   * it away. The bucket, not the app, decides what the reservation becomes:
   *
   * - the object is there: the row is `confirmed`, and counts as it always
   *   did. A row that had been given up on comes back only if the file still
   *   fits the person's storage (a slow upload that outlived the give-up);
   *   if it does not, the file is removed from the bucket and the answer is
   *   the same 413 a presign gives, so a file nobody reserved room for is
   *   never kept.
   * - the object is not there yet and the URL could still be used (the row is
   *   younger than the URL's life plus a minute): `pending`. The row is left
   *   as it is, still counted, and the sweep (reconcileStale) settles it. A
   *   confirm sent before the PUT therefore frees nothing.
   * - the object is not there and the URL is spent: the row is `abandoned`
   *   now, and the space it held goes back to the person. Without this call
   *   that happens only when the sweep settles it, a quarter of an hour on.
   * - the bucket cannot be asked: a 503, and the row is left as it was.
   *
   * Only the person's own upload can be settled; another account's key answers
   * the same as a key that never existed.
   */
  async settleUpload(
    wawuId: string,
    stored: string,
  ): Promise<{ key: string; status: 'confirmed' | 'abandoned' | 'pending' }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File uploads are not available on this environment yet.',
      );
    }
    const key = objectKeyFrom(stored);
    // A control character (a NUL above all, which the database refuses and
    // used to turn into a 500) is in no key we wrote: the same answer as for
    // any key that never existed.
    // eslint-disable-next-line no-control-regex -- the NUL and other controls are what is refused
    const row = /[\u0000-\u001f\u007f]/.test(key)
      ? null
      : await this.prisma.storageObject.findUnique({ where: { key } });
    if (!row || row.wawuUserId !== wawuId) {
      throw new NotFoundException('We could not find that upload.');
    }
    if (row.status === 'confirmed') return { key, status: 'confirmed' };
    // The person gave this file up (POST /uploads/release). A file that lands
    // afterwards, through the link that was still valid, is not counted again:
    // the row stays released, and the sweep removes the file once the link has
    // expired. Nothing to ask of the bucket.
    if (row.releasedAt) return { key, status: 'abandoned' };

    const held = await this.bucketHolds(key, 'settle');
    if (held === 'unknown') throw new ServiceUnavailableException(CHECK_LATER);
    if (held === 'present') {
      const adopted = await this.adoptArrived(wawuId, row.id, key);
      return { key, status: adopted ? 'confirmed' : 'abandoned' };
    }
    if (row.status !== 'pending') return { key, status: 'abandoned' };
    if (Date.now() - row.createdAt.getTime() < CONFIRM_HOLD_MS) {
      return { key, status: 'pending' };
    }
    await this.prisma.storageObject.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'abandoned' },
    });
    return { key, status: 'abandoned' };
  }

  /**
   * The file of reservation `rowId` is in the bucket: the row becomes
   * `confirmed`. A `pending` row is counted already, so nothing else changes.
   * An `abandoned` row is not counted, and its space may have been given to
   * other files since, so it comes back only when it fits: usage plus its
   * bytes within the limit, checked under a per-person lock so two files
   * coming back at once cannot both take the last of the room. When it does
   * not fit, the file is removed from the bucket and the person is refused as
   * a presign refuses (413, storage_limit_reached); the row stays `abandoned`.
   */
  private async adoptArrived(
    wawuId: string,
    rowId: string,
    key: string,
  ): Promise<boolean> {
    await this.reconcileStale(wawuId);
    const refusal = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`storage-quota:${wawuId}`}, 0))`;
      const row = await tx.storageObject.findUnique({ where: { id: rowId } });
      if (!row || row.status === 'confirmed') return null;
      // Released while this confirm was under way: it stays released.
      if (row.releasedAt) return 'released' as const;
      if (row.status === 'abandoned' && CONTENT_FOLDERS.includes(row.folder)) {
        const { usage, tickHeld } = await this.readUsage(wawuId, tx);
        if (usage.usedBytes + row.bytes > usage.limitBytes) {
          return this.storageFullRefusal(row.bytes, usage, tickHeld);
        }
      }
      await tx.storageObject.update({
        where: { id: rowId },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
      return null;
    });
    if (refusal === 'released') return false;
    if (!refusal) return true;
    try {
      await this.client!.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(
        `Could not remove over-limit storage object ${key}: ${String(err)}`,
      );
    }
    throw refusal;
  }

  /**
   * The 413 for a file the person's storage cannot take. Says only what is
   * true: deleting a piece frees its upload slot, never storage, so no line
   * here promises that deleting makes room.
   */
  private storageFullRefusal(
    contentLength: number,
    usage: StorageUsage,
    tickHeld: boolean,
  ): PayloadTooLargeException {
    return new PayloadTooLargeException({
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

  /**
   * Whether the bucket holds `key`. Only a definite 404 or 403 means
   * `absent`; any other failure is the bucket being unreachable, which is
   * `unknown`: nobody may conclude "not there" from an outage, because that
   * would hand back space for files that still exist.
   */
  private async bucketHolds(
    key: string,
    doing: string,
  ): Promise<'present' | 'absent' | 'unknown'> {
    try {
      await this.client!.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return 'present';
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return 'absent';
      this.logger.warn(
        `Could not ${doing} storage object ${key}: ${String(err)}`,
      );
      return 'unknown';
    }
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
    return this.readUsage(wawuId, this.prisma);
  }

  private async readUsage(
    wawuId: string,
    db: Pick<Prisma.TransactionClient, 'storageObject' | 'userProfile'>,
  ): Promise<{ usage: StorageUsage; tickHeld: boolean }> {
    const [agg, profile] = await Promise.all([
      db.storageObject.aggregate({
        _sum: { bytes: true },
        where: {
          wawuUserId: wawuId,
          status: { in: ['pending', 'confirmed'] },
          folder: { in: [...CONTENT_FOLDERS] },
        },
      }),
      db.userProfile.findUnique({
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
   * The rule a named format sets for a folder (ME-04). Only the two content
   * folders have one: anything else is refused, so a format cannot be used to
   * reach a folder it has no say over.
   */
  private formatRuleFor(
    format: UploadFormatId,
    folder: UploadFolder,
  ): { contentTypes: readonly string[]; maxBytes: number } {
    if (folder !== 'content/full' && folder !== 'content/preview') {
      throw new BadRequestException(
        `A format only applies to content/full and content/preview, not ${folder}.`,
      );
    }
    return formatFolderRule(format, folder);
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
    // Rows the bucket could not answer for stay pending and are not asked
    // again in this read, so the loop ends even during an outage.
    const asked: string[] = [];
    for (let pass = 0; pass < RECONCILE_MAX_BATCHES; pass++) {
      const stale = await this.prisma.storageObject.findMany({
        where: {
          wawuUserId: wawuId,
          status: 'pending',
          createdAt: { lt: cutoff },
          ...(asked.length > 0 ? { id: { notIn: asked } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, key: true },
        take: RECONCILE_BATCH,
      });
      if (stale.length === 0) return;
      asked.push(...stale.map((row) => row.id));

      await Promise.all(
        stale.map(async (row) => {
          const held = await this.bucketHolds(row.key, 'reconcile');
          if (held === 'unknown') return;
          // Guarded on `pending`: a confirm that landed since the read wins.
          await this.prisma.storageObject.updateMany({
            where: { id: row.id, status: 'pending' },
            data:
              held === 'present'
                ? { status: 'confirmed', confirmedAt: new Date() }
                : { status: 'abandoned' },
          });
        }),
      );
      if (stale.length < RECONCILE_BATCH) return;
    }
  }

  /**
   * ME-04 round 3: removes the files that landed after their upload was given
   * up on (released, or never arrived), once the PUT link they came through has
   * expired. See late-file-sweep.ts. Run on a timer by StorageSweepService;
   * safe to run at any time and from several Hubs at once.
   */
  sweepLateFiles(wawuId?: string): Promise<LateSweepResult> {
    return sweepLateFiles(
      {
        client: this.client,
        bucket: this.bucket,
        folders: CONTENT_FOLDERS,
        prisma: this.prisma,
        logger: this.logger,
      },
      {
        linkSeconds: UPLOAD_URL_SECONDS,
        marginSeconds: this.sweepMarginSeconds,
        wawuId,
      },
    );
  }

  /**
   * ME-04 round 2: gives back the space of an upload the caller reserved and
   * no listing has claimed (POST /uploads/release). See upload-release.ts.
   */
  releaseUpload(wawuId: string, key: string): Promise<{ released: true }> {
    return releaseOwnUpload(
      {
        client: this.client,
        bucket: this.bucket,
        folders: CONTENT_FOLDERS,
        prisma: this.prisma,
        logger: this.logger,
      },
      wawuId,
      key,
    );
  }
}

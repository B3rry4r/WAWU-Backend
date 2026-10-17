import type { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

/** How long the storage client waits to connect, for an answer and in all (STORAGE_REQUEST_TIMEOUT_MS). */
export const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The Hub's one object-storage client, built from STORAGE_ENDPOINT,
 * STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, STORAGE_BUCKET,
 * STORAGE_REGION, STORAGE_FORCE_PATH_STYLE and STORAGE_REQUEST_TIMEOUT_MS; null
 * when storage is not configured. StorageService (uploads, reads, the sweeps)
 * and StorageRemover (the account purge, FIX-65) both build theirs here, so
 * the purge reaches the bucket exactly as the rest of the Hub does: the same
 * endpoint, the same credentials, the same timeouts.
 */
export function createStorageClient(
  config: ConfigService,
): { client: S3Client; bucket: string } | null {
  const endpoint = config.get<string>('STORAGE_ENDPOINT');
  const accessKeyId = config.get<string>('STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = config.get<string>('STORAGE_SECRET_ACCESS_KEY');
  const bucket = config.get<string>('STORAGE_BUCKET') ?? '';
  const timeout = Number(config.get<string>('STORAGE_REQUEST_TIMEOUT_MS'));
  const requestTimeoutMs =
    Number.isFinite(timeout) && timeout >= 100
      ? timeout
      : DEFAULT_STORAGE_REQUEST_TIMEOUT_MS;

  // Storage is optional at boot so the rest of the API still runs in
  // environments where it isn't configured yet. The caller says so (the
  // StorageService warns once at boot; every upload then fails loudly with a
  // 503 instead of handing back a broken URL).
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;

  const client = new S3Client({
    region: config.get<string>('STORAGE_REGION') ?? 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // Railway Buckets use virtual-hosted-style URLs (bucket as subdomain),
    // which is the S3 default. Buckets created before that change need
    // path-style — set STORAGE_FORCE_PATH_STYLE=true for those.
    forcePathStyle: config.get<string>('STORAGE_FORCE_PATH_STYLE') === 'true',
    // MUST stay 'WHEN_REQUIRED'. Since v3.729 the SDK defaults to
    // 'WHEN_SUPPORTED', which adds an integrity checksum to every
    // PutObject. Presigning has no body to checksum, so it hashed NOTHING
    // and baked `x-amz-checksum-crc32=AAAAAA==` — CRC32 of zero bytes —
    // into the signed URL. The browser then PUT the real file, whose
    // checksum is obviously not that, and storage rejected every single
    // upload with 400 Bad Request. KYC documents, content assets, CAC and
    // NEPC paperwork: none of it could be uploaded at all.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    // No bucket call may hang a request or the sweep (ME-04 round 5). The
    // calls this client makes are a HEAD and a DELETE of one key, so a
    // short bound on connecting, on silence and on the whole request is
    // plenty. The SDK's own default is no limit at all, and it warns rather
    // than fails when only `requestTimeout` is set, hence
    // `throwOnRequestTimeout`. One retry, so a hung bucket costs a caller
    // about twenty seconds at most, and nothing is held meanwhile (see
    // storage-lock.ts).
    requestHandler: {
      connectionTimeout: requestTimeoutMs,
      socketTimeout: requestTimeoutMs,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 2,
  });
  return { client, bucket };
}

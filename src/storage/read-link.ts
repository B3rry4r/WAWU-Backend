import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serveAs } from './dto/presign-upload.dto';

/**
 * HUB-IMG-LINKS: the ONE place a picture, preview, cover or avatar read link is signed.
 *
 * Why a window: a link signed at the current second is a new address on every response, so a browser downloads
 * the same picture again each time (WEBAPP-12 measured 3.2 to 8.4 MB and 7 to 45 s on a second visit at 1.6 Mbps).
 * Here the signing time is rounded DOWN to the start of a UTC day, so every link for one key signed in the same day is
 * byte-identical, and the browser can keep it. A day because the app reloads its feeds all day (an hour would
 * change the address 24 times as often for no gain) and because a link has to outlive the window it was
 * signed in (below). UTC midnight is 01:00 in Lagos: a quiet hour.
 *
 * How long a link lives: a link signed at the start of the window has been lived-in for up to one window by the time it
 * is handed out, so the expiry is lengthened by one window. The most S3 signature version 4 allows is 7 days
 * (`LINK_MAX_SECONDS`), and the default read link was already 7 days, so it cannot be lengthened: the shortest
 * life a default link can have is 7 days minus one window, just over 6 days (518401 s), at the last second of a
 * window. A link for a caller that asks for fewer than 7 days minus one window keeps its full ask (ask + window,
 * minus up to a window).
 *
 * A link that asks for a short life (a window or less: a chat attachment, an hour) is signed at the current second,
 * with no cache header, exactly as before: rounding it down would shorten or lengthen the life someone asked for.
 *
 * The browser is told (`ResponseCacheControl`, signed into the GET) it may keep the picture: private, a year,
 * immutable. Never set on an upload: a changed upload signature would break the phones in the field
 * (`StorageService.presignUpload` does not use this file).
 */
export const LINK_WINDOW_SECONDS = 86_400;
/** The longest life a signature version 4 link can have. */
export const LINK_MAX_SECONDS = 604_800;
/** The default life of a read link (`StorageService.readUrlFor`): seven days. */
export const READ_URL_SECONDS = LINK_MAX_SECONDS;
export const READ_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** The start of the window `now` falls in. */
export function windowStart(
  now: Date,
  windowSeconds = LINK_WINDOW_SECONDS,
): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** The shortest life, in seconds, a link signed with `expiresInSeconds` can have when handed out. */
export function shortestLife(expiresInSeconds = READ_URL_SECONDS): number {
  if (expiresInSeconds <= LINK_WINDOW_SECONDS) return expiresInSeconds;
  const signedFor = Math.min(
    LINK_MAX_SECONDS,
    expiresInSeconds + LINK_WINDOW_SECONDS,
  );
  return signedFor - (LINK_WINDOW_SECONDS - 1);
}

export interface ReadLinkArgs {
  bucket: string;
  key: string;
  expiresInSeconds?: number;
  /** The clock; specs pass their own. */
  now?: Date;
}

export function signReadLink(
  client: S3Client,
  { bucket, key, expiresInSeconds = READ_URL_SECONDS, now }: ReadLinkArgs,
): Promise<string> {
  // Force both the type and the disposition on the way out. The uploader cannot influence either, so bytes that were
  // smuggled in under a false Content-Type are still served as the kind of file the key says.
  const { contentType, inline } = serveAs(key);
  const kept = expiresInSeconds > LINK_WINDOW_SECONDS;
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: inline ? 'inline' : 'attachment',
      ...(kept ? { ResponseCacheControl: READ_CACHE_CONTROL } : {}),
    }),
    kept
      ? {
          signingDate: windowStart(now ?? new Date()),
          expiresIn: Math.min(
            LINK_MAX_SECONDS,
            expiresInSeconds + LINK_WINDOW_SECONDS,
          ),
        }
      : { expiresIn: expiresInSeconds },
  );
}

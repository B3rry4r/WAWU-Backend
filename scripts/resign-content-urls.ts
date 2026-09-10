// Re-signs every stored ContentPiece asset URL with the CURRENT
// serveAs()/readUrlFor() logic.
//
// Why this has to be a script, not just a code fix: previewAssetUrl and
// fullAssetUrl are not raw storage keys read fresh on every request — they
// are the FULLY SIGNED URL, generated once at upload time
// (StorageService.presignUpload → readUrlFor(key)) and stored verbatim
// (content-piece.service.ts create(): `previewAssetUrl: dto.previewAsset`).
// So the "video/audio now serve inline" fix in presign-upload.dto.ts's
// serveAs() only changes what a FUTURE upload's signature looks like — every
// piece uploaded before that fix is still carrying the OLD, wrong
// `response-content-disposition=attachment` baked into its stored URL's
// query string, and will keep serving broken previews until that string
// itself is replaced.
//
// This re-derives the storage KEY from each stored URL (its path, minus the
// query string) and re-signs it the same way readUrlFor() would, so existing
// content gets the fix without anyone re-uploading it.
//
// Idempotent and safe to re-run: a row whose freshly-signed URL comes back
// identical in shape (same disposition/content-type) is still updated — the
// signature and expiry are new every run, which is the point — but nothing
// here changes what bytes are served or to whom.
//
// Run:
//   DATABASE_URL=... STORAGE_ENDPOINT=... STORAGE_ACCESS_KEY_ID=... \
//   STORAGE_SECRET_ACCESS_KEY=... STORAGE_BUCKET=... \
//   npm run resign:content-urls
//
// Safe with storage unconfigured: exits early rather than touching the DB.
import { PrismaPg } from '@prisma/adapter-pg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaClient } from '../generated/prisma/client';

// Duplicated from src/storage/dto/presign-upload.dto.ts's EXTENSION_FOR_CONTENT_TYPE
// / serveAs, rather than imported: that file also declares PresignUploadDto's
// class-validator decorators, which this script's standalone `tsc` invocation
// (no experimentalDecorators/emitDecoratorMetadata — same constraint db:seed
// and admin:seed are already under) cannot compile. Keep both in sync by hand;
// storage.presign.spec.ts's serveAs table is the source of truth to check against.
const EXTENSION_FOR_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'text/csv': 'csv',
  'application/zip': 'zip',
};
const CONTENT_TYPE_FOR_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_FOR_CONTENT_TYPE).map(([type, ext]) => [ext, type]),
);
function serveAs(key: string): { contentType: string; inline: boolean } {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPE_FOR_EXTENSION[ext];
  if (!contentType)
    return { contentType: 'application/octet-stream', inline: false };
  const inline =
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/');
  return { contentType, inline };
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const endpoint = process.env.STORAGE_ENDPOINT ?? '';
const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID ?? '';
const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY ?? '';
const bucket = process.env.STORAGE_BUCKET ?? '';

if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
  console.error(
    'Object storage is not configured (STORAGE_ENDPOINT / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY / STORAGE_BUCKET). Nothing to re-sign.',
  );
  process.exit(1);
}

const s3 = new S3Client({
  region: process.env.STORAGE_REGION ?? 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

/** Mirrors StorageService.readUrlFor exactly — see that method's own comment. */
async function readUrlFor(key: string): Promise<string> {
  const { contentType, inline } = serveAs(key);
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: inline ? 'inline' : 'attachment',
    }),
    { expiresIn: 604800 },
  );
}

/** The stored value is a full signed URL; the key is its path, query dropped. */
function keyFromStoredUrl(stored: string): string | null {
  try {
    const u = new URL(stored);
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

async function main() {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const rows = await prisma.contentPiece.findMany({
    select: { id: true, previewAssetUrl: true, fullAssetUrl: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const data: { previewAssetUrl?: string; fullAssetUrl?: string } = {};

    const previewKey = keyFromStoredUrl(row.previewAssetUrl);
    if (previewKey) {
      data.previewAssetUrl = await readUrlFor(previewKey);
    }

    if (row.fullAssetUrl) {
      const fullKey = keyFromStoredUrl(row.fullAssetUrl);
      if (fullKey) {
        data.fullAssetUrl = await readUrlFor(fullKey);
      }
    }

    if (Object.keys(data).length === 0) {
      skipped++;
      continue;
    }

    await prisma.contentPiece.update({ where: { id: row.id }, data });
    updated++;
  }

  console.log(
    `Re-signed ${updated} content piece(s), skipped ${skipped} (no storage-hosted URL).`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

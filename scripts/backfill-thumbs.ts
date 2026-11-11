/**
 * HUB-THUMBS: the one-off backfill of small copies for public pictures already stored. WRITTEN, NOT RUN by the
 * task that wrote it: it runs only on the owner's word.
 *
 * It makes the same two copies (96 and 640 px, WebP) the upload path makes, for the same four public key families
 * only (avatars, profile/cover, content/cover, content/preview; see src/storage/thumbs/thumb-keys.ts), through
 * `StorageService.ensureThumbs`: the one code path that writes a copy, so the size caps, the pixel cap, the time
 * limit and the log-and-skip rules are the upload path's own. It never replaces an original, and a picture that
 * already has both copies costs one database read. Safe to stop and run again.
 *
 *   count   (default) reads the database only: how many pictures per family, how many bytes, how many already
 *           have both copies, and the estimate of time. Touches no storage.
 *   apply   makes the copies. Refuses unless THUMBS_BACKFILL_OWNER_OK=yes is set, which the person running it
 *           sets only after the owner's word.
 *
 *   npx tsc scripts/backfill-thumbs.ts --moduleResolution nodenext --module nodenext --target ES2023 \
 *     --esModuleInterop --skipLibCheck --emitDecoratorMetadata --experimentalDecorators --outDir dist-seed
 *   DATABASE_URL=... STORAGE_ENDPOINT=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
 *   STORAGE_BUCKET=... node dist-seed/scripts/backfill-thumbs.js [count|apply] [--limit N] [--concurrency 2] [--mbps 20]
 *
 * The estimate (printed by `count`): per picture, the download of the original at --mbps (default 20 MB/s, a
 * deliberately slow figure), plus about 0.3 s for the decode, resize and WebP encode of both copies at the size
 * the Hub allows (measured on a 4-core machine: 0.1 s for a 1080 px picture, 0.13 s for a 12 MP photo, 0.3 s for
 * the 25 MB cap), plus about 0.15 s for the two uploads and two rows; --concurrency pictures at once (default 2,
 * the upload path's own limit). The copies add about 5 KB (96 px) and 40 KB (640 px) per picture.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { StorageService } from '../src/storage/storage.service';
import {
  THUMB_SOURCE_FAMILIES,
  thumbKeysOf,
  thumbSourceOk,
} from '../src/storage/thumbs/thumb-keys';

const args = process.argv.slice(2);
const mode = args[0] === 'apply' ? 'apply' : 'count';
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const LIMIT = flag('limit', Infinity);
const CONCURRENCY = Math.min(flag('concurrency', 2), 4);
const MBPS = flag('mbps', 20);
const MB = 1024 * 1024;
/** Seconds of decode, resize, encode and two uploads per picture, besides the download. */
const WORK_SECONDS = 0.3 + 0.15;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const rows = (
      await prisma.storageObject.findMany({
        where: {
          status: 'confirmed',
          releasedAt: null,
          removingAt: null,
          folder: { in: [...THUMB_SOURCE_FAMILIES] },
        },
        select: { key: true, bytes: true },
        orderBy: { createdAt: 'desc' },
      })
    ).filter((r) => thumbSourceOk(r.key));
    const have = new Set(
      (
        await prisma.storageObject.findMany({
          where: { folder: 'thumbs', status: 'confirmed' },
          select: { key: true },
        })
      ).map((r) => r.key),
    );
    const todo = rows.filter(
      (r) => !thumbKeysOf(r.key).every((k) => have.has(k)),
    );
    const bytes = todo.reduce((a, r) => a + r.bytes, 0);
    const by = new Map<string, { files: number; bytes: number }>();
    for (const r of todo) {
      const family = THUMB_SOURCE_FAMILIES.find((f) =>
        r.key.startsWith(`${f}/`),
      )!;
      const t = by.get(family) ?? { files: 0, bytes: 0 };
      t.files += 1;
      t.bytes += r.bytes;
      by.set(family, t);
    }
    const seconds =
      (bytes / (MBPS * MB) + todo.length * WORK_SECONDS) / CONCURRENCY;
    console.log(
      `Public pictures stored: ${rows.length}; without both copies: ${todo.length} (${(bytes / MB).toFixed(1)} MB to read)`,
    );
    for (const [family, t] of by)
      console.log(
        `  ${family}: ${t.files} files, ${(t.bytes / MB).toFixed(1)} MB`,
      );
    console.log(
      `Estimate: about ${(seconds / 60).toFixed(1)} minutes at ${MBPS} MB/s per file, ${CONCURRENCY} at once; ` +
        `the copies add about ${((todo.length * 45 * 1024) / MB).toFixed(0)} MB to the bucket.`,
    );
    if (mode === 'count') return;

    if (process.env.THUMBS_BACKFILL_OWNER_OK !== 'yes') {
      throw new Error(
        "apply needs the owner's word: set THUMBS_BACKFILL_OWNER_OK=yes only after it is given",
      );
    }
    // Only the config, the database and the bucket client are used by ensureThumbs; the publishing checks are not.
    const storage = new StorageService(
      new ConfigService(process.env as Record<string, string>),
      prisma as never,
      {} as never,
      {} as never,
    );
    const list = todo.slice(0, LIMIT);
    let next = 0;
    let made = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < list.length) {
          const row = list[next++];
          await storage.ensureThumbs(row.key, { background: true });
          made += 1;
          if (made % 100 === 0) console.log(`  ${made}/${list.length} ...`);
        }
      }),
    );
    const left = (
      await Promise.all(
        list.map(async (r) => {
          const n = await prisma.storageObject.count({
            where: { key: { in: thumbKeysOf(r.key) }, status: 'confirmed' },
          });
          return n === 2 ? 0 : 1;
        }),
      )
    ).reduce((a: number, b: number) => a + b, 0);
    console.log(
      `Done: ${list.length} looked at, ${left} left without copies (broken, too big or unreadable; logged above).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});

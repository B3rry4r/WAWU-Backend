/**
 * VIDEO-PRIVACY (R-127): the one-off sweep for videos already stored. NOT RUN
 * by the task that wrote it: it runs only on the owner's word.
 *
 * Videos uploaded before the cleaner shipped keep their location, device and
 * time tags until this runs. It uses the same cleaner as the upload path
 * (src/storage/video-privacy/), so a file it cannot read is left as it is and
 * logged, and a clean file is never rewritten. Safe to stop and run again.
 *
 *   count   (default) reads the database only: how many video files, how many
 *           bytes, by type, and the estimate of time and transfer. Touches no
 *           storage.
 *   plan    reads each file's box headers and index by ranges (a few small
 *           requests per file) and reports how many carry tags. Writes nothing.
 *   apply   cleans them. Refuses unless VIDEO_SWEEP_OWNER_OK=yes is set, which
 *           the person running it sets only after the owner's word.
 *
 *   npx tsc scripts/sweep-stored-videos.ts --moduleResolution nodenext \
 *     --module nodenext --target ES2023 --esModuleInterop --skipLibCheck \
 *     --emitDecoratorMetadata --experimentalDecorators --outDir dist-seed
 *   DATABASE_URL=... STORAGE_ENDPOINT=... STORAGE_ACCESS_KEY_ID=... \
 *   STORAGE_SECRET_ACCESS_KEY=... STORAGE_BUCKET=... \
 *   node dist-seed/scripts/sweep-stored-videos.js [count|plan|apply] \
 *       [--limit N] [--concurrency 2] [--mbps 20]
 *
 * How it counts: every `StorageObject` row that is `confirmed`, not released,
 * not being removed, and whose key ends in .mp4, .mov or .webm (the three video
 * types the Hub stores). The row's `bytes` is the size reserved at upload and
 * is the figure used for transfer.
 *
 * The estimate (printed by `count`): a file with tags is read whole and written
 * whole once, so at worst every file moves twice its size (the download and
 * the upload), plus about 4 small ranged reads per file to find the tags. The
 * run time is that transfer over --mbps per file (default 20 MB/s each way,
 * a deliberately slow figure) across --concurrency files at once (default 2,
 * the same limit the upload path uses). Files already clean cost only the
 * small reads.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import { createStorageClient } from '../src/storage/storage-client';
import { cleanStoredVideo } from '../src/storage/video-privacy/clean-stored';

const args = process.argv.slice(2);
const mode =
  (['count', 'plan', 'apply'] as const).find((m) => args[0] === m) ?? 'count';
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const LIMIT = flag('limit', Infinity);
const CONCURRENCY = Math.min(flag('concurrency', 2), 4);
const MBPS = flag('mbps', 20);
const MB = 1024 * 1024;
const WHERE: Prisma.StorageObjectWhereInput = {
  status: 'confirmed',
  releasedAt: null,
  removingAt: null,
  OR: [
    { key: { endsWith: '.mp4' } },
    { key: { endsWith: '.mov' } },
    { key: { endsWith: '.webm' } },
  ],
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const rows = await prisma.storageObject.findMany({
      where: WHERE,
      select: { key: true, bytes: true },
    });
    const by = new Map<string, { files: number; bytes: number }>();
    for (const r of rows) {
      const ext = r.key.slice(r.key.lastIndexOf('.') + 1).toLowerCase();
      const t = by.get(ext) ?? { files: 0, bytes: 0 };
      t.files += 1;
      t.bytes += r.bytes;
      by.set(ext, t);
    }
    const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);
    const worstTransfer = 2 * totalBytes + rows.length * 1 * MB;
    const seconds = worstTransfer / (MBPS * MB) / CONCURRENCY;
    console.log(
      `Video files stored: ${rows.length} (${(totalBytes / MB).toFixed(1)} MB)`,
    );
    for (const [ext, t] of by)
      console.log(
        `  .${ext}: ${t.files} files, ${(t.bytes / MB).toFixed(1)} MB`,
      );
    console.log(
      `Worst case (every file carries tags): about ${(worstTransfer / MB / 1024).toFixed(2)} GB moved, ` +
        `about ${(seconds / 60).toFixed(1)} minutes at ${MBPS} MB/s per file, ${CONCURRENCY} at once.`,
    );
    if (mode === 'count') return;

    if (mode === 'apply' && process.env.VIDEO_SWEEP_OWNER_OK !== 'yes') {
      throw new Error(
        "apply needs the owner's word: set VIDEO_SWEEP_OWNER_OK=yes only after it is given",
      );
    }
    const storage = createStorageClient(
      new ConfigService(process.env as Record<string, string>),
    );
    if (!storage)
      throw new Error('Storage is not configured (STORAGE_* settings)');
    const deps = {
      client: storage.client,
      bucket: storage.bucket,
      logger: {
        log: (m: string) => console.log(m),
        warn: (m: string) => console.warn(m),
      },
      dryRun: mode === 'plan',
      stillWanted: async (k: string) => {
        const r = await prisma.storageObject.findUnique({
          where: { key: k },
          select: { releasedAt: true, removingAt: true },
        });
        return !!r && !r.releasedAt && !r.removingAt;
      },
    };
    const todo = rows.slice(0, LIMIT);
    const tally = {
      cleaned: 0,
      wouldClean: 0,
      alreadyClean: 0,
      left: 0,
      notVideo: 0,
      bytes: 0,
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < todo.length) {
          const row = todo[next++];
          const out = await cleanStoredVideo(deps, row.key);
          if (out.result === 'cleaned') {
            tally.cleaned += 1;
            tally.bytes += row.bytes;
          } else if (out.result === 'would-clean') {
            tally.wouldClean += 1;
            tally.bytes += row.bytes;
          } else if (out.result === 'already-clean') tally.alreadyClean += 1;
          else if (out.result === 'left') tally.left += 1;
          else tally.notVideo += 1;
          if (next % 100 === 0) console.log(`  ${next}/${todo.length} ...`);
        }
      }),
    );
    console.log(`Done (${mode}): ${JSON.stringify(tally)}`);
    if (mode === 'plan')
      console.log(
        `Files that would be rewritten move about ${((2 * tally.bytes) / MB / 1024).toFixed(2)} GB.`,
      );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});

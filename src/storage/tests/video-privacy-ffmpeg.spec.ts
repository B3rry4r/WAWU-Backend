// VIDEO-PRIVACY (R-127): real files. Makes tagged MP4, MOV and WebM files with
// ffmpeg (moov at the end and at the start, fragmented), cleans them, and reads
// them back with ffprobe: tags gone, streams and durations the same, and the
// file decodes end to end. Skipped where ffmpeg is not installed (the Hub
// server has none; CI and developer machines may).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planClean } from '../video-privacy/clean-video';
import { applyToBuffer } from '../video-privacy/apply-patches';

const haveFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 &&
  spawnSync('ffprobe', ['-version']).status === 0;
const d = haveFfmpeg ? describe : describe.skip;

const META = [
  '-metadata',
  'location=+06.4542+003.3925/',
  '-metadata',
  'make=Apple',
  '-metadata',
  'model=iPhone15Pro',
  '-metadata',
  'creation_time=2026-11-01T10:00:00Z',
  '-metadata:s:v',
  'creation_time=2026-11-01T10:00:00Z',
];
const VIDEO = [
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=160x120:rate=25:duration=2',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=2',
  '-shortest',
];
const MP4 = [
  ...VIDEO,
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  ...META,
];
const FILES: [string, string[]][] = [
  ['end.mp4', [...MP4, '-movflags', 'use_metadata_tags']],
  ['start.mp4', [...MP4, '-movflags', 'use_metadata_tags+faststart']],
  ['end.mov', [...MP4, '-movflags', 'use_metadata_tags']],
  ['start.mov', [...MP4, '-movflags', 'use_metadata_tags+faststart']],
  [
    'frag.mp4',
    [...MP4, '-movflags', 'use_metadata_tags+frag_keyframe+empty_moov'],
  ],
  ['a.webm', [...VIDEO, '-c:v', 'libvpx', '-c:a', 'libvorbis', ...META]],
];

function probe(file: string) {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,duration,nb_frames:format=duration:format_tags:stream_tags',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(r.stdout) as {
    streams: Record<string, unknown>[];
    format: { duration: string; tags?: Record<string, string> };
  };
}

d('VIDEO-PRIVACY: real files made with ffmpeg', () => {
  const dir = haveFfmpeg ? mkdtempSync(join(tmpdir(), 'vp-')) : '';
  afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.each(FILES)(
    '%s: tags gone, streams and durations unchanged, decodes end to end',
    async (name, args) => {
      const input = join(dir, name);
      expect(
        spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, input]).status,
      ).toBe(0);
      const before = probe(input);
      expect(JSON.stringify(before)).toMatch(/6\.4542|iPhone/i);
      const buf = readFileSync(input);
      const plan = await planClean(name, {
        length: buf.length,
        read: (a, b) =>
          Promise.resolve(buf.subarray(a, Math.min(b, buf.length))),
      });
      expect(plan!.patches.length).toBeGreaterThan(0);
      const out = join(dir, `clean-${name}`);
      writeFileSync(out, applyToBuffer(buf, plan!.patches));
      const after = probe(out);
      expect(JSON.stringify(after)).not.toMatch(/6\.4542|iPhone|Apple/i);
      // The streams, their codecs, durations and frame counts are the same; only their tags differ (the creation time is gone).
      const bare = (r: ReturnType<typeof probe>) =>
        r.streams.map((s) => {
          const rest = { ...s };
          delete rest.tags;
          return rest;
        });
      expect(bare(after)).toEqual(bare(before));
      expect(after.format.duration).toBe(before.format.duration);
      expect(readFileSync(out).length).toBe(buf.length);
      expect(
        spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'])
          .status,
      ).toBe(0);
    },
  );
});

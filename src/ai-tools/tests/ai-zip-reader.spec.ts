import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { zipOf } from '../../../test/ai-tools/zip-fixtures';
import { mp3File } from '../../../test/ai-tools/media-fixtures';
import {
  crc32,
  isPlainPath,
  readZip,
  ZIP_LIMITS,
  ZipRefused,
  type ZipLimits,
  type ZipRefusal,
} from '../music/zip-reader';
import {
  looksLikeMp3,
  stemLabelOf,
  stemSlug,
  STEM_LABELS,
} from '../music/stem-names';

/**
 * AITOOLS-12 (R-109): the strict ZIP reader the Hub opens the stem separation answer with, and the plain names of the
 * parts. The reader is written on `node:zlib` alone (no package to trust); this is its whole safety story. Pure: no
 * database, no provider.
 */
const limits = (over: Partial<ZipLimits> = {}): ZipLimits => ({
  ...ZIP_LIMITS,
  ...over,
});
const refused = (fn: () => unknown): ZipRefusal => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZipRefused) return e.reason;
    throw e;
  }
  throw new Error('the reader accepted the archive');
};
const song = (n = 2) => mp3File(n);

describe('AITOOLS-12: the stem archive reader', () => {
  it('reads stored and deflated entries, skips directories and checks every size and CRC', () => {
    const a = song(1);
    const b = Buffer.concat([song(1), Buffer.from('tail tail tail tail')]);
    const files = readZip(
      zipOf([
        { name: 'stems/', data: Buffer.alloc(0) },
        { name: 'stems/vocals.mp3', data: a, method: 'store' },
        { name: 'stems/other.mp3', data: b, method: 'deflate' },
      ]),
    );
    expect(files.map((f) => f.name)).toEqual([
      'stems/vocals.mp3',
      'stems/other.mp3',
    ]);
    expect(files[0].data.equals(a)).toBe(true);
    expect(files[1].data.equals(b)).toBe(true);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('refuses a name that is not plain: parent folders, absolute paths, backslashes, drives, NULs, empty and repeated names', () => {
    for (const name of [
      '../evil.mp3',
      'a/../../evil.mp3',
      '/etc/passwd',
      'C:\\win.mp3',
      'C:win.mp3',
      'a\\b.mp3',
      'a\u0000b.mp3',
      'a//b.mp3',
      './a.mp3',
      'x'.repeat(256),
    ])
      expect(refused(() => readZip(zipOf([{ name, data: song(1) }])))).toBe(
        'unsafe_name',
      );
    expect(
      refused(() =>
        readZip(
          zipOf([
            { name: 'a.mp3', data: song(1) },
            { name: 'a.mp3', data: song(1) },
          ]),
        ),
      ),
    ).toBe('unsafe_name');
    expect(isPlainPath('stems/vocals.mp3')).toBe(true);
    expect(isPlainPath('vocals.mp3')).toBe(true);
    expect(isPlainPath('..')).toBe(false);
  });

  it('refuses too many entries, an entry or an archive over its limit and all entries together over theirs', () => {
    const many = zipOf(
      Array.from({ length: 13 }, (_, i) => ({
        name: `s${i}.mp3`,
        data: song(1),
      })),
    );
    expect(refused(() => readZip(many))).toBe('too_many_entries');
    const two = zipOf([
      { name: 'a.mp3', data: song(1) },
      { name: 'b.mp3', data: song(1) },
    ]);
    const size = song(1).length;
    expect(
      refused(() => readZip(two, limits({ maxEntryBytes: size - 1 }))),
    ).toBe('too_big');
    expect(
      refused(() => readZip(two, limits({ maxTotalBytes: size + 1 }))),
    ).toBe('too_big');
    expect(refused(() => readZip(two, limits({ maxArchiveBytes: 100 })))).toBe(
      'too_big',
    );
    expect(readZip(two, limits({ maxTotalBytes: size * 2 })).length).toBe(2);
  });

  it('refuses a zip bomb: a header that claims far more than the data, a header that lies low, and entries that share bytes', () => {
    // 50 MB declared for a few bytes: the ratio gives it away before anything is inflated.
    expect(
      refused(() =>
        readZip(
          zipOf([
            {
              name: 'bomb.mp3',
              data: Buffer.alloc(1024),
              method: 'deflate',
              declared: 50 * 1024 * 1024,
            },
          ]),
        ),
      ),
    ).toBe('bomb');
    // 5 MB of zeros that the header says is 64 bytes: the inflater is stopped at the declared size.
    expect(
      refused(() =>
        readZip(
          zipOf([
            {
              name: 'lie.mp3',
              data: Buffer.alloc(5 * 1024 * 1024),
              method: 'deflate',
              declared: 64,
            },
          ]),
        ),
      ),
    ).toBe('bomb');
    // Packed size 0 for a non-empty entry.
    expect(
      refused(() =>
        readZip(
          zipOf([
            {
              name: 'zero.mp3',
              data: Buffer.alloc(8),
              method: 'deflate',
              packed: Buffer.alloc(0),
            },
          ]),
        ),
      ),
    ).toBe('bomb');
    // Two entries pointing at the same bytes.
    expect(
      refused(() =>
        readZip(
          zipOf(
            [
              { name: 'a.mp3', data: song(1) },
              { name: 'b.mp3', data: song(1) },
            ],
            { shareWithPrevious: true },
          ),
        ),
      ),
    ).toBe('bomb');
    // Honest silence packs hundreds to one and is NOT a bomb: a stem of nothing must not fail the job.
    const zeros = Buffer.alloc(40 * 1024);
    const ratio = zeros.length / deflateRawSync(zeros).length;
    expect(ratio).toBeGreaterThan(100);
    expect(ratio).toBeLessThan(ZIP_LIMITS.maxRatio);
    expect(
      readZip(zipOf([{ name: 'z.mp3', data: zeros, method: 'deflate' }]))[0]
        .data.length,
    ).toBe(zeros.length);
  });

  it('refuses what it does not implement and what is damaged', () => {
    expect(
      refused(() => readZip(Buffer.from('not a zip at all, but long enough'))),
    ).toBe('not_zip');
    expect(refused(() => readZip(Buffer.alloc(10)))).toBe('not_zip');
    expect(
      refused(() =>
        readZip(zipOf([{ name: 'a.mp3', data: song(1), flags: 0x801 }])),
      ),
    ).toBe('unsupported');
    expect(
      refused(() => readZip(zipOf([{ name: 'a.mp3', data: song(1), crc: 1 }]))),
    ).toBe('corrupt');
    const ok = zipOf([{ name: 'a.mp3', data: song(1) }]);
    // Cut off in the middle: the end record is gone.
    expect(refused(() => readZip(ok.subarray(0, ok.length - 30)))).toBe(
      'not_zip',
    );
    // Random bytes with a valid end record on the end.
    const junk = Buffer.concat([randomBytes(200), ok.subarray(ok.length - 22)]);
    expect(() => readZip(junk)).toThrow(ZipRefused);
    // Method 12 (bzip2) is not implemented.
    const z = Buffer.from(ok);
    const centralAt = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt16LE(12, centralAt + 10);
    expect(refused(() => readZip(z))).toBe('unsupported');
  });
});

describe('AITOOLS-12: the plain names of the parts', () => {
  it('names a part from the provider file name and says "The rest" for the song without the voice', () => {
    expect(stemLabelOf('vocals.mp3')).toBe('Voice');
    expect(stemLabelOf('stems/Vocals.mp3')).toBe('Voice');
    expect(stemLabelOf('no_vocals.mp3')).toBe('The rest');
    expect(stemLabelOf('instrumental.mp3')).toBe('The rest');
    expect(stemLabelOf('accompaniment.wav')).toBe('The rest');
    expect(stemLabelOf('drums.mp3')).toBe('Drums');
    expect(stemLabelOf('bass.mp3')).toBe('Bass');
    expect(stemLabelOf('guitar.mp3')).toBe('Guitar');
    expect(stemLabelOf('piano.mp3')).toBe('Piano');
    expect(stemLabelOf('other.mp3')).toBe('The rest');
    expect(stemLabelOf('mystery_part.mp3')).toBeNull();
    for (const label of STEM_LABELS)
      expect(label).not.toMatch(/[\u2013\u2014]/);
  });

  it('knows an MP3 by its first bytes and makes a key-safe slug', () => {
    expect(looksLikeMp3(mp3File(1))).toBe(true);
    expect(
      looksLikeMp3(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10)])),
    ).toBe(true);
    expect(looksLikeMp3(Buffer.from('<html>'))).toBe(false);
    expect(looksLikeMp3(Buffer.alloc(2))).toBe(false);
    expect(stemSlug('The rest', 1)).toBe('the-rest-2');
    expect(stemSlug('Voice', 0)).toBe('voice-1');
    expect(stemSlug('???', 2)).toBe('part-3');
  });
});

import { parseBuffer } from 'music-metadata';
import {
  mp3File,
  mp4File,
  wavFile,
} from '../../../test/ai-tools/media-fixtures';
import { cutMp3, cutWav } from '../preview-cut/cut-audio';
import { cutMp4 } from '../preview-cut/cut-mp4';
import { cutPdf, previewPagesFor } from '../preview-cut/cut-pdf';
import {
  CutRefusal,
  CUT_WORDS,
  previewSecondsFor,
} from '../preview-cut/cut-types';
import {
  AUDIO_SAMPLE,
  VIDEO_SAMPLE,
  sourceOf,
  syntheticMp4,
  pdfFile,
  pdfPageCount,
} from '../../../test/content-piece/preview-fixtures';

/**
 * PREVIEW-AUTO: the Hub cuts a paid audio or video piece's preview from the full file, in plain JavaScript. Each length below is read
 * back from the CUT file by the Hub's own reader (`music-metadata`, as AITOOLS-04 reads a recording), never from what the cutter says.
 * (Real phone-style files made with ffmpeg were also cut and read with ffprobe: see tasks/PREVIEW-AUTO.md.)
 */
const seconds = async (b: Buffer, mimeType: string) =>
  (await parseBuffer(new Uint8Array(b), { mimeType }, { duration: true }))
    .format.duration ?? 0;

describe('previewSecondsFor', () => {
  it('is 30 seconds, or the first third of a file under 45 seconds', () => {
    expect(previewSecondsFor(120)).toBe(30);
    expect(previewSecondsFor(45)).toBe(30);
    expect(previewSecondsFor(44.9)).toBeCloseTo(44.9 / 3, 5);
    expect(previewSecondsFor(30)).toBe(10);
  });
});

describe('an MP3 preview', () => {
  it('is the first 30 seconds of a long file, on a frame edge', async () => {
    const full = mp3File(100);
    const out = await cutMp3(sourceOf(full));
    expect(out.contentType).toBe('audio/mpeg');
    expect(await seconds(out.body, 'audio/mpeg')).toBeCloseTo(30, 0);
    expect(out.body.length).toBeLessThan(full.length / 3 + 1000);
    // the same bytes as the start of the file, not a re-encode
    expect(out.body.subarray(0, 417).equals(full.subarray(0, 417))).toBe(true);
  });

  it('is the first third of a file under 45 seconds', async () => {
    const out = await cutMp3(sourceOf(mp3File(36)));
    expect(await seconds(out.body, 'audio/mpeg')).toBeCloseTo(12, 0);
  });

  it('leaves the ID3 tag out and starts at the first frame', async () => {
    const tag = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([4, 0, 0, 0, 0, 0, 100]),
      Buffer.alloc(100, 7),
    ]);
    const out = await cutMp3(sourceOf(Buffer.concat([tag, mp3File(100)])));
    expect(out.body[0]).toBe(0xff);
    expect(await seconds(out.body, 'audio/mpeg')).toBeCloseTo(30, 0);
  });

  it('reads only the start of a long file', async () => {
    const src = sourceOf(mp3File(1500));
    await cutMp3(src);
    expect(Math.max(...src.reads.map((r) => r.end))).toBeLessThan(
      7 * 1024 * 1024,
    );
  });

  it("refuses a file too short to cut, in the Hub's own words", async () => {
    await expect(cutMp3(sourceOf(mp3File(2)))).rejects.toMatchObject({
      code: 'too_short',
      message: CUT_WORDS.too_short,
    });
    await expect(
      cutMp3(sourceOf(Buffer.alloc(5000, 1))),
    ).rejects.toBeInstanceOf(CutRefusal);
  });
});

describe('a WAV preview', () => {
  it('is the first 30 seconds of the samples under a fresh header', async () => {
    const out = await cutWav(sourceOf(wavFile(100)));
    expect(out.contentType).toBe('audio/wav');
    expect(await seconds(out.body, 'audio/wav')).toBeCloseTo(30, 1);
    expect(out.body.readUInt32LE(4)).toBe(out.body.length - 8);
    expect(out.body.length).toBe(44 + 30 * 8000);
  });

  it('is the first third of a short file, and refuses a file under 3 seconds', async () => {
    expect(
      await seconds((await cutWav(sourceOf(wavFile(30)))).body, 'audio/wav'),
    ).toBeCloseTo(10, 1);
    await expect(cutWav(sourceOf(wavFile(2)))).rejects.toMatchObject({
      code: 'too_short',
    });
    await expect(cutWav(sourceOf(Buffer.alloc(100)))).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('an MP4 preview', () => {
  const expectedMdat = (s: number) => {
    // 10 frames a second, 44.1 kHz audio in 1024-sample frames: the samples that start before `s`
    const v = Math.ceil(s * 10);
    const a = Math.ceil((s * 44100) / 1024);
    return v * VIDEO_SAMPLE + a * AUDIO_SAMPLE;
  };
  const mdatSize = (b: Buffer) => {
    const at = b.indexOf('mdat', 0, 'latin1') - 4;
    return b.readUInt32BE(at) - 8;
  };

  it('is the first 30 seconds of a file whose index is at the end', async () => {
    const full = syntheticMp4(100);
    const src = sourceOf(full);
    const out = await cutMp4(src);
    expect(out.contentType).toBe('video/mp4');
    expect(await seconds(out.body, 'video/mp4')).toBeCloseTo(30, 0);
    expect(out.body.toString('latin1', 4, 8)).toBe('ftyp');
    expect(out.body.indexOf('moov', 0, 'latin1')).toBeLessThan(
      out.body.indexOf('mdat', 0, 'latin1'),
    );
    expect(mdatSize(out.body)).toBe(expectedMdat(30));
    expect(out.body.length).toBeLessThan(full.length / 2);
    // the first video sample is the same bytes as the file's first
    const at = out.body.indexOf('mdat', 0, 'latin1') + 4;
    expect(
      out.body
        .subarray(at, at + VIDEO_SAMPLE)
        .equals(
          full.subarray(
            full.indexOf('mdat', 0, 'latin1') + 4,
            full.indexOf('mdat', 0, 'latin1') + 4 + VIDEO_SAMPLE,
          ),
        ),
    ).toBe(true);
  });

  it('does the same when the index is at the front, and for a QuickTime file', async () => {
    const front = await cutMp4(
      sourceOf(syntheticMp4(100, { moovFirst: true })),
    );
    expect(await seconds(front.body, 'video/mp4')).toBeCloseTo(30, 0);
    const mov = await cutMp4(sourceOf(syntheticMp4(100, { brand: 'qt  ' })));
    expect(mov.body.toString('latin1', 8, 12)).toBe('isom');
    expect(await seconds(mov.body, 'video/mp4')).toBeCloseTo(30, 0);
  });

  it('is the first third of a short file, and refuses one under 3 seconds', async () => {
    const out = await cutMp4(sourceOf(syntheticMp4(30)));
    expect(await seconds(out.body, 'video/mp4')).toBeCloseTo(10, 0);
    await expect(cutMp4(sourceOf(syntheticMp4(2)))).rejects.toMatchObject({
      code: 'too_short',
    });
  });

  it('refuses a file written in fragments and one that is not an MP4, so the creator uses their own clip', async () => {
    await expect(
      cutMp4(sourceOf(mp4File({ fragmented: true }))),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: CUT_WORDS.unsupported,
    });
    await expect(cutMp4(sourceOf(Buffer.alloc(300, 9)))).rejects.toBeInstanceOf(
      CutRefusal,
    );
  });

  it('reads the index and the wanted samples, not the whole file', async () => {
    const full = syntheticMp4(600);
    const src = sourceOf(full);
    await cutMp4(src);
    const read = src.reads.reduce(
      (n, r) => n + (Math.min(r.end, full.length) - r.start),
      0,
    );
    expect(read).toBeLessThan(full.length / 4);
  });
});

describe('a PDF preview (R-118)', () => {
  it('holds 3 pages for 6 or more, and 1 for fewer', () => {
    expect(previewPagesFor(84)).toBe(3);
    expect(previewPagesFor(6)).toBe(3);
    expect(previewPagesFor(5)).toBe(1);
    expect(previewPagesFor(2)).toBe(1);
  });

  it('is the first 3 pages of a long file, counted from the stored cut', async () => {
    const full = await pdfFile(12, { pad: 40_000 });
    const out = await cutPdf(sourceOf(full));
    expect(out.contentType).toBe('application/pdf');
    expect(out.pages).toBe(3);
    expect(out.sourcePages).toBe(12);
    expect(await pdfPageCount(out.body)).toBe(3);
    // only what its pages use came along: the nine pages left out take their pictures with them
    expect(out.body.length).toBeLessThan(full.length / 2);
  });

  it('is the first page of a file under 6 pages, and of a file of exactly 6 it is 3', async () => {
    expect(
      await pdfPageCount((await cutPdf(sourceOf(await pdfFile(5)))).body),
    ).toBe(1);
    expect(
      await pdfPageCount((await cutPdf(sourceOf(await pdfFile(6)))).body),
    ).toBe(3);
  });

  it("refuses a one page file, a locked file and a file that is not a PDF, each in the Hub's own words", async () => {
    await expect(cutPdf(sourceOf(await pdfFile(1)))).rejects.toMatchObject({
      message: CUT_WORDS.single_page,
    });
    await expect(
      cutPdf(sourceOf(await pdfFile(8, { locked: true }))),
    ).rejects.toMatchObject({ message: CUT_WORDS.locked });
    await expect(
      cutPdf(sourceOf(Buffer.from('not a pdf at all, just words'))),
    ).rejects.toMatchObject({ message: CUT_WORDS.unsupported });
    await expect(cutPdf(sourceOf(Buffer.alloc(0)))).rejects.toBeInstanceOf(
      CutRefusal,
    );
  });

  it('none of the refusal words sends the creator to an own clip the app no longer has', () => {
    for (const words of Object.values(CUT_WORDS))
      expect(words.toLowerCase()).not.toContain('own clip');
  });
});

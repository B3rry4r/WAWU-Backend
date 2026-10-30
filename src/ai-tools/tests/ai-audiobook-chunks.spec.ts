// AITOOLS-13: the pure parts of the Audiobook. The text is cut into chapters at a heading or under the model's limit, the
// same text always makes the same chapters (a Hub that restarts finds the chapters it had), and mp3 pieces join into one
// file whose length the Hub's own reader reads as the sum of the pieces. No database, no HTTP, no provider.

import { readSeconds } from '../input/media-length';
import {
  chunkBook,
  contextOf,
  CONTEXT_CHARS,
  normalizeBook,
} from '../audiobook/audiobook-chunks';
import { joinMp3, Mp3Error, readMp3 } from '../audiobook/mp3-join';
import { bookRef, parseBookRef } from '../audiobook/audiobook-support';
import { castRef, parseCastRef } from '../podcast/podcast-support';

jest.setTimeout(60_000);

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding, stereo: 417 bytes of silence a frame. */
const frame = (rateIndex = 0): Buffer => {
  const size = rateIndex === 0 ? 417 : 384;
  const f = Buffer.alloc(size);
  f.writeUInt32BE(rateIndex === 0 ? 0xfffb9004 : 0xfffb9404, 0);
  return f;
};
const frames = (n: number, rateIndex = 0): Buffer =>
  Buffer.concat(Array.from({ length: n }, () => frame(rateIndex)));
/** An ID3v2 tag of `size` bytes after its header. */
const id3v2 = (size: number): Buffer => {
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 3;
  head[6] = (size >> 21) & 0x7f;
  head[7] = (size >> 14) & 0x7f;
  head[8] = (size >> 7) & 0x7f;
  head[9] = size & 0x7f;
  return Buffer.concat([head, Buffer.alloc(size)]);
};
/** A Xing/Info header frame: a frame with the tag where the side info ends (36 bytes in, stereo MPEG-1). */
const infoFrame = (): Buffer => {
  const f = frame();
  f.write('Info', 36, 'latin1');
  return f;
};
const id3v1 = (): Buffer => {
  const t = Buffer.alloc(128);
  t.write('TAG', 0, 'latin1');
  return t;
};
const FRAME_SECONDS = 1152 / 44100;

describe('AITOOLS-13: cutting a long text into chapters', () => {
  const paragraph = (n: number) => `${'Word '.repeat(n).trim()}.`;

  it('cuts the same text into the same chapters every time, each under the limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => paragraph(80 + i)).join(
      '\n\n',
    );
    const a = chunkBook(text, 2000);
    expect(a.length).toBeGreaterThan(3);
    expect(chunkBook(text, 2000)).toEqual(a);
    for (const c of a) expect(c.length).toBeLessThanOrEqual(2000);
    // Nothing is lost or invented: the chapters hold every paragraph in order.
    expect(a.join('\n\n').replace(/\s+/g, ' ')).toBe(
      normalizeBook(text).replace(/\s+/g, ' '),
    );
  });

  it('starts a chapter at a heading once the one before has some weight, and not before', () => {
    const body = paragraph(400);
    const text = `# One\n\n${body}\n\n# Two\n\n${body}\n\nChapter 3: The end\n\n${body}`;
    const chapters = chunkBook(text, 9000);
    expect(chapters).toHaveLength(3);
    expect(chapters[0].startsWith('# One')).toBe(true);
    expect(chapters[1].startsWith('# Two')).toBe(true);
    expect(chapters[2].startsWith('Chapter 3')).toBe(true);
    // A heading straight after a few words does not leave them alone.
    const tiny = chunkBook(`# A\n\nHi.\n\n# B\n\nThere.`, 9000);
    expect(tiny).toHaveLength(1);
  });

  it('cuts a paragraph that is too long at a sentence end, then at a space, then in a word', () => {
    const sentences = Array.from(
      { length: 50 },
      (_, i) => `This is sentence ${i}.`,
    ).join(' ');
    const cut = chunkBook(sentences, 300);
    expect(cut.length).toBeGreaterThan(2);
    for (const c of cut) {
      expect(c.length).toBeLessThanOrEqual(300);
      expect(c.endsWith('.')).toBe(true);
    }
    const spaced = chunkBook('word '.repeat(400).trim(), 300);
    for (const c of spaced) expect(c.length).toBeLessThanOrEqual(300);
    const solid = chunkBook('x'.repeat(1000), 400);
    expect(solid.map((c) => c.length)).toEqual([400, 400, 200]);
    // Never between the two halves of an emoji.
    const emoji = chunkBook('\u{1F600}'.repeat(300), 201);
    for (const c of emoji) expect(c).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('has no chapters for an empty text, and strips what must not be spoken', () => {
    expect(chunkBook('  \n\n ', 9000)).toEqual([]);
    expect(normalizeBook('﻿a\r\nb\u0000\n\n\n\nc')).toBe('a\nb\n\nc');
  });

  it('gives each chapter the words around it and nothing past the ends', () => {
    const chapters = ['a'.repeat(900), 'b'.repeat(900), 'c'.repeat(900)];
    expect(contextOf(chapters, 0)).toEqual({
      previous: null,
      next: 'b'.repeat(CONTEXT_CHARS),
    });
    expect(contextOf(chapters, 1)).toEqual({
      previous: 'a'.repeat(CONTEXT_CHARS),
      next: 'c'.repeat(CONTEXT_CHARS),
    });
    expect(contextOf(chapters, 2).next).toBeNull();
  });

  it('notes the chapters on the row and reads them back, and refuses a note that is not its own', () => {
    expect(parseBookRef(bookRef(12, 9000))).toEqual({
      chapters: 12,
      chunkChars: 9000,
    });
    expect(parseBookRef('bookrun:0:9000')).toBeNull();
    expect(parseBookRef('bookrun:12:9000:x')).toBeNull();
    expect(parseBookRef('genrun:image:abc')).toBeNull();
    expect(parseBookRef(null)).toBeNull();
    expect(parseCastRef(castRef('pod-1'))).toBe('pod-1');
    expect(parseCastRef('castrun:../x')).toBeNull();
    expect(parseCastRef('bookrun:1:9000')).toBeNull();
  });
});

describe('AITOOLS-13: joining mp3 pieces into one file', () => {
  it('writes the frames one after the other and leaves out the tags and the header frames', () => {
    const a = Buffer.concat([id3v2(300), infoFrame(), frames(40), id3v1()]);
    const b = Buffer.concat([infoFrame(), frames(60)]);
    const c = frames(25);
    const joined = joinMp3([a, b, c]);
    expect(joined.frames).toBe(125);
    expect(joined.audio.length).toBe(125 * 417);
    expect(joined.seconds).toBeCloseTo(125 * FRAME_SECONDS, 3);
    expect(readMp3(a).frames).toBe(40);
  });

  it("plays: the Hub's own reader reads the joined file as the sum of the pieces", async () => {
    const pieces = [frames(400), frames(700), frames(250)];
    const joined = joinMp3(pieces);
    const read = await readSeconds(joined.audio);
    expect(read).not.toBeNull();
    expect(read as number).toBeCloseTo(1350 * FRAME_SECONDS, 1);
    const each = await Promise.all(pieces.map((p) => readSeconds(p)));
    expect((each as number[]).reduce((n, s) => n + s, 0)).toBeCloseTo(
      read as number,
      1,
    );
  });

  it('refuses a piece that is not whole mpeg audio, one cut off, and one in another format', () => {
    expect(() =>
      joinMp3([Buffer.from('this is not audio at all, just words')]),
    ).toThrow(Mp3Error);
    expect(() => joinMp3([frames(10).subarray(0, 4000)])).toThrow(Mp3Error);
    expect(() => joinMp3([frames(10), frames(10, 1)])).toThrow(/differ/);
    expect(() => joinMp3([])).toThrow(Mp3Error);
    expect(() =>
      readMp3(Buffer.concat([frames(5), Buffer.from('JUNK')])),
    ).toThrow(Mp3Error);
  });
});

import {
  adtsFile,
  adtsHeader,
  mp3File,
} from '../../../test/ai-tools/media-fixtures';
import { readSeconds } from '../input/media-length';
import { SNIFF_HEAD_BYTES, sniffContainer } from '../input/media-sniff';

/**
 * AITOOLS-04 round 3, LOW (a): a file that merely opens with FF F1 was taken
 * as ADTS AAC, and 8 MB of 0xFF held a parser worker for its whole 15 s limit.
 * The header's fields are checked, and two frames in a row are required.
 */
describe('AITOOLS-04 r3: the AAC sniff checks the ADTS headers', () => {
  const frame = (length: number, rate = 4) =>
    Buffer.concat([adtsHeader(length, rate), Buffer.alloc(length - 7)]);

  it('takes real ADTS: many frames, or exactly two', () => {
    expect(sniffContainer(adtsFile(1))).toBe('aac');
    expect(sniffContainer(Buffer.concat([frame(200), frame(200)]))).toBe('aac');
    // The longest frame the header can say (8191 bytes), then the next header.
    expect(sniffContainer(Buffer.concat([frame(8191), frame(100)]))).toBe(
      'aac',
    );
  });

  it('refuses a file that only opens FF F1: 8 MB of 0xFF, 8 MB of FF F1 repeated, a header and then zeros', () => {
    const ff = Buffer.alloc(8 * 1024 * 1024, 0xff);
    expect(sniffContainer(ff.subarray(0, SNIFF_HEAD_BYTES))).toBeNull();
    const pattern = Buffer.alloc(8 * 1024 * 1024);
    pattern.fill(Buffer.from([0xff, 0xf1]));
    expect(sniffContainer(pattern.subarray(0, SNIFF_HEAD_BYTES))).toBeNull();
    const lone = Buffer.concat([adtsHeader(200), Buffer.alloc(5000)]);
    expect(sniffContainer(lone)).toBeNull(); // one header, nothing at the next
    const opens = Buffer.alloc(SNIFF_HEAD_BYTES);
    opens[0] = 0xff;
    opens[1] = 0xf1;
    expect(sniffContainer(opens)).toBeNull();
  });

  it('checks every field: frame length, sampling rate, and a second frame that repeats the first', () => {
    // a frame shorter than its own header
    expect(
      sniffContainer(Buffer.concat([frame(200), frame(200)]).fill(0, 3, 6)),
    ).toBeNull();
    // a sampling-frequency index of 13 (reserved)
    expect(
      sniffContainer(Buffer.concat([frame(200, 13), frame(200, 13)])),
    ).toBeNull();
    // the second frame changes sampling rate: not one stream
    expect(
      sniffContainer(Buffer.concat([frame(200, 4), frame(200, 3)])),
    ).toBeNull();
    // the second header is a few bytes off where the first says it ends
    expect(
      sniffContainer(
        Buffer.concat([frame(200), Buffer.alloc(3), frame(200), frame(200)]),
      ),
    ).toBeNull();
    // layer bits that are not 00
    const bad = Buffer.concat([frame(200), frame(200)]);
    bad[1] = 0xf3;
    expect(sniffContainer(bad)).not.toBe('aac');
  });

  it('still takes an MP3 frame (FF FB) and leaves it to the MP3 rule', () => {
    expect(sniffContainer(mp3File(1))).toBe('mp3');
  });

  it('8 MB of 0xFF opening FF F1 is refused at once: no worker, no 15 s hold', async () => {
    const hostile = Buffer.alloc(8 * 1024 * 1024, 0xff);
    hostile[1] = 0xf1;
    hostile[2] = 0x50;
    const t0 = Date.now();
    expect(await readSeconds(hostile)).toBeNull();
    const took = Date.now() - t0;
    console.log(`8 MB FF F1 file refused in ${took} ms`);
    expect(took).toBeLessThan(500);
  });

  it('a real AAC stream is still read after the change', async () => {
    expect(await readSeconds(adtsFile(90))).toBeCloseTo(90, 0);
  });
});

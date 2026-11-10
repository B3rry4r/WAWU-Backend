import { Transform } from 'node:stream';
import type { Patch } from './types';

/**
 * VIDEO-PRIVACY: a stream that passes a file through unchanged except where a
 * plan's patches say otherwise. Patches must be sorted and not overlap
 * (`checkPatches`). The output is exactly as long as the input.
 */
export function patchStream(patches: readonly Patch[]): Transform {
  let pos = 0;
  let at = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const start = pos;
      const end = pos + chunk.length;
      pos = end;
      while (
        at < patches.length &&
        patches[at].offset + patches[at].length <= start
      )
        at += 1;
      let out = chunk;
      for (let k = at; k < patches.length && patches[k].offset < end; k += 1) {
        const p = patches[k];
        const from = Math.max(p.offset, start);
        const to = Math.min(p.offset + p.length, end);
        if (to <= from) continue;
        if (out === chunk) out = Buffer.from(chunk);
        if (p.bytes)
          p.bytes.copy(out, from - start, from - p.offset, to - p.offset);
        else out.fill(0, from - start, to - start);
      }
      done(null, out);
    },
  });
}

/** The same change applied to a buffer (for specs and the sweep script's dry run). */
export function applyToBuffer(buf: Buffer, patches: readonly Patch[]): Buffer {
  const out = Buffer.from(buf);
  for (const p of patches) {
    if (p.bytes) p.bytes.copy(out, p.offset);
    else out.fill(0, p.offset, p.offset + p.length);
  }
  return out;
}

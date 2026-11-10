/**
 * VIDEO-PRIVACY (R-127): what the cleaners share. A cleaner reads a stored
 * video through `VideoSource` (ranged reads, never the whole file) and answers
 * with a plan: a short list of byte patches, each the same size as the bytes it
 * replaces, so every offset in the file stays valid and nothing is re-encoded.
 * A file a cleaner cannot read throws `Unreadable`; the caller leaves the file
 * as it is.
 */
export interface VideoSource {
  length: number;
  /** Bytes `[start, endExclusive)`; fewer come back only at the end of the file. */
  read(start: number, endExclusive: number): Promise<Buffer>;
}

/** `length` bytes at `offset` become `bytes`, or zeros when `bytes` is null. */
export interface Patch {
  offset: number;
  length: number;
  bytes: Buffer | null;
}

export interface CleanPlan {
  kind: 'mp4' | 'webm';
  patches: Patch[];
  /** What the plan takes out, for the log (box names, counts). */
  removed: string[];
  /** Things left as they are, and why. */
  notes: string[];
}

export class Unreadable extends Error {
  constructor(why = 'unreadable') {
    super(why);
    this.name = 'Unreadable';
  }
}

/** Sorted, inside the file and not overlapping, or the plan is refused. */
export function checkPatches(patches: Patch[], length: number): Patch[] {
  const sorted = [...patches].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const p of sorted) {
    if (
      p.length <= 0 ||
      p.offset < end ||
      p.offset + p.length > length ||
      (p.bytes && p.bytes.length !== p.length)
    ) {
      throw new Unreadable('patch outside the file or overlapping');
    }
    end = p.offset + p.length;
  }
  return sorted;
}

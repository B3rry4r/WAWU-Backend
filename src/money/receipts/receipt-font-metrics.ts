/**
 * How wide the receipt's text is drawn (task WALLET-18, round 2), from the
 * fonts' own tables: each character's advance width, read once from the
 * TrueType `cmap`, `hmtx`, `hhea` and `head` tables when the server starts.
 * Measuring a string is then a sum over its characters, so wrapping and
 * trimming a printed line costs a few microseconds, whatever its length:
 * the renderer is never asked to measure anything.
 *
 * Kerning (GPOS) is not applied; KERNING_ALLOWANCE covers it, so a line
 * measured to fit always fits.
 */

/** Drawn text is never more than this much wider than the advance sum. */
export const KERNING_ALLOWANCE = 1.03;

export class FontMetrics {
  private readonly advances = new Map<number, number>();
  private readonly unitsPerEm: number;
  private readonly fallback: number;

  constructor(font: Buffer) {
    const tables = new Map<string, number>();
    const count = font.readUInt16BE(4);
    for (let i = 0; i < count; i += 1) {
      const at = 12 + i * 16;
      tables.set(
        font.toString('latin1', at, at + 4),
        font.readUInt32BE(at + 8),
      );
    }
    const table = (tag: string) => {
      const at = tables.get(tag);
      if (at === undefined)
        throw new Error(`Receipt font has no ${tag} table.`);
      return at;
    };
    this.unitsPerEm = font.readUInt16BE(table('head') + 18);
    const longMetrics = font.readUInt16BE(table('hhea') + 34);
    const hmtx = table('hmtx');
    const advanceOf = (glyph: number) =>
      font.readUInt16BE(hmtx + 4 * Math.min(glyph, longMetrics - 1));

    // cmap: the Windows Unicode BMP subtable (format 4).
    const cmap = table('cmap');
    let sub = -1;
    for (let i = 0; i < font.readUInt16BE(cmap + 2); i += 1) {
      const rec = cmap + 4 + i * 8;
      const platform = font.readUInt16BE(rec);
      const encoding = font.readUInt16BE(rec + 2);
      const at = cmap + font.readUInt32BE(rec + 4);
      if (font.readUInt16BE(at) === 4 && (platform === 3 || platform === 0)) {
        sub = at;
        if (platform === 3 && encoding === 1) break;
      }
    }
    if (sub < 0) throw new Error('Receipt font has no format 4 cmap.');
    const segments = font.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const offsets = deltas + segments * 2;
    for (let s = 0; s < segments; s += 1) {
      const end = font.readUInt16BE(ends + s * 2);
      const start = font.readUInt16BE(starts + s * 2);
      const delta = font.readInt16BE(deltas + s * 2);
      const rangeAt = offsets + s * 2;
      const range = font.readUInt16BE(rangeAt);
      for (let c = start; c <= end && c !== 0xffff; c += 1) {
        let glyph: number;
        if (range === 0) glyph = (c + delta) & 0xffff;
        else {
          const g = font.readUInt16BE(rangeAt + range + (c - start) * 2);
          glyph = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        if (glyph !== 0) this.advances.set(c, advanceOf(glyph));
      }
    }
    // A character the font lacks is drawn as its missing-glyph box: glyph 0.
    this.fallback = advanceOf(0);
  }

  /** The drawn width of `text` at `size` points, kerning allowed for. */
  width(text: string, size: number, letterSpacing = 0): number {
    let units = 0;
    let n = 0;
    for (const ch of text) {
      units += this.advances.get(ch.codePointAt(0)!) ?? this.fallback;
      n += 1;
    }
    return (
      ((units / this.unitsPerEm) * size + letterSpacing * n) * KERNING_ALLOWANCE
    );
  }
}

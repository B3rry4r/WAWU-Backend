/**
 * Text cut at what a person sees as one character (BILLS-01 round 3, R2-5). The Hub caps the owner's name and address it
 * passes on (D9); a cut by code points splits a family emoji, a flag or a letter and its accent, so the cut is made on
 * grapheme boundaries: `Intl.Segmenter` where the runtime has it (Node does), and a small rule where it does not (Hermes
 * lists no `Intl.Segmenter`, docs/IntlAPIs.md in facebook/hermes; the app caps nothing, so only this Hub uses it).
 */

type Split = (text: string) => string[];

/** Marks, the zero-width joiner, skin tones, variation selectors and tag characters stay with the character before them. */
const ZWJ = '\u200d';
const EXTENDS = /^[\p{M}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** The text as `Intl.Segmenter` splits it into graphemes. */
export const graphemesBySegmenter: Split = (text) => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
};

/**
 * The text split by a small rule, for a runtime without `Intl.Segmenter`: a code point joins the one before it when it is a
 * combining mark, a zero-width joiner, a skin tone, a variation selector or a tag character; when the one before it is a
 * zero-width joiner (so a family emoji is one character); or when it completes a pair of regional indicators (a flag).
 * It does not know Hangul syllable sequences or every script's clusters: it never splits the three the cut was reported on.
 */
export const graphemesByRule: Split = (text) => {
  const clusters: string[] = [];
  for (const point of text) {
    const last = clusters.length - 1;
    const joins =
      last >= 0 &&
      (EXTENDS.test(point) ||
        point === ZWJ ||
        clusters[last].endsWith(ZWJ) ||
        (REGIONAL_INDICATOR.test(point) &&
          REGIONAL_INDICATOR.test(clusters[last])));
    if (joins) clusters[last] += point;
    else clusters.push(point);
  }
  return clusters;
};

/** The split this runtime uses: the segmenter when it has one. */
export function graphemes(text: string): string[] {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? graphemesBySegmenter(text)
    : graphemesByRule(text);
}

/**
 * The first `max` graphemes of `text`, whole. `endCut` says the text was cut short by bytes (`boundBytes`), so its last
 * grapheme may be only part of one: it is left out.
 */
export function clipGraphemes(
  text: string,
  max: number,
  split: Split = graphemes,
  endCut = false,
): string {
  const parts = split(text);
  if (endCut) parts.pop();
  return parts.slice(0, max).join('');
}

/** How many bytes a code point takes in UTF-8. */
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The text cut to at most `maxBytes` bytes (UTF-8), at a code point, and whether it was cut. It reads only as far as the
 * cap, so a name of five megabytes costs no more than one of the cap's size (BILLS-01 round 4, R3-6: the grapheme cut ran
 * over the whole text and took 3.9 s on 5 MB). The cut can land inside a character a person sees as one, so a caller that
 * cut drops the last grapheme (see `clipGraphemes`).
 */
export function boundBytes(
  text: string,
  maxBytes: number,
): { text: string; cut: boolean } {
  if (text.length * 3 <= maxBytes) return { text, cut: false };
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    const size = utf8Bytes(point.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) return { text: text.slice(0, end), cut: true };
    bytes += size;
    end += point.length;
  }
  return { text, cut: false };
}

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

/** The first `max` graphemes of `text`, whole. */
export function clipGraphemes(
  text: string,
  max: number,
  split: Split = graphemes,
): string {
  return split(text).slice(0, max).join('');
}

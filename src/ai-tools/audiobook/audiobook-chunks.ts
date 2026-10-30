/**
 * Splits a long text into the chapters an Audiobook is spoken in (AITOOLS-13, R-109). Pure: no I/O, the same text and
 * limit always give the same chapters, so a job that restarts finds the same pieces it had.
 *
 * A chapter starts at a heading line (a `#` line, or a line that begins "Chapter", "Part", "Prologue" and the like) once the
 * one before it has some weight, and is never longer than `maxChars` (the speech model takes 10,000 in one request).
 * A paragraph that is too long for one chapter is cut at a sentence end, then at a space, and only as a last resort
 * in the middle of a word.
 */

/** The shortest a chapter is before a heading is allowed to start the next one: a heading never leaves a few words alone. */
const MIN_BEFORE_HEADING = 1500;
/** How much of the text on each side is sent with a chapter so the voice carries across the join. */
export const CONTEXT_CHARS = 500;

const HEADING =
  /^(?:#{1,6}\s+\S.*|(?:chapter|part|book|prologue|epilogue|preface|introduction|act)\b.{0,70})$/i;
const SENTENCE_END = /(?<=[.!?…。！？])\s+/u;

/** The text as the chapters read it: one kind of line end, no control characters, no runs of blank lines, trimmed. */
export function normalizeBook(raw: string): string {
  const noMark = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return (
    noMark
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function isHeading(paragraph: string): boolean {
  return !paragraph.includes('\n') && HEADING.test(paragraph.trim());
}

/** Cuts one paragraph that is longer than `max` into pieces of at most `max`. */
function cutLong(paragraph: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur !== '') out.push(cur);
    cur = '';
  };
  for (const sentence of paragraph.split(SENTENCE_END)) {
    if (sentence.length > max) {
      push();
      let rest = sentence;
      while (rest.length > max) {
        let at = rest.lastIndexOf(' ', max);
        if (at < max / 2) at = max;
        // Never between the two halves of a surrogate pair.
        const code = rest.charCodeAt(at - 1);
        if (code >= 0xd800 && code <= 0xdbff) at -= 1;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
      continue;
    }
    if (cur !== '' && cur.length + 1 + sentence.length > max) push();
    cur = cur === '' ? sentence : `${cur} ${sentence}`;
  }
  push();
  return out.filter((p) => p !== '');
}

/** The chapters of `raw`, each at most `maxChars` long, in order. An empty text has none. */
export function chunkBook(raw: string, maxChars: number): string[] {
  const text = normalizeBook(raw);
  if (text === '') return [];
  const max = Math.max(200, Math.floor(maxChars));
  const minBefore = Math.min(MIN_BEFORE_HEADING, Math.floor(max / 3));
  const chapters: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim() !== '') chapters.push(cur.trim());
    cur = '';
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (isHeading(paragraph) && cur.length >= minBefore) flush();
    if (paragraph.length > max) {
      flush();
      const pieces = cutLong(paragraph, max);
      for (let i = 0; i < pieces.length - 1; i += 1) chapters.push(pieces[i]);
      cur = pieces[pieces.length - 1] ?? '';
      continue;
    }
    if (cur !== '' && cur.length + 2 + paragraph.length > max) flush();
    cur = cur === '' ? paragraph : `${cur}\n\n${paragraph}`;
  }
  flush();
  return chapters;
}

/** What the speech route is told came before and after chapter `index`, so the voice does not restart at each join. */
export function contextOf(
  chapters: readonly string[],
  index: number,
): { previous: string | null; next: string | null } {
  const before = index > 0 ? chapters[index - 1] : null;
  const after = index + 1 < chapters.length ? chapters[index + 1] : null;
  return {
    previous: before === null ? null : before.slice(-CONTEXT_CHARS),
    next: after === null ? null : after.slice(0, CONTEXT_CHARS),
  };
}

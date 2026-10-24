import type { TranscriptWord } from '../voice/ai-voice-provider';

/** The most words, and the longest time, in one subtitle. */
const MAX_WORDS_PER_CUE = 8;
const MAX_CUE_SECONDS = 4;
/** A pause this long (seconds) between two words starts a new subtitle. */
const PAUSE_SECONDS = 1;

function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)},${String(ms).padStart(3, '0')}`;
}

/**
 * Builds the subtitle file (SRT) from the word times (AITOOLS-04). The
 * provider's answer carries the words with their start and end; the Hub makes
 * the file itself and asks the provider for no export format. A cue ends at
 * the end of a sentence, after a pause, at eight words or four seconds. A
 * recording with no spoken word has no subtitles (an empty file).
 */
export function buildSrt(
  words: readonly TranscriptWord[],
  fallback: { text: string; durationSeconds: number | null },
): string {
  const spoken = words.filter((w) => w.type === 'word' && w.text.trim() !== '');
  if (spoken.length === 0) {
    const text = fallback.text.trim();
    if (text === '') return '';
    return `1\n${stamp(0)} --> ${stamp(Math.max(1, fallback.durationSeconds ?? 1))}\n${text}\n`;
  }
  const cues: { start: number; end: number; text: string }[] = [];
  let cue: { start: number; end: number; words: string[] } | null = null;
  const flush = () => {
    if (cue)
      cues.push({
        start: cue.start,
        end: Math.max(cue.end, cue.start + 0.2),
        text: cue.words.join(' '),
      });
    cue = null;
  };
  for (const w of spoken) {
    if (
      cue &&
      (cue.words.length >= MAX_WORDS_PER_CUE ||
        w.end - cue.start > MAX_CUE_SECONDS ||
        w.start - cue.end > PAUSE_SECONDS)
    )
      flush();
    if (!cue) cue = { start: w.start, end: w.end, words: [] };
    cue.words.push(w.text.trim());
    cue.end = w.end;
    if (/[.!?]$/.test(w.text.trim())) flush();
  }
  flush();
  return cues
    .map(
      (c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`,
    )
    .join('\n');
}

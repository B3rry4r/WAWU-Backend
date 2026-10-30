/**
 * Plain names for the parts of a split song (AITOOLS-12, R-109). The provider's own names for the files in its answer
 * are NOT KNOWN yet (docs/elevenlabs/API-FACTS.md, "Split a song"): the stand-in guesses, and the one proof call reads
 * the real ones and the table below is then corrected. Until then a name the table does not know is called "Part N", so
 * no person ever reads a file name from the provider (R-68) and nothing is lost.
 */
export const STEM_LABELS = [
  'Voice',
  'Drums',
  'Bass',
  'Guitar',
  'Piano',
  'The rest',
] as const;

/** Matched in order against the lower-case name of the file without its folder or extension. */
const STEM_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // "no vocals", "instrumental" and "accompaniment" are the song WITHOUT the voice: they must not read as the voice.
  [/(no[ _-]?vocal|instrumental|accompaniment|backing|karaoke)/, 'The rest'],
  [/(vocal|voice|singing)/, 'Voice'],
  [/drum|percussion/, 'Drums'],
  [/bass/, 'Bass'],
  [/guitar/, 'Guitar'],
  [/piano|keys|keyboard/, 'Piano'],
  [/other|rest|remaining|everything/, 'The rest'],
];

/** The plain name of a stem from its file name in the archive, or null when the table does not know it. */
export function stemLabelOf(entryName: string): string | null {
  const base = entryName.split('/').pop() ?? entryName;
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').toLowerCase();
  for (const [pattern, label] of STEM_PATTERNS)
    if (pattern.test(stem)) return label;
  return null;
}

/** True when the bytes begin like an MP3 file: an ID3 tag or an MPEG audio frame sync. */
export function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf.toString('latin1', 0, 3) === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

/** A label that is safe in a storage key (letters and digits only) and unique per stem. */
export function stemSlug(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'part'}-${index + 1}`;
}

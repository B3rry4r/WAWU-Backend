import { Unreadable, type CleanPlan, type VideoSource } from './types';
import { planMp4 } from './clean-mp4';
import { planWebm } from './clean-webm';

/** The stored types the cleaners know, by the extension the Hub stores them under. */
export const CLEANABLE_EXTENSIONS = ['mp4', 'mov', 'webm'] as const;

export function cleanableKind(key: string): 'mp4' | 'webm' | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(key)?.[1]?.toLowerCase();
  if (ext === 'mp4' || ext === 'mov') return 'mp4';
  if (ext === 'webm') return 'webm';
  return null;
}

/**
 * The plan for one stored video, or null when the file is not a type the
 * cleaners know. Throws `Unreadable` for a file of a known type that cannot be
 * read; the caller leaves that file as it is.
 */
export async function planClean(
  key: string,
  source: VideoSource,
): Promise<CleanPlan | null> {
  const kind = cleanableKind(key);
  if (!kind) return null;
  if (source.length < 16) throw new Unreadable('too short');
  return kind === 'mp4' ? planMp4(source) : planWebm(source);
}

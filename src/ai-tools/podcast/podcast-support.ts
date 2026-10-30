import type { ProviderCopy } from '../voice/ai-voice-provider';

/**
 * Small, pure helpers for the Podcast maker (AITOOLS-13): how a followed podcast's provider project is kept on its
 * row, and the copy that is deleted when the job ends. No I/O.
 */

/** What `providerRef` holds while the Hub follows a podcast: `castrun:<project id>`. */
export const CAST_PREFIX = 'castrun:';

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function castRef(projectId: string): string {
  return `${CAST_PREFIX}${projectId}`;
}

/** The project id a followed job's row holds, or null when it holds none (not started, ended, or another kind of note). */
export function parseCastRef(marker: string | null): string | null {
  if (!marker || !marker.startsWith(CAST_PREFIX)) return null;
  const id = marker.slice(CAST_PREFIX.length);
  return ID.test(id) ? id : null;
}

/** The provider copy (the project) a podcast leaves behind when its job ends. */
export function copyOfCast(projectId: string): ProviderCopy {
  return { kind: 'podcast', id: projectId };
}

/** The note a job row takes when a followed podcast ends: `podcast:<project id>`, to be deleted at the provider. Undefined for a row that holds no cast note. */
export function endMarkerOfCast(marker: string | null): string | undefined {
  const id = parseCastRef(marker);
  return id ? `podcast:${id}` : undefined;
}

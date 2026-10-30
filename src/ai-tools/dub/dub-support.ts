import type { ProviderCopy } from '../voice/ai-voice-provider';
import { endMarkerOfFlow } from '../flow/flow-support';

/**
 * Small, pure helpers for Dubbing (AITOOLS-05): how a followed job's provider
 * ids are kept on its row, and the list of languages it offers. No I/O.
 */

/** What `providerRef` holds while the Hub follows a dub: `dubrun:<project id>:<language id>`. */
export const FOLLOW_PREFIX = 'dubrun:';

export interface FollowRef {
  projectId: string;
  languageId: string;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function followRef(projectId: string, languageId: string): string {
  return `${FOLLOW_PREFIX}${projectId}:${languageId}`;
}

/** The ids a followed job's row holds, or null when it holds none (not started, ended, or another kind of note). */
export function parseFollowRef(marker: string | null): FollowRef | null {
  if (!marker || !marker.startsWith(FOLLOW_PREFIX)) return null;
  const [projectId, languageId, ...rest] = marker
    .slice(FOLLOW_PREFIX.length)
    .split(':');
  if (
    rest.length > 0 ||
    !ID.test(projectId ?? '') ||
    !ID.test(languageId ?? '')
  )
    return null;
  return { projectId, languageId };
}

/** The provider copy (the project) a followed job leaves behind when it ends. */
export function copyOfFollow(ref: FollowRef): ProviderCopy {
  return { kind: 'dub', id: ref.projectId };
}

/** The note a job row takes when a followed job ends: `dub:<project id>`, to be deleted at the provider. Undefined for a row that holds no follow note. */
export function endMarkerOf(marker: string | null): string | undefined {
  const ref = parseFollowRef(marker);
  // AITOOLS-09 and -10: a followed picture or video leaves the person's assets to delete.
  return ref ? `dub:${ref.projectId}` : endMarkerOfFlow(marker);
}

export interface DubLanguage {
  /** The tag as the list spells it (`yo`, `pt-BR`). */
  code: string;
  name: string;
}

/** The languages the setting lists: one line each, a code, a space, the name. A bad line is skipped (the settings check refuses one before it is stored). */
export function dubLanguagesOf(lines: readonly string[]): DubLanguage[] {
  const out: DubLanguage[] = [];
  for (const line of lines) {
    const m = /^([a-z]{2,3}(?:-[A-Za-z]{2,4})?) (\S.*)$/.exec(line.trim());
    if (m) out.push({ code: m[1], name: m[2] });
  }
  return out;
}

/** The list's own entry for a tag a person sent, matched without regard to case; null when it is not on the list. */
export function findDubLanguage(
  list: readonly DubLanguage[],
  tag: string,
): DubLanguage | null {
  const want = tag.trim().toLowerCase();
  return list.find((l) => l.code.toLowerCase() === want) ?? null;
}

import type { ProviderCopy } from '../voice/ai-voice-provider';

/**
 * Small, pure helpers for the Studio picture and video tools (AITOOLS-09,
 * AITOOLS-10): how a followed generation's provider ids are kept on its row,
 * and the provider copy (the person's photo or speech, sent up as assets) that
 * is deleted when the job ends. No I/O.
 */

/** What `providerRef` holds while the Hub follows a generation: `genrun:<image|video>:<generation id>[:<asset id>+<asset id>]`. */
export const FLOW_PREFIX = 'genrun:';

export type FlowKind = 'image' | 'video';

export interface FlowRef {
  kind: FlowKind;
  generationId: string;
  /** The assets the Hub sent up for this run (the person's photo, their speech); none for a picture or a clip from words alone. */
  assetIds: string[];
}

/** The shape of an id the provider gives: kept to this before it is put in a path or a note. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function flowRef(
  kind: FlowKind,
  generationId: string,
  assetIds: readonly string[],
): string {
  return `${FLOW_PREFIX}${kind}:${generationId}${
    assetIds.length > 0 ? `:${assetIds.join('+')}` : ''
  }`;
}

/** The ids a followed job's row holds, or null when it holds none (not started, ended, or another kind of note). */
export function parseFlowRef(marker: string | null): FlowRef | null {
  if (!marker || !marker.startsWith(FLOW_PREFIX)) return null;
  const [kind, generationId, assets, ...rest] = marker
    .slice(FLOW_PREFIX.length)
    .split(':');
  if (
    rest.length > 0 ||
    (kind !== 'image' && kind !== 'video') ||
    !ID.test(generationId ?? '')
  )
    return null;
  const assetIds = assets === undefined ? [] : assets.split('+');
  if (assetIds.length > 4 || !assetIds.every((a) => ID.test(a))) return null;
  return { kind, generationId, assetIds };
}

/** The provider copy (the person's assets) a run leaves behind, or null when it sent none. */
export function assetCopyOf(assetIds: readonly string[]): ProviderCopy | null {
  return assetIds.length > 0 ? { kind: 'asset', id: assetIds.join('+') } : null;
}

export function copyOfFlow(ref: FlowRef): ProviderCopy | null {
  return assetCopyOf(ref.assetIds);
}

/** The asset ids an `asset` copy holds. */
export function assetIdsOf(copy: ProviderCopy): string[] {
  return copy.id.split('+').filter((id) => ID.test(id));
}

/** The note a job row takes when a followed run ends: `asset:<ids>`, to be deleted at the provider. Undefined for a row that holds no flow note or sent no asset. */
export function endMarkerOfFlow(marker: string | null): string | undefined {
  const ref = parseFlowRef(marker);
  const copy = ref ? copyOfFlow(ref) : null;
  return copy ? `asset:${copy.id}` : undefined;
}

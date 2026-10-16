import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';

/**
 * Nuvion's hosted selfie (task NUV-03, R-39), from Nuvion's own dashboard
 * code and not its public docs (the lead's scratchpad
 * `nuvion/SANDBOX-FINDINGS.md`, item 4), so none of it is sandbox-confirmed:
 *
 * - start: `POST /kyc/liveness/sessions` with `{ redirect_url }`; the
 *   answer's `data.url` is the hosted page to open and `data.query_id` the
 *   session. The dashboard sends no `entity_id`; whether an API key can
 *   start one for a CHILD entity (`entity_id` in the body) is the open
 *   question the (key) check answers. Until then the selfie is off
 *   (`NUVION_HOSTED_LIVENESS`); only an answer that says the API is not
 *   there for us (`LIVENESS_API_UNAVAILABLE_TYPES`) turns it off, for
 *   everyone.
 * - result: `GET /kyc/liveness/sessions/{query_id}` answers
 *   `capture_status` (`pending`, `completed`, `image-error`,
 *   `internal-error`), `verification_status` (`pending`, `approved`,
 *   `not-approved`), `initiated_at` and `capture_url` (to resume). There is
 *   no webhook for it.
 * - link: the dashboard saves the session on the entity as
 *   `meta.liveness_check_id` (`PATCH /individual-entities/{id}`), which is
 *   how the review sees it.
 *
 * No image, face or score is read or kept: only the two status words.
 * This file is NUV-03's alone.
 */

/**
 * PROVISIONAL(NUVION-LIVENESS-WINDOW, owner=YOU, why=Nuvion's docs do not say how long a hosted selfie session lives; Nuvion's own dashboard treats one still pending after 30 minutes as expired and starts a new one)
 *
 * How long a session may stay pending before a new one is started instead.
 */
export const NUVION_LIVENESS_SESSION_MS = 30 * 60_000;

/**
 * What a refusal of a session start means (task NUV-03 round 2, D2). The
 * hosted selfie is a step the whole server runs or does not, so only an
 * answer about the API itself may turn it off, and then for everyone. An
 * answer about one person's request or entity never does: it is that
 * person's, they wait or retry, and the step stays required of them (a
 * refusal that let a person skip the selfie would be a way past it).
 *
 * These are the only answers that say the API is not there for us at all,
 * from Nuvion's errors page (the lead's scratchpad `nuvion/docs/errors.md`):
 * - `error_endpoint_not_found` (404, "API endpoint does not exist"): the
 *   path does not exist, whoever asks;
 * - `error_auth_permission_denied` (403, "Insufficient permissions for this
 *   action") and `error_auth_elevated_permission_required` (403, "Action
 *   requires administrator permissions"): our key may not use it, the same
 *   for every person.
 * Everything else is about the request or the entity: `error_validation_*`
 * (the body, such as a return address Nuvion will not take), `error_kyc_*`
 * and `error_entity_*` (this person's review), `error_resource_not_found` (a
 * record, not the path), `error_account_*`, a rate limit, a lost answer, a
 * 5xx. No document says an answer of "a child entity cannot start one"; if
 * the sandbox shows one, its type is one more line here (the (key) check).
 */
export const LIVENESS_API_UNAVAILABLE_TYPES: readonly string[] = [
  'error_endpoint_not_found',
  'error_auth_permission_denied',
  'error_auth_elevated_permission_required',
];

/** Who a refused session start is about. */
export type LivenessRefusal =
  /** The answer was lost or unreadable: a session may exist; nothing is turned off. */
  | 'lost'
  /** Nuvion says the API is not available to us at all: off for everyone, loudly. */
  | 'api_unavailable'
  /** This adapter's own "not in use" (the switch is off or already memoed): nothing new. */
  | 'already_off'
  /** Nuvion refused the body and an address was sent: it is that person's address. */
  | 'return_address'
  /** About this person's request or entity: they wait or retry; the step stays. */
  | 'this_person'
  /** Not a provider failure at all: the caller rethrows it. */
  | 'other';

export function livenessRefusalOf(
  e: unknown,
  sentReturnAddress: boolean,
): LivenessRefusal {
  if (!(e instanceof WalletProviderError)) return 'other';
  if (e.recordMayExist) return 'lost';
  if (e.kind === 'not_supported') return 'already_off';
  const type = (e as { nuvionType?: unknown }).nuvionType;
  if (
    typeof type === 'string' &&
    LIVENESS_API_UNAVAILABLE_TYPES.includes(type)
  ) {
    return 'api_unavailable';
  }
  if (e.kind === 'validation' && sentReturnAddress) return 'return_address';
  return 'this_person';
}

const START: NuvionOp = { name: 'start liveness session', call: 'write' };
const READ: NuvionOp = { name: 'read liveness session', call: 'read' };
const LINK: NuvionOp = { name: 'link liveness session', call: 'write' };

/** A Nuvion id we put in a path or a query: nothing else. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOf(v: unknown): string | null {
  return typeof v === 'string' && ID.test(v) ? v : null;
}

function word(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const w = v.trim().toLowerCase();
  return /^[a-z][a-z0-9_ -]{0,39}$/.test(w) ? w : null;
}

/** An https address with no credentials, as the hosted page's address. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2_000) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** A session Nuvion started: its id and the hosted page to open. */
export interface NuvionLivenessStarted {
  sessionId: string;
  url: string;
}

/** Where a session stands, in our words. */
export interface NuvionLivenessCheck {
  /** `passed` only on an approval after a finished capture. */
  state: 'pending' | 'passed' | 'not_passed';
  /** Nuvion's own words, for notes (never a face or a score). */
  captureStatus: string | null;
  verificationStatus: string | null;
  /** Unix ms, or null when Nuvion gave none. */
  initiatedAt: number | null;
  /** Where to resume a capture that has not finished; https or null. */
  captureUrl: string | null;
}

/** `POST /kyc/liveness/sessions` for one child entity. */
export async function startLivenessCalls(
  client: NuvionClient,
  entityId: string,
  redirectUrl: string | null,
): Promise<NuvionLivenessStarted> {
  const id = idOf(entityId);
  if (id === null) throw refused(START.name, 'not an entity id');
  const body: Record<string, unknown> = { entity_id: id };
  if (redirectUrl !== null) body.redirect_url = redirectUrl;
  const answer = await client.post(START, '/kyc/liveness/sessions', body);
  const data = isRecord(answer.data) ? answer.data : null;
  const sessionId = idOf(data?.query_id);
  const url = httpsUrl(data?.url);
  if (sessionId === null || url === null) {
    throw new NuvionError({
      kind: 'not_confirmed',
      operation: START.name,
      httpStatus: answer.httpStatus,
      messages: ['the answer carries no session and page'],
      requestId: answer.requestId,
      recordMayExist: true,
    });
  }
  return { sessionId, url };
}

/** `GET /kyc/liveness/sessions/{id}`, the child's `entity_id` as the query. */
export async function readLivenessCalls(
  client: NuvionClient,
  sessionId: string,
  entityId: string | null,
): Promise<NuvionLivenessCheck> {
  const id = idOf(sessionId);
  if (id === null) throw refused(READ.name, 'not a session id');
  const entity = entityId === null ? null : idOf(entityId);
  if (entityId !== null && entity === null) {
    throw refused(READ.name, 'not an entity id');
  }
  const answer = await client.get(
    READ,
    `/kyc/liveness/sessions/${encodeURIComponent(id)}`,
    entity === null ? undefined : { entity_id: entity },
  );
  const data = isRecord(answer.data) ? answer.data : null;
  const capture = word(data?.capture_status);
  const verification = word(data?.verification_status);
  if (data === null || (capture === null && verification === null)) {
    throw new NuvionError({
      kind: 'bad_response',
      operation: READ.name,
      httpStatus: answer.httpStatus,
      messages: ['the answer carries no session status'],
      requestId: answer.requestId,
    });
  }
  const initiated =
    typeof data.initiated_at === 'number' &&
    Number.isFinite(data.initiated_at) &&
    data.initiated_at > 0
      ? data.initiated_at
      : null;
  // The dashboard's own reading: approved after a finished capture passes;
  // not approved, or a capture that errored, does not.
  let state: NuvionLivenessCheck['state'] = 'pending';
  if (capture === 'completed' && verification === 'approved') {
    state = 'passed';
  } else if (
    verification === 'not-approved' ||
    capture === 'image-error' ||
    capture === 'internal-error'
  ) {
    state = 'not_passed';
  }
  return {
    state,
    captureStatus: capture,
    verificationStatus: verification,
    initiatedAt: initiated,
    captureUrl: httpsUrl(data.capture_url),
  };
}

/**
 * Saves the session on the entity (`meta.liveness_check_id`), the way
 * Nuvion's dashboard does for an individual. Sent again with the same id it
 * changes nothing, so a lost answer is simply repeated.
 */
export async function linkLivenessCalls(
  client: NuvionClient,
  entityId: string,
  sessionId: string,
): Promise<void> {
  const entity = idOf(entityId);
  const session = idOf(sessionId);
  if (entity === null || session === null) {
    throw refused(LINK.name, 'not an id');
  }
  await client.patch(
    LINK,
    `/individual-entities/${encodeURIComponent(entity)}`,
    { entity_id: entity, meta: { liveness_check_id: session } },
  );
}

function refused(operation: string, why: string): NuvionError {
  return new NuvionError({
    kind: 'validation',
    operation,
    messages: [why],
    recordMayExist: false,
  });
}

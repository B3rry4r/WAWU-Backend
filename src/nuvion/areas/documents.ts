import { Logger } from '@nestjs/common';
import type {
  ProviderKycState,
  ProviderKycSubmission,
  ProviderLivenessResult,
  ProviderLivenessSession,
  ProviderSelfieResult,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';
import { readNuvionEntity } from './opening';
import {
  linkLivenessCalls,
  type NuvionLivenessCheck,
  type NuvionLivenessStarted,
  readLivenessCalls,
  startLivenessCalls,
} from './liveness';
import { rejectNotSupported } from './not-supported';

const AREA = 'documents (NUV-03)';

/**
 * The ID document, the proof of address and the hosted selfie, then the
 * onboarding submission for Nuvion's review (task NUV-03, R-42: ID document
 * and proof of address at opening; R-39: Nuvion's hosted selfie if its API
 * can start one, else no selfie). The lead's scratchpad
 * `nuvion/docs/api-reference__entities.md` (`POST /documents`,
 * `POST /onboarding-submissions`, `GET /entities/{id}`) and
 * `SANDBOX-FINDINGS.md` item 4 (`POST /kyc/liveness/sessions`, in
 * liveness.ts). This file is NUV-03's alone.
 *
 * - `uploadDocument`: ONE `POST /documents` per document, a write: the
 *   entity (`entity_id`, the child's), the `key` (`identity` or
 *   `proof_of_address`), the `file` in base64 and, for an ID with two
 *   sides, its `file_back` in the same call (Nuvion's call takes both; WAWU
 *   keeps no copy to hold a front until a back arrives), the MIME type, and
 *   `link_to_identity.person_id`. The bytes are base64 for the one request
 *   and then dropped: nothing here stores or logs them.
 * - `readDocuments`: the entity read back (`GET /entities/{id}`), whose
 *   `documents` list is how an upload whose answer was lost is found, and
 *   whose `entity.status` says whether the submission reached Nuvion.
 * - `submitOnboarding`: `POST /onboarding-submissions` for the entity, a
 *   write.
 * - The hosted selfie (`startLivenessSession`, `getLivenessResult`,
 *   `readLiveness`, `linkLiveness`) is on only with `NUVION_HOSTED_LIVENESS=on`
 *   and answers `not_supported` (nothing sent) otherwise. Only an answer
 *   that says Nuvion's API is not available to us (not one about a person)
 *   turns it off, for everyone and for an hour (`noteLivenessRefused`), so
 *   the opening goes on without a selfie.
 * - `matchSelfie` stays `not_supported`: Nuvion matches no selfie against a
 *   BVN photo (capabilities.selfieMatch is false).
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionDocumentsMethods = Pick<
  WalletProvider,
  'matchSelfie' | 'startLivenessSession' | 'getLivenessResult' | 'submitKyc'
>;

/** The two documents Nuvion needs of a person (`POST /documents` `key`). */
export const NUVION_DOCUMENT_KINDS = ['identity', 'proof_of_address'] as const;
export type NuvionDocumentKind = (typeof NUVION_DOCUMENT_KINDS)[number];

/** Nuvion's documented limit for one file (api-reference__entities.md). */
export const NUVION_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The file types Nuvion accepts (PDF, JPG, JPEG, PNG), as MIME types. */
export const NUVION_DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;
export type NuvionDocumentType = (typeof NUVION_DOCUMENT_TYPES)[number];

/**
 * PROVISIONAL(NUVION-LIVENESS-MEMO, owner=YOU, why=Nuvion's docs do not list the hosted selfie, so whether an API key may start one for a child entity is only known once the sandbox key works; one hour is how long a refusal is believed before asking again)
 *
 * How long after Nuvion says its hosted selfie API is not available to us
 * (an answer in `LIVENESS_API_UNAVAILABLE_TYPES`) the selfie is treated as
 * unavailable for everyone (the opening goes on without it). It is the
 * server's memory only, not a row of one person.
 */
export const NUVION_LIVENESS_REFUSAL_MEMO_MS = 60 * 60_000;

const UPLOAD: NuvionOp = { name: 'upload document', call: 'write' };
const SUBMIT: NuvionOp = { name: 'submit for onboarding', call: 'write' };
const READ_ENTITY: NuvionOp = { name: 'read entity documents', call: 'read' };

/** What one upload sends. The bytes are only ever in memory. */
export interface NuvionDocumentUpload {
  /** The child entity. */
  entityId: string;
  /** The entity's person (`person.id`): the document is linked to it. */
  personId: string;
  kind: NuvionDocumentKind;
  front: Buffer;
  /** The back of an ID with two sides, same type as the front. */
  back: Buffer | null;
  mimeType: NuvionDocumentType;
}

/** What Nuvion answered for an accepted upload. */
export interface NuvionDocumentReceipt {
  documentId: string;
  /** Unix ms, or null when Nuvion gave none. */
  created: number | null;
}

/** One of an entity's documents, as `GET /entities/{id}` lists it. */
export interface NuvionEntityDocument {
  id: string;
  key: string;
  /** Unix ms, or null. */
  created: number | null;
}

/** An entity read back for the documents flow. */
export interface NuvionEntityDocuments {
  /** Nuvion's review word (`incomplete`, `pending`, ...). */
  status: string;
  personId: string | null;
  documents: NuvionEntityDocument[];
}

/** Nuvion ids we put in a body, a path or a query: nothing else. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOf(v: unknown): string | null {
  return typeof v === 'string' && ID.test(v) ? v : null;
}

function refusedBeforeSending(operation: string, why: string): NuvionError {
  return new NuvionError({
    kind: 'validation',
    operation,
    messages: [why],
    recordMayExist: false,
  });
}

export class NuvionDocumentsArea implements NuvionDocumentsMethods {
  private livenessRefusedAt: number | null = null;
  /** The clock; a spec may replace it. */
  now: () => number = () => Date.now();

  constructor(readonly client: NuvionClient) {
    if (
      client.settings.hostedLiveness === true &&
      (client.settings.livenessRedirectOrigins ?? []).length === 0
    ) {
      // An empty list allows no return address (D2): a person can start the
      // selfie but cannot be sent back to the app or the website.
      new Logger('NuvionDocuments').warn(
        'NUVION_HOSTED_LIVENESS is on and NUVION_LIVENESS_REDIRECT_ORIGINS is empty: no return address is allowed, so the selfie page cannot send anyone back',
      );
    }
  }

  /**
   * Whether the hosted selfie is a step of opening now, for everyone:
   * switched on, and Nuvion has not said within the last hour that its API
   * is not available to us. The adapter's `capabilities.hostedLiveness`
   * reads this.
   */
  get hostedLiveness(): boolean {
    if (this.client.settings.hostedLiveness !== true) return false;
    const at = this.livenessRefusedAt;
    return at === null || this.now() - at >= NUVION_LIVENESS_REFUSAL_MEMO_MS;
  }

  /** Where the selfie page may return to (`origin` or `origin/path-prefix`); empty allows no address. */
  get livenessRedirectOrigins(): readonly string[] {
    return this.client.settings.livenessRedirectOrigins ?? [];
  }

  /**
   * Nuvion said its hosted selfie API is not available to us (an answer in
   * `LIVENESS_API_UNAVAILABLE_TYPES`, never one about a person): the selfie
   * is off for everyone on this server for an hour.
   */
  noteLivenessRefused(): void {
    this.livenessRefusedAt = this.now();
  }

  matchSelfie(): Promise<ProviderSelfieResult> {
    return rejectNotSupported('match selfie', AREA);
  }

  // -------------------------------------------------------------------------
  // The documents
  // -------------------------------------------------------------------------

  /**
   * `POST /documents`: one document, with its back when it has one. A write:
   * a lost answer is `outcome_unknown` and the caller reads the entity's
   * documents before sending again.
   */
  async uploadDocument(
    input: NuvionDocumentUpload,
  ): Promise<NuvionDocumentReceipt> {
    const entityId = idOf(input.entityId);
    const personId = idOf(input.personId);
    if (entityId === null || personId === null) {
      throw refusedBeforeSending(UPLOAD.name, 'not an entity or person id');
    }
    if (input.front.length === 0) {
      throw refusedBeforeSending(UPLOAD.name, 'the file is empty');
    }
    const body: Record<string, unknown> = {
      entity_id: entityId,
      key: input.kind,
      description:
        input.kind === 'identity' ? 'Identity document' : 'Proof of address',
      file: input.front.toString('base64'),
      meta: { file_type: input.mimeType },
      link_to_identity: { person_id: personId },
    };
    if (input.back !== null) body.file_back = input.back.toString('base64');
    const answer = await this.client.post(UPLOAD, '/documents', body);
    const data = isRecord(answer.data) ? answer.data : null;
    const doc = isRecord(data?.document) ? data.document : null;
    const documentId = idOf(doc?.id);
    // The answer must name the document we sent: anything else is not proof
    // of what Nuvion holds, and the upload may exist (reconciled by a read).
    if (
      documentId === null ||
      (doc?.key !== undefined && doc.key !== input.kind) ||
      (doc?.entity_id !== undefined && doc.entity_id !== entityId)
    ) {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: UPLOAD.name,
        httpStatus: answer.httpStatus,
        messages: ['the answer does not name the document sent'],
        requestId: answer.requestId,
        recordMayExist: true,
      });
    }
    return {
      documentId,
      created:
        typeof doc?.created === 'number' && doc.created > 0
          ? doc.created
          : null,
    };
  }

  /** `GET /entities/{id}`: the review word and the documents Nuvion holds. */
  async readDocuments(entityId: string): Promise<NuvionEntityDocuments> {
    const id = idOf(entityId);
    if (id === null) {
      throw refusedBeforeSending(READ_ENTITY.name, 'not an entity id');
    }
    const answer = await this.client.get(
      READ_ENTITY,
      `/entities/${encodeURIComponent(id)}`,
      { entity_id: id },
    );
    const reading = readNuvionEntity(answer.data);
    if (reading === null || reading.entityId !== id) {
      throw new NuvionError({
        kind: 'bad_response',
        operation: READ_ENTITY.name,
        httpStatus: answer.httpStatus,
        messages: ['the answer does not name the entity asked for'],
        requestId: answer.requestId,
      });
    }
    const raw = isRecord(answer.data) ? answer.data.documents : undefined;
    const documents: NuvionEntityDocument[] = [];
    for (const d of Array.isArray(raw) ? raw : []) {
      if (!isRecord(d)) continue;
      const docId = idOf(d.id);
      if (docId === null || typeof d.key !== 'string') continue;
      documents.push({
        id: docId,
        key: d.key,
        created:
          typeof d.created === 'number' && d.created > 0 ? d.created : null,
      });
    }
    return { status: reading.status, personId: reading.personId, documents };
  }

  // -------------------------------------------------------------------------
  // The submission
  // -------------------------------------------------------------------------

  /**
   * `POST /onboarding-submissions`: sends the entity for Nuvion's review.
   * A write: the answer carries the entity with its new status, and an
   * answer that does not is not proof of what Nuvion holds.
   */
  async submitOnboarding(entityId: string): Promise<{ status: string }> {
    const id = idOf(entityId);
    if (id === null)
      throw refusedBeforeSending(SUBMIT.name, 'not an entity id');
    const answer = await this.client.post(SUBMIT, '/onboarding-submissions', {
      entity_id: id,
    });
    const reading = readNuvionEntity(answer.data);
    if (reading === null || reading.entityId !== id) {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: SUBMIT.name,
        httpStatus: answer.httpStatus,
        messages: ['the answer does not name the entity submitted'],
        requestId: answer.requestId,
        recordMayExist: true,
      });
    }
    return { status: reading.status };
  }

  /**
   * The seam's `submitKyc`: the entity already holds the person's details
   * (NUV-02), so only `customerId` (the entity) is used and the rest of the
   * submission is not used.
   */
  async submitKyc(input: ProviderKycSubmission): Promise<ProviderKycState> {
    const sent = await this.submitOnboarding(input.customerId);
    const state: ProviderKycState['state'] =
      sent.status === 'approved'
        ? 'approved'
        : sent.status === 'rejected'
          ? 'rejected'
          : sent.status === 'pending'
            ? 'submitted'
            : 'pending';
    return { customerId: input.customerId, state };
  }

  // -------------------------------------------------------------------------
  // The hosted selfie
  // -------------------------------------------------------------------------

  /** The seam's call: a session for the entity `customerId`, back to `returnUrl`. */
  async startLivenessSession(input: {
    customerId: string;
    returnUrl?: string | null;
  }): Promise<ProviderLivenessSession> {
    if (!this.hostedLiveness) {
      return rejectNotSupported('start liveness session', AREA);
    }
    const started = await this.startLiveness(
      input.customerId,
      input.returnUrl ?? null,
    );
    return {
      sessionId: started.sessionId,
      url: started.url,
      expiresAt: null,
    };
  }

  /** The seam's call; the session alone (use `readLiveness` for a child's session). */
  async getLivenessResult(sessionId: string): Promise<ProviderLivenessResult> {
    if (!this.hostedLiveness) {
      return rejectNotSupported('get liveness result', AREA);
    }
    const check = await this.readLiveness(sessionId, null);
    return {
      state:
        check.state === 'passed'
          ? 'passed'
          : check.state === 'not_passed'
            ? 'failed'
            : 'pending',
      confidence: null,
    };
  }

  /** Starts a session for a child entity. Off, nothing is sent. */
  startLiveness(
    entityId: string,
    redirectUrl: string | null,
  ): Promise<NuvionLivenessStarted> {
    if (!this.hostedLiveness) {
      return rejectNotSupported('start liveness session', AREA);
    }
    return startLivenessCalls(this.client, entityId, redirectUrl);
  }

  /** Where one session stands. Off, nothing is sent. */
  readLiveness(
    sessionId: string,
    entityId: string | null,
  ): Promise<NuvionLivenessCheck> {
    if (!this.hostedLiveness) {
      return rejectNotSupported('get liveness result', AREA);
    }
    return readLivenessCalls(this.client, sessionId, entityId);
  }

  /** Saves the session on the entity (`meta.liveness_check_id`). */
  linkLiveness(entityId: string, sessionId: string): Promise<void> {
    if (!this.hostedLiveness) {
      return rejectNotSupported('link liveness session', AREA);
    }
    return linkLivenessCalls(this.client, entityId, sessionId);
  }
}

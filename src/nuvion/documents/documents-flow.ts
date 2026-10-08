import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { NO_WALLET_MESSAGE } from '../../money/gate/wallet-gate';
import { MoneyError } from '../../money/money-error';
import {
  isDecision,
  openingStateForStage,
  REVIEW_OPENING_STATES,
  type ReviewRecord,
  reviewStageOf,
} from '../../money/opening/review-stage';
import {
  UNDER_REVIEW_MESSAGE,
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../wallet-provider/wallet-provider-error';
import {
  NUVION_DOCUMENT_KINDS,
  NUVION_DOCUMENT_MAX_BYTES,
  NUVION_DOCUMENT_TYPES,
  type NuvionDocumentKind,
  type NuvionDocumentType,
} from '../areas/documents';
import { NUVION_LIVENESS_SESSION_MS } from '../areas/liveness';
import type { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { DocumentError } from './document-errors';
import { MSG } from './documents-config';
import type {
  DocumentStateView,
  DocumentStepView,
  IdentityDocumentsView,
  IdentityDocumentView,
  IdentityLivenessView,
  LivenessStateView,
} from './documents-view.type';

/** Our clock and Nuvion's may differ by this much (the opening uses the same). */
const CLOCK_SKEW_MS = 5 * 60_000;
/** A call's own time beyond Nuvion's money timeout (serialising 20 MB, the database). */
const IN_FLIGHT_MARGIN_MS = 10_000;
/** A session just claimed is not claimed again for this long. */
const LIVENESS_CLAIM_MS = 60_000;
/** A submission Nuvion refused is not sent again for this long (a changed document lifts it). */
const SUBMIT_REFUSED_BACKOFF_MS = 60_000;
/** The words Nuvion uses for a check that did not pass. */
const NOT_PASSED = new Set([
  'rejected',
  'failed',
  'declined',
  'not-approved',
  'not_approved',
  'invalid',
  'unverified',
]);

const ENTITY_SELECT = {
  wawuUserId: true,
  entityId: true,
  personId: true,
  status: true,
  decidedAt: true,
  correctedAt: true,
  bvnStatus: true,
  ninStatus: true,
  documentStatus: true,
  addressProofStatus: true,
  rejectionReasons: true,
} as const;

/** NuvionEntity's columns this flow reads. */
export interface FlowEntity extends ReviewRecord {
  wawuUserId: string;
  entityId: string | null;
  personId: string | null;
}

/** One upload, after the route has read and checked the files. */
export interface FlowUpload {
  kind: NuvionDocumentKind;
  front: Buffer;
  back: Buffer | null;
  mimeType: NuvionDocumentType;
}

/** The SHA-256 (hex) of what one upload sends: to spot the same file sent twice. */
export function fingerprintOf(front: Buffer, back: Buffer | null): string {
  const h = createHash('sha256');
  h.update('front:');
  h.update(front);
  h.update('\0back:');
  if (back !== null) h.update(back);
  return h.digest('hex');
}

function kindOfError(e: unknown): string {
  return e instanceof WalletProviderError
    ? e.kind
    : ((e as Error).name ?? 'Error');
}

function nuvionTypeOf(e: unknown): string | null {
  const t = (e as { nuvionType?: unknown } | null)?.nuvionType;
  return typeof t === 'string' ? t : null;
}

/** Nuvion refused the request itself: nothing was made, and sending it again changes nothing. */
const REFUSAL_KINDS: readonly WalletProviderErrorKind[] = [
  'validation',
  'refused',
  'identity_refused',
  'not_found',
  'wallet_inactive',
];

/**
 * The ID document, the proof of address and the hosted selfie, then the one
 * submission for Nuvion's review (task NUV-03, R-42, R-39). Everything the
 * routes and the `entities.updated` handler do is here, over WAWU's tables
 * (NuvionEntity, NuvionDocument, NuvionOnboarding) and the Nuvion adapter's
 * documents area, so the two never disagree.
 *
 * What it keeps, and does not:
 * - a file goes to Nuvion in one call and nowhere else. Kept: the kind, the
 *   sides sent, the state, Nuvion's document id, the time, and a SHA-256
 *   fingerprint of the bytes (to forward the same file once). Never the
 *   file, a copy, a name, or a number read off it.
 * - Nuvion's answer is the proof: a document is `uploaded` only when its
 *   answer names it. A call whose answer was lost is `unknown`; it is
 *   looked for on the entity's own document list before anything is sent
 *   again, and not at all before the money timeout plus the resend safety
 *   has passed (the file is not kept, so only the person can send it again).
 * - the opening is submitted once: the claim (`submitRequestedAt`) is taken
 *   by a conditional update before `POST /onboarding-submissions` is sent,
 *   so two uploads at once, a replayed delivery and a retry send one. A
 *   submission whose answer was lost is looked for (the entity no longer
 *   `incomplete`) before it is sent again.
 * - the hosted selfie, when in use, must have passed and be saved on the
 *   entity before the submission; when Nuvion will not start a session for
 *   a child entity the opening goes on without one (R-39).
 *
 * A disagreement between Nuvion and our record is never fixed silently:
 * an entity id another row already names, or a document id another row
 * holds, stops the flow for that person (logged without any number).
 */
export class DocumentsFlow {
  private readonly logger = new Logger('NuvionDocuments');

  constructor(
    private readonly prisma: PrismaService,
    private readonly nuvion: NuvionWalletProvider,
  ) {}

  private get area() {
    return this.nuvion.documents;
  }

  /** The https origins the selfie page may return to; empty means any https address. */
  get livenessRedirectOrigins(): readonly string[] {
    return this.area.livenessRedirectOrigins;
  }

  private get resendAfterMs(): number {
    const t = this.nuvion.timings;
    return t.moneyTimeoutMs + t.resendSafetyMs;
  }

  private get inFlightMs(): number {
    return this.nuvion.timings.moneyTimeoutMs + IN_FLIGHT_MARGIN_MS;
  }

  async dbNow(): Promise<Date> {
    const [r] = await this.prisma.$queryRaw<Array<{ now: Date | string }>>`
      SELECT now() AS "now"
    `;
    return new Date(r.now);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The person's entity row, or `wallet_not_open` when no opening was started. */
  async requireEntity(
    wawuUserId: string,
  ): Promise<FlowEntity & { entityId: string }> {
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { wawuUserId },
      select: ENTITY_SELECT,
    });
    if (!entity?.entityId) {
      throw new MoneyError('wallet_not_open', NO_WALLET_MESSAGE);
    }
    return entity as FlowEntity & { entityId: string };
  }

  private hasWallet(wawuUserId: string): Promise<boolean> {
    return this.prisma.fintavaWallet
      .findUnique({ where: { wawuUserId }, select: { wawuUserId: true } })
      .then((r) => r !== null);
  }

  /** Both documents, what is still needed, and whether uploads are open. */
  async view(wawuUserId: string): Promise<IdentityDocumentsView> {
    await this.requireEntity(wawuUserId);
    // A ready opening is sent once, also when nothing was uploaded just now
    // (a correction, a webhook that never came, an answer that was lost).
    await this.advance(wawuUserId).catch((e: unknown) => {
      this.logger.warn(
        `documents: the submission could not be advanced (${kindOfError(e)})`,
      );
    });
    return this.snapshot(wawuUserId);
  }

  /** The documents view as it stands, sending nothing. */
  async snapshot(wawuUserId: string): Promise<IdentityDocumentsView> {
    const { entityId } = await this.requireEntity(wawuUserId);
    const [entity, rows, onboarding, wallet] = await Promise.all([
      this.prisma.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId },
        select: ENTITY_SELECT,
      }),
      this.prisma.nuvionDocument.findMany({ where: { wawuUserId, entityId } }),
      this.prisma.nuvionOnboarding.findUnique({ where: { wawuUserId } }),
      this.hasWallet(wawuUserId),
    ]);
    const stage = reviewStageOf(entity);
    const documents: IdentityDocumentView[] = NUVION_DOCUMENT_KINDS.map(
      (kind) => {
        const row = rows.find((r) => r.kind === kind);
        const state = this.documentState(kind, row, entity);
        return {
          kind,
          state,
          sides:
            row && row.state !== 'failed'
              ? row.sides.filter(
                  (s): s is 'front' | 'back' => s === 'front' || s === 'back',
                )
              : [],
          uploadedAt:
            state === 'uploaded' || state === 'needs_new'
              ? (row?.uploadedAt?.toISOString() ?? null)
              : null,
        };
      },
    );
    const required = this.selfieRequired(onboarding);
    const selfieDone = this.selfieDone(onboarding);
    const submitted = this.submissionCurrent(onboarding, entity);
    const waitingFor: DocumentStepView[] = [];
    for (const d of documents) {
      if (d.state !== 'uploaded') waitingFor.push(d.kind);
    }
    if (required && !selfieDone) waitingFor.push('selfie');
    return {
      required: true,
      open: !wallet && stage === 'needs_documents' && !submitted,
      documents,
      selfie: selfieDone ? 'done' : required ? 'needed' : 'not_used',
      submitted,
      submittedAt: submitted
        ? (onboarding?.submittedAt?.toISOString() ?? null)
        : null,
      waitingFor: submitted ? [] : waitingFor,
      maxBytes: NUVION_DOCUMENT_MAX_BYTES,
      acceptedTypes: [...NUVION_DOCUMENT_TYPES],
    };
  }

  private documentState(
    kind: NuvionDocumentKind,
    row:
      | { state: string; failure: string | null; uploadedAt: Date | null }
      | undefined,
    entity: ReviewRecord,
  ): DocumentStateView {
    if (!row) return 'missing';
    if (row.state === 'sending' || row.state === 'unknown') return 'confirming';
    if (row.state === 'failed') {
      return row.failure?.startsWith('refused') ? 'not_accepted' : 'missing';
    }
    if (this.needsNew(kind, row, entity)) return 'needs_new';
    return 'uploaded';
  }

  /** Nuvion's review said the document did not pass, after it was uploaded. */
  private needsNew(
    kind: NuvionDocumentKind,
    row: { uploadedAt: Date | null },
    entity: ReviewRecord,
  ): boolean {
    const status =
      kind === 'identity' ? entity.documentStatus : entity.addressProofStatus;
    if (status === null || !NOT_PASSED.has(status.trim().toLowerCase())) {
      return false;
    }
    // Only a refusal that came after this upload is about this upload.
    return (
      row.uploadedAt !== null &&
      (entity.decidedAt === null || row.uploadedAt <= entity.decidedAt)
    );
  }

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------

  /**
   * Sends one document to Nuvion, once. Resolves with nothing: the caller
   * answers the documents view afterwards. Every refusal is a DocumentError
   * or a MoneyError with a `reason.code`.
   */
  async upload(wawuUserId: string, input: FlowUpload): Promise<void> {
    const entity = await this.requireEntity(wawuUserId);
    const fingerprint = fingerprintOf(input.front, input.back);
    const row = await this.prisma.nuvionDocument.findUnique({
      where: { wawuUserId_kind: { wawuUserId, kind: input.kind } },
    });

    // The same file again (a double tap, or a retry after a lost answer)
    // is the answer it already got, whatever the opening says now: while
    // that answer stands, or is still being waited for. Past the wait, an
    // answer that never came is looked for at Nuvion first (below).
    const now = await this.dbNow();
    if (row?.fingerprint === fingerprint && row.entityId === entity.entityId) {
      const ageMs = now.getTime() - row.attemptStartedAt.getTime();
      if (
        row.state === 'uploaded' ||
        (row.state === 'sending' && ageMs < this.inFlightMs) ||
        (row.state === 'unknown' && ageMs < this.resendAfterMs)
      ) {
        return;
      }
    }
    if (
      (await this.hasWallet(wawuUserId)) ||
      reviewStageOf(entity) !== 'needs_documents'
    ) {
      throw new DocumentError('documents_closed', MSG.closed);
    }
    const onboarding = await this.prisma.nuvionOnboarding.findUnique({
      where: { wawuUserId },
    });
    if (this.submissionCurrent(onboarding, entity)) {
      throw new DocumentError('documents_closed', MSG.closed);
    }

    const personId = await this.personIdOf(wawuUserId, entity);
    const attempt = await this.claim(
      wawuUserId,
      entity.entityId,
      input,
      fingerprint,
      row,
      now,
    );
    if (attempt === null) return; // an earlier upload was found at Nuvion and is the same file

    let receipt;
    try {
      receipt = await this.area.uploadDocument({
        entityId: entity.entityId,
        personId,
        kind: input.kind,
        front: input.front,
        back: input.back,
        mimeType: input.mimeType,
      });
    } catch (e) {
      await this.afterFailedUpload(wawuUserId, input.kind, attempt, e);
      throw this.refusalOf(e);
    }
    const doneAt = await this.dbNow();
    try {
      await this.prisma.nuvionDocument.updateMany({
        where: {
          wawuUserId,
          kind: input.kind,
          attempts: attempt,
          state: 'sending',
        },
        data: {
          state: 'uploaded',
          nuvionDocumentId: receipt.documentId,
          knownDocumentIds: { push: receipt.documentId },
          uploadedAt: doneAt,
          failure: null,
        },
      });
    } catch (e) {
      // Nuvion has the file but its id could not be written (a document id
      // another row holds, or the database): the row stays `sending`, and
      // goes `unknown`, to be found on the entity's own list.
      this.logger.error(
        'documents: Nuvion took a file but its id could not be recorded; looked for later',
      );
      await this.prisma.nuvionDocument.updateMany({
        where: {
          wawuUserId,
          kind: input.kind,
          attempts: attempt,
          state: 'sending',
        },
        data: { state: 'unknown' },
      });
      throw e;
    }
    // A changed document is a reason to try the submission again at once.
    await this.prisma.nuvionOnboarding.updateMany({
      where: { wawuUserId },
      data: { submitRefusedAt: null },
    });
    await this.advance(wawuUserId).catch((e: unknown) => {
      this.logger.warn(
        `documents: the submission could not be advanced (${kindOfError(e)})`,
      );
    });
  }

  /** The entity's person id (documents are linked to it), read from Nuvion once if unknown. */
  private async personIdOf(
    wawuUserId: string,
    entity: FlowEntity & { entityId: string },
  ): Promise<string> {
    if (entity.personId) return entity.personId;
    let read;
    try {
      read = await this.area.readDocuments(entity.entityId);
    } catch (e) {
      throw this.refusalOf(e);
    }
    if (!read.personId) {
      this.logger.error(
        'documents: the entity has no person at Nuvion; nothing sent',
      );
      throw new MoneyError('provider_unreachable', MSG.unreachable, {
        retryAfterSeconds: this.nuvion.timings.retryAfterSeconds,
      });
    }
    await this.prisma.nuvionEntity.updateMany({
      where: { wawuUserId, entityId: entity.entityId, personId: null },
      data: { personId: read.personId },
    });
    return read.personId;
  }

  /**
   * Takes the person's row for a new attempt, by a conditional update on the
   * attempt it was read with. Returns the attempt number, or null when an
   * earlier upload (found at Nuvion) is this same file. Throws
   * `document_in_progress` when another request or an unconfirmed upload
   * holds it.
   */
  private async claim(
    wawuUserId: string,
    entityId: string,
    input: FlowUpload,
    fingerprint: string,
    row: Awaited<
      ReturnType<PrismaService['nuvionDocument']['findUnique']>
    > | null,
    now: Date,
  ): Promise<number | null> {
    const fresh = {
      entityId,
      sides: input.back ? ['front', 'back'] : ['front'],
      fingerprint,
      attemptStartedAt: now,
      failure: null,
    };
    if (row === null) {
      try {
        await this.prisma.nuvionDocument.create({
          data: {
            wawuUserId,
            kind: input.kind,
            state: 'sending',
            attempts: 1,
            ...fresh,
          },
        });
        return 1;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        // Another request made the row first: the same file is its answer.
        const other = await this.prisma.nuvionDocument.findUnique({
          where: { wawuUserId_kind: { wawuUserId, kind: input.kind } },
        });
        if (other?.fingerprint === fingerprint) return null;
        throw this.inProgress(1000);
      }
    }

    let from = row.state;
    let current = row;
    const age = now.getTime() - row.attemptStartedAt.getTime();
    if (from === 'sending') {
      if (age < this.inFlightMs) throw this.inProgress(this.inFlightMs - age);
      from = 'unknown'; // the request that held it is gone
    }
    if (from === 'unknown') {
      if (age < this.resendAfterMs) {
        throw this.inProgress(this.resendAfterMs - age);
      }
      // Look at Nuvion before sending a thing: an earlier call whose
      // answer was lost may have made the document.
      const found = await this.findMade(row);
      if (found === 'unreadable') {
        throw new MoneyError('provider_unreachable', MSG.unreachable, {
          retryAfterSeconds: this.nuvion.timings.retryAfterSeconds,
        });
      }
      if (found !== null) {
        await this.prisma.nuvionDocument.updateMany({
          where: {
            wawuUserId,
            kind: input.kind,
            attempts: row.attempts,
            state: { in: ['sending', 'unknown'] },
          },
          data: {
            state: 'uploaded',
            nuvionDocumentId: found.id,
            knownDocumentIds: { push: found.id },
            uploadedAt: found.created ? new Date(found.created) : now,
            failure: null,
          },
        });
        if (row.fingerprint === fingerprint && row.entityId === entityId) {
          return null; // that lost call carried this same file
        }
        const adopted = await this.prisma.nuvionDocument.findUnique({
          where: { wawuUserId_kind: { wawuUserId, kind: input.kind } },
        });
        if (adopted === null) throw this.inProgress(1);
        current = adopted;
        from = 'uploaded';
      }
    }
    const next = current.attempts + 1;
    const taken = await this.prisma.nuvionDocument.updateMany({
      where: {
        wawuUserId,
        kind: input.kind,
        attempts: current.attempts,
        state: from === 'unknown' ? { in: ['sending', 'unknown'] } : from,
      },
      data: {
        state: 'sending',
        attempts: next,
        nuvionDocumentId: null,
        uploadedAt: null,
        ...fresh,
      },
    });
    if (taken.count !== 1) throw this.inProgress(1);
    return next;
  }

  /**
   * The document an earlier call whose answer was lost may have made: one of
   * this kind on Nuvion's own list for the entity, made since the attempt
   * began (less the clock skew) and not already recorded here. `'unreadable'`
   * when Nuvion cannot be read: nothing is then sent.
   */
  private async findMade(row: {
    kind: string;
    entityId: string;
    attemptStartedAt: Date;
    wawuUserId: string;
    knownDocumentIds: string[];
  }): Promise<{ id: string; created: number | null } | null | 'unreadable'> {
    let read;
    try {
      read = await this.area.readDocuments(row.entityId);
    } catch {
      return 'unreadable';
    }
    const since = row.attemptStartedAt.getTime() - CLOCK_SKEW_MS;
    const held = await this.prisma.nuvionDocument.findMany({
      where: {
        nuvionDocumentId: { in: read.documents.map((d) => d.id) },
        NOT: { wawuUserId: row.wawuUserId, kind: row.kind },
      },
      select: { nuvionDocumentId: true },
    });
    const taken = new Set<string | null>([
      ...held.map((h) => h.nuvionDocumentId),
      ...row.knownDocumentIds,
    ]);
    const made = read.documents
      .filter(
        (d) =>
          d.key === row.kind &&
          !taken.has(d.id) &&
          d.created !== null &&
          d.created >= since,
      )
      .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
    return made[0] ?? null;
  }

  /** What an upload that failed leaves behind: the row, in the state the failure proves. */
  private async afterFailedUpload(
    wawuUserId: string,
    kind: NuvionDocumentKind,
    attempt: number,
    e: unknown,
  ): Promise<void> {
    const where = { wawuUserId, kind, attempts: attempt, state: 'sending' };
    if (
      e instanceof WalletProviderError &&
      e.recordMayExist &&
      e.kind !== 'under_review'
    ) {
      // Sent, and no answer: looked for before it is sent again.
      await this.prisma.nuvionDocument.updateMany({
        where,
        data: { state: 'unknown' },
      });
      return;
    }
    await this.prisma.nuvionDocument.updateMany({
      where,
      data: {
        state: 'failed',
        fingerprint: null,
        failure: `${this.isRefusal(e) ? 'refused' : 'unavailable'}_${kindOfError(e)}`,
      },
    });
  }

  /** Nuvion read the request and said no: nothing was made. */
  private isRefusal(e: unknown): boolean {
    return (
      e instanceof WalletProviderError &&
      (REFUSAL_KINDS.includes(e.kind) || e.kind === 'under_review')
    );
  }

  /** A provider failure as the refusal this flow answers. */
  private refusalOf(e: unknown): Error {
    if (e instanceof DocumentError || e instanceof MoneyError) return e;
    if (!(e instanceof WalletProviderError)) return e as Error;
    if (e.kind === 'under_review') {
      return new MoneyError('identity_under_review', UNDER_REVIEW_MESSAGE);
    }
    if (e.recordMayExist) {
      return new MoneyError('provider_unreachable', MSG.unconfirmed, {
        retryAfterSeconds: e.retryAfterSeconds,
      });
    }
    if (REFUSAL_KINDS.includes(e.kind)) {
      return new DocumentError('document_not_accepted', MSG.notAccepted);
    }
    return new MoneyError('provider_unreachable', MSG.unreachable, {
      retryAfterSeconds: e.retryAfterSeconds,
    });
  }

  private inProgress(waitMs: number): DocumentError {
    return new DocumentError('document_in_progress', MSG.inProgress, {
      retryAfterSeconds: Math.min(
        300,
        Math.max(1, Math.ceil(Math.max(waitMs, 0) / 1000)),
      ),
    });
  }

  // -------------------------------------------------------------------------
  // The submission
  // -------------------------------------------------------------------------

  private selfieRequired(
    onboarding: { livenessRefusedAt: Date | null } | null,
  ): boolean {
    return this.area.hostedLiveness && !onboarding?.livenessRefusedAt;
  }

  private selfieDone(
    onboarding: {
      livenessState: string | null;
      livenessLinkedAt: Date | null;
    } | null,
  ): boolean {
    return (
      onboarding?.livenessState === 'passed' &&
      onboarding.livenessLinkedAt !== null
    );
  }

  /** The submission is current when it was made after the person's last correction. */
  private submissionCurrent(
    onboarding: { submittedAt: Date | null } | null,
    entity: { correctedAt: Date | null; status: string },
  ): boolean {
    if (!onboarding?.submittedAt) return false;
    return (
      entity.correctedAt === null || onboarding.submittedAt > entity.correctedAt
    );
  }

  /**
   * Sends the opening for review when it is ready and not sent yet, once.
   * Safe to call from anywhere, any number of times at once: the answer is
   * what the call did, and a call with nothing to do does nothing.
   *
   * - `closed`: the opening is not taking documents (sent, decided, stopped);
   * - `waiting`: a document, or the selfie, is still missing;
   * - `submitted`: Nuvion has it (now, or already);
   * - `pending`: a submission is out and its answer is not known yet; it is
   *   looked for before it is ever sent again.
   */
  async advance(
    wawuUserId: string,
  ): Promise<'closed' | 'waiting' | 'submitted' | 'pending'> {
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { wawuUserId },
      select: ENTITY_SELECT,
    });
    if (!entity?.entityId) return 'closed';
    if (reviewStageOf(entity) !== 'needs_documents') return 'closed';
    if (await this.hasWallet(wawuUserId)) return 'closed';
    const entityId = entity.entityId;

    let onboarding = await this.ensureOnboarding(wawuUserId, entityId);
    if (
      onboarding.submittedAt &&
      entity.correctedAt &&
      onboarding.submittedAt <= entity.correctedAt
    ) {
      // Corrected details start the review again: the old submission is
      // not the current one.
      await this.prisma.nuvionOnboarding.updateMany({
        where: { wawuUserId, submittedAt: onboarding.submittedAt },
        data: { submittedAt: null, submitRequestedAt: null },
      });
      onboarding = await this.ensureOnboarding(wawuUserId, entityId);
    }
    if (onboarding.submittedAt) return 'submitted';
    if (
      onboarding.submitRefusedAt &&
      Date.now() - onboarding.submitRefusedAt.getTime() <
        SUBMIT_REFUSED_BACKOFF_MS
    ) {
      return 'waiting';
    }

    const rows = await this.prisma.nuvionDocument.findMany({
      where: { wawuUserId, entityId },
    });
    for (const kind of NUVION_DOCUMENT_KINDS) {
      const row = rows.find((r) => r.kind === kind);
      if (
        !row ||
        row.state !== 'uploaded' ||
        this.needsNew(kind, row, entity)
      ) {
        return 'waiting';
      }
    }
    if (this.selfieRequired(onboarding) && !this.selfieDone(onboarding)) {
      return 'waiting';
    }

    // The claim, before anything is sent.
    const now = await this.dbNow();
    const lapsed = new Date(now.getTime() - this.resendAfterMs);
    const earlier = onboarding.submitRequestedAt;
    const claimed = await this.prisma.nuvionOnboarding.updateMany({
      where: {
        wawuUserId,
        submittedAt: null,
        OR: [
          { submitRequestedAt: null },
          { submitRequestedAt: { lt: lapsed } },
        ],
      },
      data: { submitRequestedAt: now, submitAttempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return 'pending';

    // An earlier request whose answer was lost may have landed: look first.
    if (earlier !== null) {
      let read;
      try {
        read = await this.area.readDocuments(entityId);
      } catch {
        return 'pending'; // the claim stands: nothing is sent blindly
      }
      if (read.status !== 'incomplete') {
        await this.markSubmitted(wawuUserId, read.status);
        return 'submitted';
      }
    }

    try {
      const sent = await this.area.submitOnboarding(entityId);
      if (sent.status === 'incomplete') {
        // Nuvion says it still lacks something: the claim stands until the
        // resend window has passed, so this does not loop.
        this.logger.warn(
          'documents: Nuvion kept the entity incomplete after the submission',
        );
        return 'pending';
      }
      await this.markSubmitted(wawuUserId, sent.status);
      return 'submitted';
    } catch (e) {
      if (nuvionTypeOf(e) === 'error_entity_status_not_incomplete') {
        // Already past `incomplete` at Nuvion: it has the submission.
        try {
          const read = await this.area.readDocuments(entityId);
          if (read.status !== 'incomplete') {
            await this.markSubmitted(wawuUserId, read.status);
            return 'submitted';
          }
        } catch {
          // The claim stands; looked for again after the window.
        }
        return 'pending';
      }
      if (e instanceof WalletProviderError && e.recordMayExist) {
        this.logger.warn(
          `documents: the submission's answer was lost (${e.kind}); looked for before any new one`,
        );
        return 'pending';
      }
      // Refused, nothing made: the claim goes so the next call may try.
      await this.prisma.nuvionOnboarding.updateMany({
        where: { wawuUserId, submittedAt: null, submitRequestedAt: now },
        data: { submitRequestedAt: earlier, submitRefusedAt: now },
      });
      this.logger.warn(
        `documents: the submission was refused (${kindOfError(e)})`,
      );
      throw this.refusalOf(e);
    }
  }

  private async ensureOnboarding(wawuUserId: string, entityId: string) {
    const found = await this.prisma.nuvionOnboarding.findUnique({
      where: { wawuUserId },
    });
    if (found && found.entityId === entityId) return found;
    if (found) {
      // A different entity than the one this row was made for: never mix
      // two entities' submissions.
      await this.prisma.nuvionOnboarding.update({
        where: { wawuUserId },
        data: {
          entityId,
          submitRequestedAt: null,
          submittedAt: null,
          livenessSessionId: null,
          livenessClaimedAt: null,
          livenessStartedAt: null,
          livenessLinkedAt: null,
          livenessState: null,
        },
      });
    } else {
      await this.prisma.nuvionOnboarding
        .create({ data: { wawuUserId, entityId } })
        .catch((e: unknown) => {
          if ((e as { code?: string }).code !== 'P2002') throw e;
        });
    }
    return this.prisma.nuvionOnboarding.findUniqueOrThrow({
      where: { wawuUserId },
    });
  }

  /**
   * Nuvion has the submission. Records when, and the review word it answered
   * (`pending` as a rule), on the person's entity row and opening, the same
   * way the entity handler records a review, so `GET /money/wallet` reads
   * `checking` at once. Only while the entity is still where this flow left
   * it: a decision a delivery recorded first is never overwritten.
   */
  async markSubmitted(wawuUserId: string, status: string): Promise<void> {
    const word = status.trim().toLowerCase();
    const now = await this.dbNow();
    await this.prisma.$transaction(async (tx) => {
      await tx.nuvionOnboarding.updateMany({
        where: { wawuUserId, submittedAt: null },
        data: { submittedAt: now },
      });
      const before = await tx.nuvionEntity.findUnique({
        where: { wawuUserId },
        select: ENTITY_SELECT,
      });
      if (!before || reviewStageOf(before) !== 'needs_documents') return;
      const moved = await tx.nuvionEntity.updateMany({
        where: { wawuUserId, status: before.status },
        data: {
          status: word,
          rejectionReasons: [],
          reviewReadAt: now,
          ...(isDecision(word) ? { decidedAt: now } : {}),
        },
      });
      if (moved.count !== 1) return;
      const after = await tx.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId },
        select: ENTITY_SELECT,
      });
      await tx.fintavaWalletOpening.updateMany({
        where: {
          wawuUserId,
          provider: 'nuvion',
          state: { in: [...REVIEW_OPENING_STATES, 'unknown'] },
        },
        data: {
          state: openingStateForStage(reviewStageOf(after)),
          failure: null,
        },
      });
    });
    this.logger.log('documents: the opening was sent for review');
  }

  // -------------------------------------------------------------------------
  // The entity moved (Nuvion's `entities.updated`, NUV-03's handler)
  // -------------------------------------------------------------------------

  /**
   * Heals what a lost answer left: a submission Nuvion has (the entity is
   * past `incomplete`), an upload it took, then advances the opening. Safe
   * to run for any entity delivery, any number of times.
   */
  async reconcile(wawuUserId: string, entityStatus: string): Promise<string> {
    const onboarding = await this.prisma.nuvionOnboarding.findUnique({
      where: { wawuUserId },
    });
    if (
      onboarding &&
      !onboarding.submittedAt &&
      onboarding.submitRequestedAt &&
      entityStatus.trim().toLowerCase() !== 'incomplete'
    ) {
      await this.markSubmitted(wawuUserId, entityStatus);
    }
    const lost = await this.prisma.nuvionDocument.findMany({
      where: { wawuUserId, state: { in: ['sending', 'unknown'] } },
    });
    for (const row of lost) {
      if (Date.now() - row.attemptStartedAt.getTime() < this.inFlightMs) {
        continue;
      }
      const found = await this.findMade(row);
      if (found === 'unreadable' || found === null) continue;
      await this.prisma.nuvionDocument.updateMany({
        where: {
          wawuUserId,
          kind: row.kind,
          attempts: row.attempts,
          state: { in: ['sending', 'unknown'] },
        },
        data: {
          state: 'uploaded',
          nuvionDocumentId: found.id,
          knownDocumentIds: { push: found.id },
          uploadedAt: found.created ? new Date(found.created) : new Date(),
          failure: null,
        },
      });
    }
    return this.advance(wawuUserId);
  }

  // -------------------------------------------------------------------------
  // The hosted selfie
  // -------------------------------------------------------------------------

  async livenessView(wawuUserId: string): Promise<IdentityLivenessView> {
    const entity = await this.requireEntity(wawuUserId);
    let onboarding = await this.prisma.nuvionOnboarding.findUnique({
      where: { wawuUserId },
    });
    const enabled = this.selfieRequired(onboarding);
    if (!onboarding?.livenessSessionId) {
      return this.livenessOut(enabled, null, onboarding, entity, null);
    }
    let url: string | null = null;
    let state = onboarding.livenessState;
    if (this.area.hostedLiveness && state !== 'passed') {
      try {
        const check = await this.area.readLiveness(
          onboarding.livenessSessionId,
          entity.entityId,
        );
        state = check.state;
        url = check.state === 'pending' ? check.captureUrl : null;
        const now = await this.dbNow();
        await this.prisma.nuvionOnboarding.updateMany({
          where: {
            wawuUserId,
            livenessSessionId: onboarding.livenessSessionId,
          },
          data: { livenessState: check.state, livenessCheckedAt: now },
        });
      } catch (e) {
        // Not readable now: what was stored stands, and is shown as such.
        this.logger.warn(
          `documents: the selfie result could not be read (${kindOfError(e)})`,
        );
      }
    }
    if (state === 'passed') {
      onboarding = await this.linkLiveness(wawuUserId, entity.entityId);
      await this.advance(wawuUserId).catch((e: unknown) => {
        this.logger.warn(
          `documents: the submission could not be advanced (${kindOfError(e)})`,
        );
      });
    }
    const fresh = await this.prisma.nuvionOnboarding.findUnique({
      where: { wawuUserId },
    });
    return this.livenessOut(enabled, state, fresh ?? onboarding, entity, url);
  }

  private livenessOut(
    enabled: boolean,
    state: string | null,
    onboarding: {
      livenessStartedAt: Date | null;
      livenessSessionId: string | null;
      livenessState: string | null;
      livenessLinkedAt: Date | null;
    } | null,
    entity: ReviewRecord,
    url: string | null,
  ): IdentityLivenessView {
    const startedAt = onboarding?.livenessStartedAt ?? null;
    const done = onboarding?.livenessState === 'passed' || state === 'passed';
    let view: LivenessStateView;
    if (done) view = 'passed';
    else if (!enabled) view = 'not_in_use';
    else if (!onboarding?.livenessSessionId) view = 'not_started';
    else if (state === 'not_passed') view = 'not_passed';
    else if (
      startedAt !== null &&
      Date.now() - startedAt.getTime() > NUVION_LIVENESS_SESSION_MS
    ) {
      view = 'expired';
    } else view = 'pending';
    const open = reviewStageOf(entity) === 'needs_documents';
    return {
      enabled: enabled || done,
      state: view,
      url: view === 'pending' ? url : null,
      startedAt:
        view === 'not_started' || view === 'not_in_use'
          ? null
          : (startedAt?.toISOString() ?? null),
      canStart:
        enabled &&
        open &&
        (view === 'not_started' || view === 'not_passed' || view === 'expired'),
    };
  }

  /** Saves the passed session on the entity once; the row after. */
  private async linkLiveness(wawuUserId: string, entityId: string) {
    const row = await this.prisma.nuvionOnboarding.findUniqueOrThrow({
      where: { wawuUserId },
    });
    if (row.livenessLinkedAt || !row.livenessSessionId) return row;
    try {
      await this.area.linkLiveness(entityId, row.livenessSessionId);
    } catch (e) {
      this.logger.warn(
        `documents: the selfie could not be saved on the entity (${kindOfError(e)})`,
      );
      return row;
    }
    const now = await this.dbNow();
    await this.prisma.nuvionOnboarding.updateMany({
      where: {
        wawuUserId,
        livenessSessionId: row.livenessSessionId,
        livenessLinkedAt: null,
      },
      data: { livenessLinkedAt: now },
    });
    return this.prisma.nuvionOnboarding.findUniqueOrThrow({
      where: { wawuUserId },
    });
  }

  /**
   * Starts the hosted selfie, or answers the one already running. When
   * Nuvion will not start one for this person, the opening goes on without
   * a selfie (R-39): the refusal is recorded, the submission advanced, and
   * the answer is `selfie_not_available`.
   */
  async startLiveness(
    wawuUserId: string,
    redirectUrl: string | null,
  ): Promise<IdentityLivenessView> {
    const entity = await this.requireEntity(wawuUserId);
    if (
      (await this.hasWallet(wawuUserId)) ||
      reviewStageOf(entity) !== 'needs_documents'
    ) {
      throw new DocumentError('documents_closed', MSG.closed);
    }
    const onboarding = await this.ensureOnboarding(wawuUserId, entity.entityId);
    if (!this.selfieRequired(onboarding)) {
      throw new DocumentError('selfie_not_available', MSG.selfieOff);
    }
    if (this.submissionCurrent(onboarding, entity)) {
      throw new DocumentError('documents_closed', MSG.closed);
    }
    // One running session is the answer, not a second one.
    if (onboarding.livenessSessionId) {
      const current = await this.livenessView(wawuUserId);
      if (
        current.state === 'pending' ||
        current.state === 'passed' ||
        !current.canStart
      ) {
        return current;
      }
    }

    const now = await this.dbNow();
    const claimed = await this.prisma.nuvionOnboarding.updateMany({
      where: {
        wawuUserId,
        livenessSessionId: onboarding.livenessSessionId,
        OR: [
          { livenessClaimedAt: null },
          {
            livenessClaimedAt: {
              lt: new Date(now.getTime() - LIVENESS_CLAIM_MS),
            },
          },
        ],
      },
      data: { livenessClaimedAt: now },
    });
    if (claimed.count !== 1) throw this.inProgress(LIVENESS_CLAIM_MS);

    const restore = () =>
      this.prisma.nuvionOnboarding.updateMany({
        where: { wawuUserId, livenessClaimedAt: now },
        data: { livenessClaimedAt: null },
      });
    let started;
    try {
      started = await this.area.startLiveness(entity.entityId, redirectUrl);
    } catch (e) {
      await restore();
      if (e instanceof WalletProviderError && e.recordMayExist) {
        throw new MoneyError('provider_unreachable', MSG.unreachable, {
          retryAfterSeconds: e.retryAfterSeconds,
        });
      }
      if (
        e instanceof WalletProviderError &&
        (REFUSAL_KINDS.includes(e.kind) ||
          e.kind === 'auth' ||
          e.kind === 'not_supported')
      ) {
        // Nuvion will not start one for this person: no selfie (R-39).
        this.area.noteLivenessRefused();
        await this.prisma.nuvionOnboarding.updateMany({
          where: { wawuUserId },
          data: { livenessRefusedAt: now },
        });
        this.logger.warn(
          `documents: Nuvion would not start a hosted selfie (${e.kind}); the opening goes on without one`,
        );
        await this.advance(wawuUserId).catch(() => undefined);
        throw new DocumentError('selfie_not_available', MSG.selfieRefused);
      }
      throw this.refusalOf(e);
    }
    await this.prisma.nuvionOnboarding.updateMany({
      where: { wawuUserId, livenessClaimedAt: now },
      data: {
        livenessClaimedAt: null,
        livenessSessionId: started.sessionId,
        livenessStartedAt: now,
        livenessLinkedAt: null,
        livenessState: 'pending',
        livenessCheckedAt: now,
        livenessSessions: { increment: 1 },
      },
    });
    await this.linkLiveness(wawuUserId, entity.entityId);
    const fresh = await this.prisma.nuvionOnboarding.findUniqueOrThrow({
      where: { wawuUserId },
    });
    return this.livenessOut(true, 'pending', fresh, entity, started.url);
  }
}

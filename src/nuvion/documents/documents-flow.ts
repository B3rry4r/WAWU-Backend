import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { NO_WALLET_MESSAGE } from '../../money/gate/wallet-gate';
import type { IdentityHasher } from '../../money/identity/identity-config';
import { MoneyError } from '../../money/money-error';
import { EXPIRED_STATE } from '../../money/opening/bvn-claim';
import { noteDocumentRefusals } from '../../money/opening/document-refusals';
import { recordOpeningProgress } from '../../money/opening/identity-hold';
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
import {
  livenessRefusalOf,
  NUVION_LIVENESS_SESSION_MS,
} from '../areas/liveness';
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
/**
 * A call's own time beyond Nuvion's money timeout (serialising 20 MB, the
 * database), and how long past it a call whose answer was lost is still
 * waited for before Nuvion's own list is read to find out. Unlike a payment
 * (NUV-02, NUV-05: the money timeout plus ten minutes), a document or a
 * submission sent a second time costs nothing: Nuvion holds one more
 * document, or refuses the second submission as "not incomplete" (and that
 * refusal is read as "it has it"). So the wait is the call's own time and no
 * more; the list is still read BEFORE anything is sent again.
 * Default (agent), owner may override.
 */
const LOST_ANSWER_MARGIN_MS = 15_000;
/** A session just claimed is not claimed again for this long. */
const LIVENESS_CLAIM_MS = 60_000;
/** A submission Nuvion refused is not sent again for this long (a changed document lifts it). */
const SUBMIT_REFUSED_BACKOFF_MS = 60_000;
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

/**
 * The fingerprint of what one upload sends, to spot the same file sent
 * twice: an HMAC under IDENTITY_HASH_KEY (as the BVN's hash is), never a
 * bare hash a reader of the table could test a file against. The two sides
 * are length-labelled, so a front and a back cannot be moved to make
 * another pair with the same fingerprint.
 */
export function fingerprintOf(
  hasher: IdentityHasher,
  front: Buffer,
  back: Buffer | null,
): string {
  return hasher.hashBytes('document', [
    `front:${front.length}:`,
    front,
    back === null ? 'back:none' : `back:${back.length}:`,
    ...(back === null ? [] : [back]),
  ]);
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
 *   sides sent, the state, Nuvion's document id, the time, whether Nuvion's
 *   review refused it, and an HMAC fingerprint of the bytes (to forward the
 *   same file once; cleared once the opening is submitted). Never the file,
 *   a copy, a name, or a number read off it.
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
 * - a document Nuvion's review refused is never sent again unchanged: the
 *   refusal is kept on the document's own row, through any correction of
 *   the person's details (Nuvion may answer a correction with the check
 *   back at pending), and only a new upload of that kind clears it and lets
 *   the opening be submitted again.
 * - the hosted selfie, when in use, must have passed and be saved on the
 *   entity before the submission. It is the server's one switch: only an
 *   answer that says Nuvion's API is not available to us turns it off, for
 *   everyone (R-39). A refusal about one person's request or entity is that
 *   person's, and the step stays required of them.
 *
 * A disagreement between Nuvion and our record is never fixed silently:
 * an entity id another row already names, or a document id another row
 * holds, stops the flow for that person (logged without any number).
 */
export class DocumentsFlow {
  private readonly logger = new Logger('NuvionDocuments');

  /**
   * `hasher` finds the server's IdentityHasher, needed to upload (the
   * fingerprint is keyed); the handler, which only reconciles, runs without it.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly nuvion: NuvionWalletProvider,
    private readonly hasher: () => IdentityHasher | null = () => null,
  ) {}

  /** The upload's fingerprint, or a plain refusal when the key is not there. */
  private fingerprint(front: Buffer, back: Buffer | null): string {
    const hasher = this.hasher();
    if (hasher === null || !hasher.configured) {
      this.logger.error(
        'documents: IDENTITY_HASH_KEY is not set; no upload can be taken',
      );
      throw new MoneyError('provider_unreachable', MSG.unreachable, {
        retryAfterSeconds: this.nuvion.timings.retryAfterSeconds,
      });
    }
    return fingerprintOf(hasher, front, back);
  }

  private get area() {
    return this.nuvion.documents;
  }

  /** The https origins the selfie page may return to; empty means any https address. */
  get livenessRedirectOrigins(): readonly string[] {
    return this.area.livenessRedirectOrigins;
  }

  /** How long a call may still be running, and a lost answer is waited for. */
  private get inFlightMs(): number {
    return this.nuvion.timings.moneyTimeoutMs + LOST_ANSWER_MARGIN_MS;
  }

  private get resendAfterMs(): number {
    return this.inFlightMs;
  }

  /**
   * The person did something on their opening (a document sent, the selfie
   * started or passed): NUV-02's expiry sweep and support see it as progress,
   * so an opening that is being worked on is not closed for being idle
   * (NUV-02 G-497, round 4 N17). A failure to write it never fails the step.
   */
  private async progressed(wawuUserId: string): Promise<void> {
    try {
      await recordOpeningProgress(this.prisma, wawuUserId, {
        now: await this.dbNow(),
      });
    } catch (e) {
      this.logger.warn(
        `documents: progress could not be recorded (${kindOfError(e)})`,
      );
    }
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

  /**
   * The opening was closed by the sweep (idle too long, or its hold ran out)
   * and the person has not started again: the wallet view says so, and this
   * flow takes no document, starts no selfie and sends nothing to Nuvion
   * until they do (round 4, R4-1). Starting again corrects the entity and
   * moves the opening back to `review`.
   */
  private expired(wawuUserId: string): Promise<boolean> {
    return this.prisma.fintavaWalletOpening
      .findUnique({ where: { wawuUserId }, select: { state: true } })
      .then((r) => r?.state === EXPIRED_STATE);
  }

  /** Both documents, what is still needed, and whether uploads are open. */
  async view(wawuUserId: string): Promise<IdentityDocumentsView> {
    await this.requireEntity(wawuUserId);
    // What a lost answer left is looked for at Nuvion once its window has
    // passed (D3): an upload it took is recorded, one it never got reads
    // `send_again`. A refusal of a document is put on the document's row.
    await this.settleLost(wawuUserId).catch((e: unknown) => {
      this.logger.warn(
        `documents: a lost upload could not be looked for (${kindOfError(e)})`,
      );
    });
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
    const [entity, rows, onboarding, wallet, expired] = await Promise.all([
      this.prisma.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId },
        select: ENTITY_SELECT,
      }),
      this.prisma.nuvionDocument.findMany({ where: { wawuUserId, entityId } }),
      this.prisma.nuvionOnboarding.findUnique({ where: { wawuUserId } }),
      this.hasWallet(wawuUserId),
      this.expired(wawuUserId),
    ]);
    const stage = reviewStageOf(entity);
    const now = await this.dbNow();
    const documents: IdentityDocumentView[] = NUVION_DOCUMENT_KINDS.map(
      (kind) => {
        const row = rows.find((r) => r.kind === kind);
        const state = this.documentState(row, now);
        return {
          kind,
          state,
          sides:
            row && row.state !== 'failed' && state !== 'send_again'
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
    const required = this.selfieRequired();
    const selfieDone = this.selfieDone(onboarding);
    const submitted = this.submissionCurrent(onboarding, entity);
    const waitingFor: DocumentStepView[] = [];
    for (const d of documents) {
      if (d.state !== 'uploaded') waitingFor.push(d.kind);
    }
    if (required && !selfieDone) waitingFor.push('selfie');
    return {
      required: true,
      open: !wallet && !expired && stage === 'needs_documents' && !submitted,
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

  /**
   * What the screens are told about one document.
   * - `confirming`: the call went out and its answer is not known yet;
   * - `send_again`: the window has passed and Nuvion's list (read when the
   *   view was asked for) did not show it, or could not be read: the file is
   *   not kept, so only the person can send it again, and the upload route
   *   asks Nuvion once more before it sends (D3);
   * - `needs_new`: Nuvion's review refused this upload (the row says so,
   *   whatever Nuvion's word for the document is now).
   */
  private documentState(
    row:
      | {
          state: string;
          failure: string | null;
          attemptStartedAt: Date;
          reviewRefusedAt: Date | null;
        }
      | undefined,
    now: Date,
  ): DocumentStateView {
    if (!row) return 'missing';
    if (row.state === 'sending' || row.state === 'unknown') {
      return now.getTime() - row.attemptStartedAt.getTime() < this.inFlightMs
        ? 'confirming'
        : 'send_again';
    }
    if (row.state === 'failed') {
      return row.failure?.startsWith('refused') ? 'not_accepted' : 'missing';
    }
    if (this.needsNew(row)) return 'needs_new';
    return 'uploaded';
  }

  /** Nuvion's review refused this upload (kept on the row, D1). */
  private needsNew(row: { reviewRefusedAt: Date | null }): boolean {
    return row.reviewRefusedAt !== null;
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
    // An expired opening takes nothing, a file Nuvion already has included
    // (round 4, R4-1): the person is told what the wallet view says.
    if (await this.expired(wawuUserId)) {
      throw new DocumentError('documents_closed', MSG.expired);
    }
    const fingerprint = this.fingerprint(input.front, input.back);
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
        // A document Nuvion's review refused is replaced even by the same
        // file (the refusal may have been about something it has fixed).
        (row.state === 'uploaded' && !this.needsNew(row)) ||
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
    // The person is sending a document: progress, whatever Nuvion answers.
    await this.progressed(wawuUserId);

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
    await this.progressed(wawuUserId);
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
      // A new upload of this kind ends Nuvion's refusal of the old one (D1).
      reviewRefusedAt: null,
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

  /**
   * The hosted selfie is a step of this opening for everyone or for no one:
   * the server's switch, and Nuvion saying its API is not there for us. It
   * is never off for one person because of what that person sent or because
   * Nuvion refused their entity (D2).
   */
  private selfieRequired(): boolean {
    return this.area.hostedLiveness;
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
   * Nuvion's word says it has the submission: the entity is in review
   * (`pending`) or already decided as approved. `incomplete` is "not sent";
   * `rejected`, `failed` and `suspended` are an earlier decision (an entity
   * Nuvion has not moved back to `incomplete` after the person corrected
   * it), not proof that this submission landed.
   */
  private landed(status: string): boolean {
    return !['incomplete', 'rejected', 'failed', 'suspended'].includes(
      status.trim().toLowerCase(),
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
    // Nuvion's refusal of a document goes on the document's row from the
    // words as they stand, before anything can overwrite them (D1): in
    // every stage, so a person at `rejected` already has it when they
    // correct their details.
    await noteDocumentRefusals(
      this.prisma,
      wawuUserId,
      entity,
      await this.dbNow(),
    );
    if (reviewStageOf(entity) !== 'needs_documents') return 'closed';
    if (await this.hasWallet(wawuUserId)) return 'closed';
    // An expired opening is never sent for review, whatever is in (round 4,
    // R4-1): the person starts again first, which corrects the entity.
    if (await this.expired(wawuUserId)) return 'closed';
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
      if (!row || row.state !== 'uploaded' || this.needsNew(row)) {
        return 'waiting';
      }
    }
    if (this.selfieRequired() && !this.selfieDone(onboarding)) {
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
      if (this.landed(read.status)) {
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
          if (this.landed(read.status)) {
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
      // The files are with Nuvion's review now: nothing compares a file with
      // a fingerprint any more, so none is kept. A later upload (a document
      // the review refused) makes its own.
      await tx.nuvionDocument.updateMany({
        where: { wawuUserId },
        data: { fingerprint: null },
      });
      const before = await tx.nuvionEntity.findUnique({
        where: { wawuUserId },
        select: ENTITY_SELECT,
      });
      if (!before || reviewStageOf(before) !== 'needs_documents') return;
      // The submit call is progress and a submission for review, so a
      // refusal read after it can be a new decision (NUV-02 round 3, N4;
      // G-497). Only while the entity is still where this flow left it.
      await recordOpeningProgress(tx, wawuUserId, { submitted: true, now });
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
      this.landed(entityStatus)
    ) {
      await this.markSubmitted(wawuUserId, entityStatus);
    }
    await this.settleLost(wawuUserId);
    return this.advance(wawuUserId);
  }

  /**
   * Uploads whose answer was lost and whose window has passed: Nuvion's own
   * list of the entity's documents says whether it took the file. One it
   * took is recorded (never sent again); one it never got stays as it is and
   * the view reads it `send_again` (D3). A list that cannot be read changes
   * nothing. Safe to run any number of times, from the documents view and
   * from a delivery.
   */
  async settleLost(wawuUserId: string): Promise<void> {
    const lost = await this.prisma.nuvionDocument.findMany({
      where: { wawuUserId, state: { in: ['sending', 'unknown'] } },
    });
    if (lost.length === 0) return;
    const now = await this.dbNow();
    for (const row of lost) {
      if (now.getTime() - row.attemptStartedAt.getTime() < this.inFlightMs) {
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
          uploadedAt: found.created ? new Date(found.created) : now,
          failure: null,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // The hosted selfie
  // -------------------------------------------------------------------------

  async livenessView(wawuUserId: string): Promise<IdentityLivenessView> {
    const entity = await this.requireEntity(wawuUserId);
    const expired = await this.expired(wawuUserId);
    let onboarding = await this.prisma.nuvionOnboarding.findUnique({
      where: { wawuUserId },
    });
    const enabled = this.selfieRequired();
    if (!onboarding?.livenessSessionId) {
      return this.livenessOut(enabled, null, onboarding, entity, null, expired);
    }
    const wasPassed = onboarding.livenessState === 'passed';
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
    if (state === 'passed' && !expired) {
      // The selfie came back passed: the person finished a step. (Nothing
      // is written to the entity or sent for an expired opening; the result
      // is kept, and the person starts again first, R4-1.)
      if (!wasPassed) await this.progressed(wawuUserId);
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
    return this.livenessOut(
      enabled,
      state,
      fresh ?? onboarding,
      entity,
      url,
      expired,
    );
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
    expired = false,
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
    const open = !expired && reviewStageOf(entity) === 'needs_documents';
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
   * Starts the hosted selfie, or answers the one already running. A refusal
   * is read by who it is about (D2, `livenessRefusalOf`): only Nuvion saying
   * its API is not available to us turns the selfie off, for everyone, and
   * then the opening goes on without it (R-39) and this answers
   * `selfie_not_available`; a return address Nuvion will not take is a
   * plain 400 to that person; anything else about the person's request or
   * entity is theirs to wait out or retry, and the step stays required.
   */
  async startLiveness(
    wawuUserId: string,
    redirectUrl: string | null,
  ): Promise<IdentityLivenessView> {
    const entity = await this.requireEntity(wawuUserId);
    if (await this.expired(wawuUserId)) {
      throw new DocumentError('documents_closed', MSG.expired);
    }
    if (
      (await this.hasWallet(wawuUserId)) ||
      reviewStageOf(entity) !== 'needs_documents'
    ) {
      throw new DocumentError('documents_closed', MSG.closed);
    }
    const onboarding = await this.ensureOnboarding(wawuUserId, entity.entityId);
    if (!this.selfieRequired()) {
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
      throw await this.afterRefusedStart(wawuUserId, e, redirectUrl !== null);
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
    await this.progressed(wawuUserId);
    await this.linkLiveness(wawuUserId, entity.entityId);
    const fresh = await this.prisma.nuvionOnboarding.findUniqueOrThrow({
      where: { wawuUserId },
    });
    return this.livenessOut(true, 'pending', fresh, entity, started.url);
  }

  /** What a refused or failed session start becomes: the error to throw. */
  private async afterRefusedStart(
    wawuUserId: string,
    e: unknown,
    sentReturnAddress: boolean,
  ): Promise<Error> {
    const verdict = livenessRefusalOf(e, sentReturnAddress);
    const kind = kindOfError(e);
    switch (verdict) {
      case 'other':
        return this.refusalOf(e);
      case 'lost':
        // A session may exist at Nuvion: the person tries again, and a
        // lost answer is never a reason to turn anything off.
        return new MoneyError('provider_unreachable', MSG.unreachable, {
          retryAfterSeconds: (e as WalletProviderError).retryAfterSeconds,
        });
      case 'api_unavailable': {
        // Nuvion says the API is not there for us at all: off for everyone
        // on this server, for an hour, and said loudly. Never a row of one
        // person: this person is not skipping anything, nobody has it.
        this.area.noteLivenessRefused();
        this.logger.error(
          `documents: Nuvion says the hosted selfie API is not available to this key (${nuvionTypeOf(e) ?? kind}); the selfie is OFF FOR EVERYONE on this server for an hour and openings go on without it`,
        );
        await this.advance(wawuUserId).catch(() => undefined);
        return new DocumentError('selfie_not_available', MSG.selfieRefused);
      }
      case 'already_off':
        await this.advance(wawuUserId).catch(() => undefined);
        return new DocumentError('selfie_not_available', MSG.selfieRefused);
      case 'return_address':
        return new DocumentError('document_request_invalid', MSG.badReturn);
      case 'this_person':
        this.logger.warn(
          `documents: Nuvion would not start a hosted selfie for one person (${nuvionTypeOf(e) ?? kind}); they try again, the step stays required of them`,
        );
        return new MoneyError('provider_unreachable', MSG.selfieUnreachable, {
          retryAfterSeconds: (e as WalletProviderError).retryAfterSeconds,
        });
    }
  }
}
